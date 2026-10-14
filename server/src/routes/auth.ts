import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { isUuid, type Db } from '../db/index.js';
import { actorFromUser, audit } from '../lib/audit.js';
import { hashPassword, requireRole, signToken, verifyPassword, verifyPasswordOrDummy } from '../lib/auth.js';
import { HttpError, notFound, parse } from '../lib/errors.js';
import { AttemptLimiter } from '../lib/ratelimit.js';

/** Shared password policy for setup, new users, resets and changes. */
export const Password = z.string().min(10, 'Use at least 10 characters').max(200);
const Email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((e) => e.toLowerCase());
const Name = z.string().trim().min(1).max(100);
const Role = z.enum(['admin', 'engineer', 'viewer']);

const publicUser = (u: any) => ({ id: u.id, email: u.email, name: u.name, role: u.role });

export function authRoutes(db: Db) {
  const r = Router();
  const limiter = new AttemptLimiter(config.loginMaxAttempts, config.loginWindowMinutes * 60_000);

  // ---- first-run setup: the first account becomes the owner (admin) -----------------------

  r.get('/auth/setup', async (_req, res) => {
    const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
    res.json({ needed: rows[0].n === 0 });
  });

  r.post('/auth/setup', async (req, res) => {
    const body = parse(z.object({ name: Name, email: Email, password: Password }), req.body);
    const now = Date.now();
    const user = await db.tx(async (q) => {
      // Serialise concurrent setup attempts; only the first one on an empty database succeeds.
      await q.query(`SELECT pg_advisory_xact_lock(hashtext('bisect:setup'))`);
      const { rows: existing } = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
      if (existing[0].n > 0) throw new HttpError(409, 'already_set_up', 'This workspace already has an owner — sign in instead');
      const { rows } = await q.query(
        `INSERT INTO users (email, name, role, password_hash, password_changed_at) VALUES ($1, $2, 'admin', $3, $4) RETURNING *`,
        [body.email, body.name, hashPassword(body.password), new Date(now).toISOString()],
      );
      await audit(q, { user: publicUser(rows[0]), label: body.email }, 'user.setup_owner', 'user', rows[0].id, null, null, publicUser(rows[0]));
      return rows[0];
    });
    res.status(201).json({ token: signToken(user.id, now), user: publicUser(user) });
  });

  // ---- sign in -------------------------------------------------------------------------------

  r.post('/auth/login', async (req, res) => {
    const { email, password } = parse(z.object({ email: Email, password: z.string().min(1).max(200) }), req.body);
    const key = `${req.ip}|${email}`;
    const wait = limiter.blockedFor(key);
    if (wait > 0) {
      res.set('Retry-After', String(Math.ceil(wait / 1000)));
      throw new HttpError(429, 'too_many_attempts', 'Too many failed sign-in attempts — try again later');
    }
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!verifyPasswordOrDummy(password, user?.password_hash)) {
      limiter.fail(key);
      throw new HttpError(401, 'invalid_credentials', 'Email or password is incorrect');
    }
    limiter.reset(key);
    res.json({ token: signToken(user.id), user: publicUser(user) });
  });

  r.get('/auth/me', requireRole('viewer'), (req, res) => {
    res.json({ user: req.user });
  });

  /** Change my own password. Signs out every other session; returns a fresh token for this one. */
  r.post('/auth/password', requireRole('viewer'), async (req, res) => {
    const body = parse(z.object({ current_password: z.string().min(1).max(200), new_password: Password }), req.body);
    const now = Date.now();
    await db.tx(async (q) => {
      const { rows } = await q.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user!.id]);
      if (!rows[0] || !verifyPassword(body.current_password, rows[0].password_hash)) {
        throw new HttpError(403, 'wrong_password', 'Current password is incorrect');
      }
      await q.query('UPDATE users SET password_hash = $2, password_changed_at = $3 WHERE id = $1', [
        req.user!.id,
        hashPassword(body.new_password),
        new Date(now).toISOString(),
      ]);
      await audit(q, actorFromUser(req.user), 'user.password_change', 'user', req.user!.id, null);
    });
    res.json({ token: signToken(req.user!.id, now) });
  });

  // ---- user management (admin) ---------------------------------------------------------------

  r.get('/users', requireRole('viewer'), async (_req, res) => {
    const { rows } = await db.query('SELECT id, email, name, role, created_at FROM users ORDER BY name');
    res.json({ users: rows });
  });

  r.post('/users', requireRole('admin'), async (req, res) => {
    const body = parse(z.object({ email: Email, name: Name, role: Role, password: Password }), req.body);
    const user = await db.tx(async (q) => {
      const { rows: exists } = await q.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
      if (exists[0]) throw new HttpError(409, 'email_taken', 'A user with that email already exists');
      // password_changed_at comes from the app clock, like token iat, so DB/app clock skew cannot
      // make the new user's first session look older than their password.
      const { rows } = await q.query(
        `INSERT INTO users (email, name, role, password_hash, password_changed_at) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, name, role, created_at`,
        [body.email, body.name, body.role, hashPassword(body.password), new Date().toISOString()],
      );
      await audit(q, actorFromUser(req.user), 'user.create', 'user', rows[0].id, null, null, rows[0]);
      return rows[0];
    });
    res.status(201).json({ user });
  });

  /** Change name / role, or set a new password (which signs that user out everywhere). */
  r.patch('/users/:id', requireRole('admin'), async (req, res) => {
    const body = parse(z.object({ role: Role, name: Name, password: Password }).partial().strict(), req.body);
    if (!isUuid(req.params.id)) throw notFound('User');
    const user = await db.tx(async (q) => {
      const { rows: before } = await q.query('SELECT id, email, name, role FROM users WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!before[0]) throw notFound('User');
      if (body.role && body.role !== 'admin' && before[0].role === 'admin') {
        const { rows } = await q.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`);
        if (rows[0].n <= 1) throw new HttpError(422, 'last_admin', 'Cannot demote the last admin');
      }
      const { rows } = await q.query(
        `UPDATE users SET role = COALESCE($2, role), name = COALESCE($3, name),
                password_hash = COALESCE($4, password_hash),
                password_changed_at = CASE WHEN $4::text IS NULL THEN password_changed_at ELSE $5::timestamptz END
         WHERE id = $1 RETURNING id, email, name, role`,
        [req.params.id, body.role ?? null, body.name ?? null, body.password ? hashPassword(body.password) : null, new Date().toISOString()],
      );
      await audit(q, actorFromUser(req.user), body.password ? 'user.password_reset' : 'user.update', 'user', rows[0].id, null, before[0], rows[0]);
      return rows[0];
    });
    res.json({ user });
  });

  return r;
}
