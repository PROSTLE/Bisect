import fs from 'node:fs';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

/** Minimal query surface shared by a pool, a transaction and PGlite. */
export interface Queryable {
  query<T = any>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  kind: 'postgres' | 'pglite';
  /** Run a multi-statement SQL script (migrations). */
  exec(sql: string): Promise<void>;
  /** Run fn inside a transaction. Code inside must only use the provided Queryable. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// COUNT(*) and bigserial come back as int8 — we never exceed 2^53, so parse them as numbers.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

function createPostgresDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on('error', (err) => console.error('[db] idle client error', err));
  return {
    kind: 'postgres',
    query: (text, params) => pool.query(text, params as any[]) as any,
    async exec(sql) {
      await pool.query(sql);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (t, p) => client.query(t, p as any[]) as any });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

async function createPgliteDb(dataDir?: string): Promise<Db> {
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const lite = new PGlite(dataDir);
  await lite.waitReady;
  return {
    kind: 'pglite',
    query: (text, params) => lite.query(text, params as any[]) as any,
    async exec(sql) {
      await lite.exec(sql);
    },
    tx: (fn) => lite.transaction((t) => fn({ query: (text, params) => t.query(text, params as any[]) as any })),
    close: () => lite.close(),
  };
}

/**
 * url = postgres://…   → PostgreSQL pool
 * url = "memory"       → in-memory PGlite (tests)
 * url = "" / "pglite"  → PGlite persisted to `pgliteDir`
 */
export async function createDb(url: string, pgliteDir?: string): Promise<Db> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return createPostgresDb(url);
  if (url === 'memory') return createPgliteDb(undefined);
  return createPgliteDb(pgliteDir);
}

/** jsonb parameters are always sent as text and cast in SQL (`$n::text::jsonb`) — consistent across drivers. */
export const json = (v: unknown) => JSON.stringify(v ?? null);

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
