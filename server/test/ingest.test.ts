import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/index.js';
import { hoursAgo, ingester, makeProject, setupDb } from './helpers.js';

let db: Db;
before(async () => {
  db = await setupDb();
});
after(async () => {
  await db.close();
});

describe('deduplication', () => {
  it('suppresses an identical delivery and counts it', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    const ev = { type: 'deployment', deployment_id: 'run-1', status: 'succeeded', version: 'v1', occurred_at: hoursAgo(1).toISOString() };
    const [first] = await ingest([ev]);
    const [second] = await ingest([ev]);
    assert.equal(first.status, 'created');
    assert.equal(second.status, 'duplicate');
    assert.equal(second.entity_id, first.entity_id);
    const { rows } = await db.query('SELECT duplicate_count FROM events WHERE project_id = $1', [p.id]);
    assert.deepEqual(rows, [{ duplicate_count: 1 }]);
  });

  it('dedups by event_id even when the payload differs (retried webhook with new timestamp)', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    await ingest([{ type: 'change', event_id: 'gh-commit-abc', sha: 'abcdef1', message: 'one', occurred_at: hoursAgo(2).toISOString() }]);
    const [r] = await ingest([{ type: 'change', event_id: 'gh-commit-abc', sha: 'abcdef1', message: 'one', occurred_at: hoursAgo(1).toISOString() }]);
    assert.equal(r.status, 'duplicate');
  });

  it('honours an Idempotency-Key for UI retries', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id, { idempotencyKey: 'click-123', source: 'ui' });
    const [a] = await ingest([{ type: 'incident', title: 'Login page is blank', severity: 'sev2' }]);
    const [b] = await ingest([{ type: 'incident', title: 'Login page is blank', severity: 'sev2' }]);
    assert.equal(a.status, 'created');
    assert.equal(b.status, 'duplicate');
    const { rows } = await db.query('SELECT count(*)::int AS n FROM incidents WHERE project_id = $1', [p.id]);
    assert.equal(rows[0].n, 1);
  });

  it('rejects invalid events individually without failing the batch', async () => {
    const p = await makeProject(db);
    const results = await ingester(db, p.id)([
      { type: 'deployment', deployment_id: 'ok-1', status: 'succeeded' },
      { type: 'deployment', deployment_id: 'bad', status: 'exploded' },
      { type: 'nonsense' },
    ]);
    assert.deepEqual(
      results.map((r) => r.status),
      ['created', 'rejected', 'rejected'],
    );
  });
});

describe('out-of-order and late events', () => {
  it('final deployment state does not depend on arrival order', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    const base = { type: 'deployment', deployment_id: 'run-ooo', version: 'v2' };
    const started = hoursAgo(2);
    const finished = hoursAgo(1.9);
    await ingest([{ ...base, status: 'succeeded', occurred_at: finished.toISOString() }], hoursAgo(1.89));
    const [late] = await ingest([{ ...base, status: 'started', occurred_at: started.toISOString() }], hoursAgo(1.5));

    assert.equal(late.status, 'updated');
    assert.equal(late.late, true);
    assert.equal(late.out_of_order, true);
    assert.match(late.warnings![0], /Stale status/);

    const { rows } = await db.query('SELECT * FROM deployments WHERE project_id = $1', [p.id]);
    assert.equal(rows[0].status, 'succeeded');
    assert.equal(rows[0].started_at.getTime(), started.getTime());
    assert.equal(rows[0].finished_at.getTime(), finished.getTime());
  });

  it('a later status wins over an earlier one (rollback after success)', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    const base = { type: 'deployment', deployment_id: 'run-rb' };
    await ingest([{ ...base, status: 'rolled_back', occurred_at: hoursAgo(1).toISOString() }]);
    await ingest([{ ...base, status: 'succeeded', occurred_at: hoursAgo(2).toISOString() }]);
    const { rows } = await db.query('SELECT status FROM deployments WHERE project_id = $1', [p.id]);
    assert.equal(rows[0].status, 'rolled_back');
  });

  it('commits referencing an unseen deployment create a placeholder that later events complete', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    const [c] = await ingest([{ type: 'change', sha: 'deadbee1', message: 'Fix bug', deployment_id: 'run-future' }]);
    assert.match(c.warnings![0], /placeholder/);
    let { rows } = await db.query('SELECT status, version FROM deployments WHERE project_id = $1', [p.id]);
    assert.deepEqual(rows[0], { status: 'unknown', version: null });

    await ingest([{ type: 'deployment', deployment_id: 'run-future', status: 'succeeded', version: 'v9', environment: 'production' }]);
    ({ rows } = await db.query(
      `SELECT d.status, d.version, array_agg(dc.sha) AS shas FROM deployments d JOIN deployment_commits dc ON dc.deployment_id = d.id
       WHERE d.project_id = $1 GROUP BY d.id`,
      [p.id],
    ));
    assert.deepEqual(rows[0], { status: 'succeeded', version: 'v9', shas: ['deadbee1'] });
  });

  it('flags events reported long after they happened', async () => {
    const p = await makeProject(db);
    const [r] = await ingester(db, p.id)([{ type: 'incident', title: 'Emails not delivered', occurred_at: hoursAgo(3).toISOString() }]);
    assert.equal(r.late, true);
    const { rows } = await db.query('SELECT detected_at, reported_at FROM incidents WHERE id = $1', [r.entity_id]);
    assert.ok(rows[0].reported_at.getTime() - rows[0].detected_at.getTime() > 2.9 * 3600_000);
  });

  it('rejects events far in the future (clock skew)', async () => {
    const p = await makeProject(db);
    const [r] = await ingester(db, p.id)([
      { type: 'deployment', deployment_id: 'x', occurred_at: new Date(Date.now() + 5 * 3600_000).toISOString() },
    ]);
    assert.equal(r.status, 'rejected');
  });
});

