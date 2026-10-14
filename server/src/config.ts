import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number`);
  return n;
}

export const config = {
  port: num('PORT', 4000),
  /**
   * postgres://… → real PostgreSQL.
   * Unset (or "pglite") → embedded PGlite (Postgres compiled to WASM) stored in PGLITE_DIR,
   * so the app runs with zero infrastructure for local development and tests.
   */
  databaseUrl: process.env.DATABASE_URL ?? '',
  pgliteDir: process.env.PGLITE_DIR ?? path.resolve(here, '../.data/pglite'),
  authSecret: process.env.AUTH_SECRET ?? 'dev-only-insecure-secret-change-me',
  tokenTtlHours: num('TOKEN_TTL_HOURS', 24 * 7),
  /** An event whose received_at − occurred_at exceeds this is flagged as "late". */
  lateThresholdMinutes: num('LATE_THRESHOLD_MINUTES', 5),
  /** How far back before an incident we look for suspect deployments. */
  suspectWindowHours: num('SUSPECT_WINDOW_HOURS', 72),
  /**
   * Express "trust proxy": leave unset when the app faces the internet directly; set to the number of
   * proxy hops (e.g. 1) or "true" behind a load balancer so req.ip / req.protocol are the client's.
   */
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  /** Failed sign-ins allowed per (IP, email) in the window below before answering 429. */
  loginMaxAttempts: num('LOGIN_MAX_ATTEMPTS', 10),
  loginWindowMinutes: num('LOGIN_WINDOW_MINUTES', 15),
  webDist: process.env.WEB_DIST ?? path.resolve(here, '../../web/dist'),
  publicUrl: process.env.PUBLIC_URL ?? '',
};

function parseTrustProxy(v: string | undefined): boolean | number {
  if (!v || v === 'false') return false;
  if (v === 'true') return true;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error('TRUST_PROXY must be "true", "false" or a hop count');
  return n;
}

/** Problems that make it unsafe to serve real users; index.ts refuses to start in production if any exist. */
export function productionProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];
  const secret = env.AUTH_SECRET ?? '';
  if (!secret) problems.push('AUTH_SECRET is not set');
  else if (secret.length < 32) problems.push('AUTH_SECRET must be at least 32 characters');
  return problems;
}
