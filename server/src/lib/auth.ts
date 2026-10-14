import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { HttpError, forbidden } from './errors.js';

export type Role = 'admin' | 'engineer' | 'viewer';
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, engineer: 1, admin: 2 };

export function hasRole(user: AuthUser | undefined, min: Role): boolean {
  return !!user && ROLE_RANK[user.role] >= ROLE_RANK[min];
}

// ---- passwords (scrypt, no native deps) --------------------------------------------------

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// ---- tokens (HMAC-signed, JWT-like but dependency-free) ---------------------------------

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');
const sign = (data: string) => crypto.createHmac('sha256', config.authSecret).update(data).digest('base64url');

export function signToken(userId: string, now = Date.now()): string {
  const payload = b64url(JSON.stringify({ sub: userId, iat: now, exp: now + config.tokenTtlHours * 3600_000 }));
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string): { sub: string; iat: number } | null {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  if (!safeEqual(sig, sign(payload))) return null;
  try {
    const { sub, iat, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (typeof sub !== 'string' || typeof exp !== 'number' || exp < Date.now()) return null;
    return { sub, iat: typeof iat === 'number' ? iat : 0 };
  } catch {
    return null;
  }
}

/** Constant work for unknown emails so response time does not reveal which accounts exist. */
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
export function verifyPasswordOrDummy(password: string, stored: string | undefined): boolean {
  const ok = verifyPassword(password, stored ?? DUMMY_HASH);
  return !!stored && ok;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

// ---- middleware --------------------------------------------------------------------------

function extractToken(req: Request): string | undefined {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  // EventSource cannot set headers, so the SSE endpoint accepts ?token=
  if (typeof req.query.token === 'string') return req.query.token;
  return undefined;
}

/**
 * Attaches req.user when a valid token is present; never rejects. The user (and role) is re-read from
 * the DB each time, and tokens issued before the last password change are ignored.
 */
export function authenticate(db: Db) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = extractToken(req);
    const claims = token ? verifyToken(token) : null;
    if (claims) {
      const { rows } = await db.query<AuthUser & { password_changed_at: Date }>(
        'SELECT id, email, name, role, password_changed_at FROM users WHERE id = $1',
        [claims.sub],
      );
      const u = rows[0];
      if (u && claims.iat >= u.password_changed_at.getTime()) req.user = { id: u.id, email: u.email, name: u.name, role: u.role };
    }
    next();
  };
}

export function requireRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'unauthenticated', 'Sign in required'));
    if (!hasRole(req.user, min)) return next(forbidden(`Requires the ${min} role`));
    next();
  };
}
