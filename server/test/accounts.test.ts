import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { config, productionProblems } from '../src/config.js';
import type { Db } from '../src/db/index.js';
import { setupDb } from './helpers.js';

let db: Db;
let server: Server;
let base: string;
const OWNER_PASSWORD = 'a-long-enough-password';

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const pause = () => new Promise((r) => setTimeout(r, 5));

before(async () => {
  db = await setupDb(); // empty: no users at all
  server = createApp(db).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  server.closeAllConnections();
  server.close();
  await db.close();
});

describe('first-run setup', () => {
  let ownerToken: string;

  it('reports that setup is needed on an empty database', async () => {
    assert.deepEqual((await call('GET', '/api/auth/setup')).body, { needed: true });
  });

  it('rejects a weak owner password', async () => {
    const r = await call('POST', '/api/auth/setup', { body: { name: 'Owner', email: 'owner@co.dev', password: 'short' } });
    assert.equal(r.status, 400);
  });

  it('creates exactly one owner even when two setups race', async () => {
    const attempt = (email: string) => call('POST', '/api/auth/setup', { body: { name: 'Owner', email, password: OWNER_PASSWORD } });
    const results = await Promise.all([attempt('Owner@Co.dev'), attempt('other@co.dev')]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const winner = results.find((r) => r.status === 201)!;
    assert.equal(winner.body.user.role, 'admin');
    ownerToken = winner.body.token;
    const { rows } = await db.query('SELECT count(*)::int AS n FROM users');
    assert.equal(rows[0].n, 1);
  });

  it('closes setup once an owner exists, and the setup token works', async () => {
    assert.deepEqual((await call('GET', '/api/auth/setup')).body, { needed: false });
    const again = await call('POST', '/api/auth/setup', { body: { name: 'X', email: 'x@co.dev', password: OWNER_PASSWORD } });
    assert.equal(again.status, 409);
    const me = await call('GET', '/api/auth/me', { token: ownerToken });
    assert.equal(me.body.user.role, 'admin');
  });
});

describe('sign-in and passwords', () => {
  let ownerEmail: string;
  let admin: string;

  before(async () => {
    ownerEmail = (await db.query(`SELECT email FROM users WHERE role = 'admin' LIMIT 1`)).rows[0].email;
    admin = (await call('POST', '/api/auth/login', { body: { email: ownerEmail, password: OWNER_PASSWORD } })).body.token;
    const r = await call('POST', '/api/users', { token: admin, body: { name: 'Eng', email: 'Eng@Co.dev', role: 'engineer', password: 'engineer-password-1' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.email, 'eng@co.dev', 'emails are stored lowercase');
  });

  it('enforces the password policy for new users', async () => {
    const r = await call('POST', '/api/users', { token: admin, body: { name: 'Weak', email: 'weak@co.dev', role: 'viewer', password: '123456789' } });
    assert.equal(r.status, 400);
  });

  it('signs in case-insensitively and rate-limits repeated failures per email', async () => {
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'ENG@co.dev', password: 'engineer-password-1' } })).status, 200);
    for (let i = 0; i < config.loginMaxAttempts; i++) {
      assert.equal((await call('POST', '/api/auth/login', { body: { email: 'eng@co.dev', password: 'wrong' } })).status, 401);
    }
    const blocked = await call('POST', '/api/auth/login', { body: { email: 'eng@co.dev', password: 'engineer-password-1' } });
    assert.equal(blocked.status, 429, 'even the right password is refused while blocked');
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    const other = await call('POST', '/api/auth/login', { body: { email: 'nobody@co.dev', password: 'whatever' } });
    assert.equal(other.status, 401, 'a different email from the same client is not blocked');
  });

  it('changing my password signs out my other sessions', async () => {
    const sessionA = (await call('POST', '/api/auth/login', { body: { email: ownerEmail, password: OWNER_PASSWORD } })).body.token;
    await pause();
    const wrong = await call('POST', '/api/auth/password', { token: sessionA, body: { current_password: 'nope', new_password: 'a-brand-new-password' } });
    assert.equal(wrong.status, 403);
    const ok = await call('POST', '/api/auth/password', { token: sessionA, body: { current_password: OWNER_PASSWORD, new_password: 'a-brand-new-password' } });
    assert.equal(ok.status, 200);
    assert.equal((await call('GET', '/api/auth/me', { token: sessionA })).status, 401, 'this old session is revoked');
    assert.equal((await call('GET', '/api/auth/me', { token: admin })).status, 401, 'other old sessions are revoked');
    assert.equal((await call('GET', '/api/auth/me', { token: ok.body.token })).status, 200, 'the returned token works');
    assert.equal((await call('POST', '/api/auth/login', { body: { email: ownerEmail, password: OWNER_PASSWORD } })).status, 401, 'old password no longer works');
    admin = ok.body.token;
  });

  it('an admin password reset signs the user out and the new password works', async () => {
    // a fresh user (eng@co.dev is still rate-limited from the previous test)
    const created = await call('POST', '/api/users', { token: admin, body: { name: 'Ops', email: 'ops@co.dev', role: 'engineer', password: 'ops-password-123' } });
    const opsId = created.body.user.id;
    const opsSession = (await call('POST', '/api/auth/login', { body: { email: 'ops@co.dev', password: 'ops-password-123' } })).body.token;
    assert.equal((await call('GET', '/api/auth/me', { token: opsSession })).status, 200);
    await pause();
    const reset = await call('PATCH', `/api/users/${opsId}`, { token: admin, body: { password: 'reset-by-admin-1' } });
    assert.equal(reset.status, 200);
    assert.equal((await call('GET', '/api/auth/me', { token: opsSession })).status, 401, 'old session revoked');
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'ops@co.dev', password: 'reset-by-admin-1' } })).status, 200, 'new password works');
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'ops@co.dev', password: 'ops-password-123' } })).status, 401, 'old password fails');
    const { rows } = await db.query(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id DESC LIMIT 1`, [opsId]);
    assert.equal(rows[0].action, 'user.password_reset');
  });

  it('cannot demote the last admin', async () => {
    const me = (await call('GET', '/api/auth/me', { token: admin })).body.user;
    assert.equal((await call('PATCH', `/api/users/${me.id}`, { token: admin, body: { role: 'viewer' } })).status, 422);
  });
});

describe('production hardening', () => {
  it('sends security headers', async () => {
    const r = await call('GET', '/api/health');
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
  });

  it('refuses a missing or short AUTH_SECRET in production', () => {
    assert.deepEqual(productionProblems({}), ['AUTH_SECRET is not set']);
    assert.match(productionProblems({ AUTH_SECRET: 'short' })[0], /at least 32/);
    assert.deepEqual(productionProblems({ AUTH_SECRET: 'x'.repeat(32) }), []);
  });

  it('has no demo endpoint', async () => {
    assert.equal((await call('GET', '/api/auth/demo')).status, 404);
  });
});
