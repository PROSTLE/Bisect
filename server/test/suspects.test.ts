import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/index.js';
import { computeFingerprint, normalizeSignature } from '../src/lib/fingerprint.js';
import { setLink } from '../src/services/incidents.js';
import { findSuspects } from '../src/services/suspects.js';
import { recurringIssues } from '../src/services/dashboard.js';
import { githubToEvents, verifyGithubSignature } from '../src/routes/webhooks.js';
import { hoursAgo, ingester, makeProject, setupDb, system } from './helpers.js';

let db: Db;
before(async () => {
  db = await setupDb();
});
after(async () => {
  await db.close();
});

describe('suspect deployments', () => {
  it('ranks the recent same-service production deploy first and ignores later deploys', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    const dep = (id: string, h: number, extra: Record<string, unknown> = {}) => ({
      type: 'deployment',
      deployment_id: id,
      version: id,
      status: 'succeeded',
      service: 'api',
      environment: 'production',
      occurred_at: hoursAgo(h).toISOString(),
      ...extra,
    });
    await ingest([
      dep('old', 20),
      dep('recent', 1.5),
      dep('staging', 1.2, { environment: 'staging' }),
      dep('other-service', 1.1, { service: 'web' }),
      dep('after', 0.2),
    ]);
    const [inc] = await ingest([{ type: 'incident', title: 'API errors', service: 'api', environment: 'production', occurred_at: hoursAgo(1).toISOString() }]);
    const { suspects } = await findSuspects(db, inc.entity_id!);
    const order = suspects.map((s) => s.deployment.external_id);
    assert.equal(order[0], 'recent');
    assert.ok(!order.includes('after'), 'deploys after detection cannot be the cause');
    assert.ok(order.indexOf('staging') > order.indexOf('recent'));
    assert.ok(suspects.find((s) => s.deployment.external_id === 'old')!.score < 0.3);
  });

  it('human verdicts override the heuristic ordering', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    const r = await ingest([
      { type: 'deployment', deployment_id: 'a', status: 'succeeded', occurred_at: hoursAgo(5).toISOString() },
      { type: 'deployment', deployment_id: 'b', status: 'succeeded', occurred_at: hoursAgo(1.2).toISOString() },
    ]);
    const [inc] = await ingest([{ type: 'incident', title: 'Broken', occurred_at: hoursAgo(1).toISOString() }]);
    await setLink(db, inc.entity_id!, { target_type: 'deployment', target_id: r[1].entity_id!, relation: 'ruled_out' }, system);
    const { suspects } = await findSuspects(db, inc.entity_id!);
    assert.equal(suspects[0].deployment.external_id, 'a');
    assert.equal(suspects.at(-1)!.link?.relation, 'ruled_out');
  });

  it('boosts deploys that ship files implicated in earlier incidents with the same error', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    const title = 'TypeError in cart: cannot read id';
    await ingest([
      { type: 'change', sha: 'c0ffee01', files: ['src/cart.ts'], message: 'cart change' },
      { type: 'deployment', deployment_id: 'bad-1', status: 'succeeded', commits: ['c0ffee01'], occurred_at: hoursAgo(50).toISOString() },
    ]);
    const [past] = await ingest([{ type: 'incident', title, occurred_at: hoursAgo(49).toISOString() }]);
    const { rows } = await db.query(`SELECT id FROM deployments WHERE project_id = $1 AND external_id = 'bad-1'`, [p.id]);
    await setLink(db, past.entity_id!, { target_type: 'deployment', target_id: rows[0].id, relation: 'confirmed' }, system);

    await ingest([
      { type: 'change', sha: 'c0ffee02', files: ['src/cart.ts'], message: 'tweak' },
      { type: 'change', sha: 'c0ffee03', files: ['README.md'], message: 'docs' },
      { type: 'deployment', deployment_id: 'touches-cart', status: 'succeeded', commits: ['c0ffee02'], occurred_at: hoursAgo(3).toISOString() },
      { type: 'deployment', deployment_id: 'docs-only', status: 'succeeded', commits: ['c0ffee03'], occurred_at: hoursAgo(2.5).toISOString() },
    ]);
    const [now] = await ingest([{ type: 'incident', title, occurred_at: hoursAgo(2).toISOString() }]);
    const { suspects } = await findSuspects(db, now.entity_id!);
    assert.equal(suspects[0].deployment.external_id, 'touches-cart');
    assert.ok(suspects[0].reasons.some((r) => r.text.includes('src/cart.ts')));
  });
});

describe('fingerprints & recurring issues', () => {
  it('normalises volatile parts of error messages', () => {
    assert.equal(normalizeSignature('Timeout after 3012ms on order 8f3a2c1d'), normalizeSignature('Timeout after 15ms on order 77be01aa'));
    assert.equal(computeFingerprint('api', 'Error "foo" 42'), computeFingerprint('API', 'Error "bar" 7'));
    assert.notEqual(computeFingerprint('api', 'x failed'), computeFingerprint('web', 'x failed'));
  });

  it('clusters reworded incidents into one recurring issue', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    await ingest([
      { type: 'incident', title: 'Payment webhook timeouts from Stripe', service: 'payments', occurred_at: hoursAgo(100).toISOString() },
      { type: 'incident', title: 'Stripe payment webhook timeout spikes', service: 'payments', occurred_at: hoursAgo(50).toISOString() },
      { type: 'incident', title: 'Search index lagging', service: 'search', occurred_at: hoursAgo(10).toISOString() },
    ]);
    const groups = await recurringIssues(db, p.id);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].count, 2);
  });
});

describe('github webhooks', () => {
  it('verifies HMAC signatures', () => {
    const body = Buffer.from('{"a":1}');
    const sig = `sha256=${crypto.createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    assert.equal(verifyGithubSignature('s3cret', body, sig), true);
    assert.equal(verifyGithubSignature('wrong', body, sig), false);
    assert.equal(verifyGithubSignature('s3cret', body, undefined), false);
  });

  it('maps push and deployment_status payloads to events', () => {
    const push = githubToEvents('push', {
      ref: 'refs/heads/main',
      commits: [{ id: 'abc1234', message: 'Fix', timestamp: '2026-01-01T00:00:00Z', author: { username: 'al' }, added: ['a'], modified: ['b'], removed: [] }],
    });
    assert.deepEqual(push[0], {
      type: 'change',
      event_id: 'gh-commit-abc1234',
      sha: 'abc1234',
      message: 'Fix',
      author: 'al',
      url: undefined,
      branch: 'main',
      files: ['a', 'b'],
      occurred_at: '2026-01-01T00:00:00Z',
    });
    const status = githubToEvents('deployment_status', {
      deployment_status: { id: 9, state: 'failure', created_at: '2026-01-01T00:05:00Z' },
      deployment: { id: 5, sha: 'abc1234', ref: 'v1', environment: 'production' },
    });
    assert.equal(status[0].status, 'failed');
    assert.equal(status[0].deployment_id, 'gh-5');
    assert.deepEqual(githubToEvents('deployment_status', { deployment_status: { state: 'inactive' }, deployment: { id: 1 } }), []);
  });
});