describe('conflicting events', () => {
  it('keeps the first known value and records the contradiction', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    await ingest([{ type: 'deployment', deployment_id: 'd-c', commit_sha: 'aaaaaaa', status: 'succeeded' }]);
    const [r] = await ingest([{ type: 'deployment', deployment_id: 'd-c', commit_sha: 'bbbbbbb', environment: 'production' }]);
    assert.match(r.warnings![0], /Conflicting commit_sha/);
    const { rows } = await db.query('SELECT commit_sha, environment, conflicts FROM deployments WHERE project_id = $1', [p.id]);
    assert.equal(rows[0].commit_sha, 'aaaaaaa');
    assert.equal(rows[0].environment, 'production'); // gaps are still filled
    assert.equal(rows[0].conflicts[0].rejected, 'bbbbbbb');
    const { rows: commits } = await db.query(
      'SELECT sha FROM deployment_commits dc JOIN deployments d ON d.id = dc.deployment_id WHERE d.project_id = $1',
      [p.id],
    );
    assert.deepEqual(commits, [{ sha: 'aaaaaaa' }], 'rejected sha is not attached');
  });

  it('alert resolution arriving before the alert opened is reconciled', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    const alert = { type: 'incident', alert_id: 'pd-1', title: 'High latency on search', severity: 'sev2' };
    const [resolved] = await ingest([{ ...alert, status: 'resolved', occurred_at: hoursAgo(1).toISOString() }]);
    assert.match(resolved.warnings![0], /Resolution arrived before/);
    const openedAt = hoursAgo(2);
    const [opened] = await ingest([{ ...alert, status: 'open', occurred_at: openedAt.toISOString() }]);
    assert.equal(opened.entity_id, resolved.entity_id);
    const { rows } = await db.query('SELECT status, detected_at, resolved_at FROM incidents WHERE id = $1', [resolved.entity_id]);
    assert.equal(rows[0].status, 'resolved'); // an older "open" must not reopen it
    assert.equal(rows[0].detected_at.getTime(), openedAt.getTime()); // detection time corrected backwards
    assert.ok(rows[0].detected_at < rows[0].resolved_at);
  });

  it('flags a probable duplicate incident with the same error fingerprint', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    await ingest([{ type: 'incident', title: 'Timeout after 3012ms calling order 8f3a2c1d', service: 'api' }]);
    const [r] = await ingest([{ type: 'incident', title: 'Timeout after 2875ms calling order 77be01aa', service: 'api' }]);
    assert.match(r.warnings!.join(), /Possible duplicate of INC-001/);
  });
});
