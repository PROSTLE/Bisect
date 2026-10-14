import { createDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrations.js';
import type { Actor } from '../src/lib/audit.js';
import { hashPassword } from '../src/lib/auth.js';
import { ingestEvents, type IngestContext } from '../src/services/ingest.js';

export async function setupDb(): Promise<Db> {
  const db = await createDb('memory');
  await migrate(db);
  return db;
}

let n = 0;
export async function makeUser(db: Db, role: 'admin' | 'engineer' | 'viewer' = 'engineer', password = 'test-password-1') {
  n++;
  const { rows } = await db.query(
    `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, email, name, role`,
    [`user${n}-${role}@test.dev`, `User ${n}`, role, hashPassword(password)],
  );
  return rows[0];
}

export async function makeProject(db: Db, name = `Project ${++n}`) {
  const { rows } = await db.query(
    `INSERT INTO projects (name, slug, ingest_token, webhook_secret) VALUES ($1, $2, 'ing_test_token', 'whsec_test') RETURNING *`,
    [name, `p-${n}-${Date.now()}`],
  );
  return rows[0];
}

export const system: Actor = { user: null, label: 'test' };

export function ingester(db: Db, projectId: string, extra: Partial<IngestContext> = {}) {
  return async (events: Record<string, unknown>[], receivedAt?: Date) =>
    ingestEvents(db, { projectId, source: 'api', actor: system, receivedAt, ...extra }, events);
}

export const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
