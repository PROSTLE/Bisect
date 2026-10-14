import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/index.js';
import { makeUser, setupDb } from './helpers.js';

let db: Db;
let server: Server;
let base: string;
const tokens: Record<string, string> = {};

async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

before(async () => {
  db = await setupDb();
  server = createApp(db).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const role of ['admin', 'engineer', 'viewer'] as const) {
    const u = await makeUser(db, role, 'correct-horse');
    const r = await call('POST', '/api/auth/login', { body: { email: u.email, password: 'correct-horse' } });
    assert.equal(r.status, 200);
    tokens[role] = r.body.token;
  }
});
after(async () => {
  server.closeAllConnections();
  server.close();
  await db.close();
});

describe('HTTP API', () => {
  let project: any;

  it('rejects bad credentials and unauthenticated access', async () => {
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'nobody@x.dev', password: 'nope' } })).status, 401);
    assert.equal((await call('GET', '/api/projects')).status, 401);
    assert.equal((await call('GET', '/api/projects', { token: 'forged.token' })).status, 401);
  });

  it('enforces roles', async () => {
    assert.equal((await call('POST', '/api/projects', { token: tokens.engineer, body: { name: 'Nope' } })).status, 403);
    const r = await call('POST', '/api/projects', { token: tokens.admin, body: { name: 'Payments API' } });
    assert.equal(r.status, 201);
    project = r.body.project;
    assert.equal(project.slug, 'payments-api');
    assert.ok(project.ingest_token, 'admins see secrets');
    const asViewer = await call('GET', `/api/projects/${project.id}`, { token: tokens.viewer });
    assert.equal(asViewer.body.project.ingest_token, undefined, 'viewers do not');
    assert.equal(
      (await call('POST', `/api/projects/${project.id}/incidents`, { token: tokens.viewer, body: { title: 'x', severity: 'sev3' } })).status,
      403,
    );
  });

  it('accepts CI events with the ingest token and reports per-event results', async () => {
    const r = await call('POST', `/api/projects/${project.id}/events`, {
      headers: { 'x-ingest-token': project.ingest_token },
      body: { events: [{ type: 'deployment', deployment_id: 'ci-1', status: 'success', version: 'v1' }, { type: 'bogus' }] },
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.summary, { created: 1, rejected: 1 });
    const bad = await call('POST', `/api/projects/${project.id}/events`, { headers: { 'x-ingest-token': 'wrong' }, body: { type: 'deployment' } });
    assert.equal(bad.status, 401);
  });

  it('runs an incident through create → conflicting edit → resolve', async () => {
    const created = await call('POST', `/api/projects/${project.id}/incidents`, {
      token: tokens.engineer,
      headers: { 'idempotency-key': crypto.randomUUID() },
      body: { title: 'Card payments failing', severity: 'sev2', service: 'api' },
    });
    assert.equal(created.status, 201);
    const id = created.body.entity_id;
    const { body: detail } = await call('GET', `/api/incidents/${id}`, { token: tokens.viewer });
    const v = detail.incident.version;

    assert.equal((await call('PATCH', `/api/incidents/${id}`, { token: tokens.engineer, body: { version: v, severity: 'sev1' } })).status, 200);
    const conflict = await call('PATCH', `/api/incidents/${id}`, { token: tokens.admin, body: { version: v, severity: 'sev3' } });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.details.conflicts[0].field, 'severity');

    const missingVersion = await call('PATCH', `/api/incidents/${id}`, { token: tokens.engineer, body: { severity: 'sev3' } });
    assert.equal(missingVersion.status, 400);

    const resolved = await call('PATCH', `/api/incidents/${id}`, {
      token: tokens.engineer,
      body: { version: v + 1, status: 'resolved', resolution: 'Rotated the expired API key' },
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.incident.status, 'resolved');

    const comment = await call('POST', `/api/incidents/${id}/comments`, { token: tokens.engineer, body: { body: 'Postmortem scheduled' } });
    assert.equal(comment.status, 201);

    const timeline = await call('GET', `/api/projects/${project.id}/timeline?incident_id=${id}`, { token: tokens.viewer });
    assert.ok(timeline.body.events.some((e: any) => e.action === 'incident.resolved'));
    const dash = await call('GET', `/api/projects/${project.id}/dashboard`, { token: tokens.viewer });
    assert.equal(dash.status, 200);
    assert.equal(dash.body.incidents.resolved, 1);
  });

  it('verifies GitHub webhook signatures', async () => {
    const payload = JSON.stringify({ ref: 'refs/heads/main', commits: [{ id: 'feedbeef1', message: 'hi', timestamp: new Date().toISOString(), added: [], modified: ['x'], removed: [] }] });
    const sig = `sha256=${crypto.createHmac('sha256', project.webhook_secret).update(payload).digest('hex')}`;
    const ok = await call('POST', `/api/webhooks/github/${project.id}`, { body: payload, headers: { 'x-github-event': 'push', 'x-hub-signature-256': sig } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.results[0].status, 'created');
    const forged = await call('POST', `/api/webhooks/github/${project.id}`, { body: payload, headers: { 'x-github-event': 'push', 'x-hub-signature-256': 'sha256=00' } });
    assert.equal(forged.status, 401);
  });

  it('returns 404 for malformed ids instead of a database error', async () => {
    assert.equal((await call('GET', '/api/incidents/not-a-uuid', { token: tokens.viewer })).status, 404);
    assert.equal((await call('GET', '/api/projects/123/dashboard', { token: tokens.viewer })).status, 404);
  });

  it('serves the war-room read models with validation and auth', async () => {
    const ov = await call('GET', `/api/projects/${project.id}/overview`, { token: tokens.viewer });
    assert.equal(ov.status, 200);
    assert.ok('focus' in ov.body && 'data_fresh_at' in ov.body && 'presence' in ov.body);
    const to = new Date();
    const from = new Date(to.getTime() - 6 * 3600_000);
    const lanes = await call('GET', `/api/projects/${project.id}/swimlanes?from=${from.toISOString()}&to=${to.toISOString()}`, { token: tokens.viewer });
    assert.equal(lanes.status, 200);
    assert.ok(Array.isArray(lanes.body.deployments) && Array.isArray(lanes.body.metrics));
    const backwards = await call('GET', `/api/projects/${project.id}/swimlanes?from=${to.toISOString()}&to=${from.toISOString()}`, { token: tokens.viewer });
    assert.equal(backwards.status, 400);
    for (const path of ['ledger', 'recurring', `intake?since=${from.toISOString()}`, 'sources']) {
      assert.equal((await call('GET', `/api/projects/${project.id}/${path}`, { token: tokens.viewer })).status, 200, path);
    }
    assert.equal((await call('GET', '/api/search?q=payments', { token: tokens.viewer })).body.projects.length, 1);
  });

  it('accepts metrics from the ingest token only', async () => {
    const body = { points: [{ name: 'error_rate', service: 'api', at: new Date().toISOString(), value: 1.5 }] };
    assert.equal((await call('POST', `/api/projects/${project.id}/metrics`, { body })).status, 401);
    assert.equal((await call('POST', `/api/projects/${project.id}/metrics`, { body, token: tokens.viewer })).status, 401);
    const ok = await call('POST', `/api/projects/${project.id}/metrics`, { body, headers: { 'x-ingest-token': project.ingest_token } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.upserted, 1);
  });

  it('tracks presence and guards rollback by role', async () => {
    const { body } = await call('GET', `/api/projects/${project.id}/incidents?status=all`, { token: tokens.viewer });
    const id = body.incidents[0].id;
    const hb = await call('POST', `/api/incidents/${id}/presence`, { token: tokens.viewer });
    assert.equal(hb.status, 200);
    assert.equal(hb.body.viewers.length, 1);
    assert.equal((await call('DELETE', `/api/incidents/${id}/presence`, { token: tokens.viewer })).status, 204);
    const denied = await call('POST', `/api/incidents/${id}/rollback`, {
      token: tokens.viewer,
      body: { from_deployment_id: crypto.randomUUID(), target_deployment_id: crypto.randomUUID() },
    });
    assert.equal(denied.status, 403);
    const missing = await call('POST', `/api/incidents/${id}/rollback`, {
      token: tokens.engineer,
      body: { from_deployment_id: crypto.randomUUID(), target_deployment_id: crypto.randomUUID() },
    });
    assert.equal(missing.status, 404);
  });

  it('archived projects stop accepting events, metrics and webhooks', async () => {
    const { body } = await call('POST', '/api/projects', { token: tokens.admin, body: { name: 'Short Lived' } });
    const p = body.project;
    assert.equal((await call('DELETE', `/api/projects/${p.id}`, { token: tokens.admin })).status, 204);
    const headers = { 'x-ingest-token': p.ingest_token };
    assert.equal((await call('POST', `/api/projects/${p.id}/events`, { headers, body: { type: 'deployment', deployment_id: 'x' } })).status, 409);
    assert.equal(
      (await call('POST', `/api/projects/${p.id}/metrics`, { headers, body: { points: [{ name: 'error_rate', at: new Date().toISOString(), value: 1 }] } })).status,
      409,
    );
    const payload = JSON.stringify({ zen: 'hi' });
    const sig = `sha256=${crypto.createHmac('sha256', p.webhook_secret).update(payload).digest('hex')}`;
    assert.equal((await call('POST', `/api/webhooks/github/${p.id}`, { body: payload, headers: { 'x-github-event': 'ping', 'x-hub-signature-256': sig } })).status, 409);
    // The UI forms go through the same rule.
    const t = tokens.engineer;
    assert.equal((await call('POST', `/api/projects/${p.id}/deployments`, { token: t, body: { version: 'v1' } })).status, 409);
    assert.equal((await call('POST', `/api/projects/${p.id}/changes`, { token: t, body: { sha: 'abc1234' } })).status, 409);
    assert.equal((await call('POST', `/api/projects/${p.id}/incidents`, { token: t, body: { title: 'Too late' } })).status, 409);
    const list = await call('GET', '/api/projects', { token: tokens.viewer });
    assert.ok(!list.body.projects.some((x: any) => x.id === p.id), 'archived project hidden from the list');
  });

  it('only admins can read the audit log', async () => {
    assert.equal((await call('GET', '/api/audit', { token: tokens.engineer })).status, 403);
    const r = await call('GET', `/api/audit?project_id=${project.id}`, { token: tokens.admin });
    assert.ok(r.body.entries.some((e: any) => e.action === 'incident.update'));
  });
});
