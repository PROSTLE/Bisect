import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/index.js';
import { actorFromUser } from '../src/lib/audit.js';
import { HttpError } from '../src/lib/errors.js';
import { presence } from '../src/lib/presence.js';
import { getIncident, setLink, updateIncident } from '../src/services/incidents.js';
import { errorSignal, upsertMetrics } from '../src/services/metrics.js';
import { findSuspects } from '../src/services/suspects.js';
import { incidentFeed, intake, ledger, requestRollback, search } from '../src/services/warroom.js';
import { hoursAgo, ingester, makeProject, makeUser, setupDb, system } from './helpers.js';

let db: Db;
let alice: any;
let bob: any;
before(async () => {
  db = await setupDb();
  alice = await makeUser(db);
  bob = await makeUser(db);
});
after(async () => {
  await db.close();
});

const dep = (id: string, h: number, extra: Record<string, unknown> = {}) => ({
  type: 'deployment',
  deployment_id: id,
  status: 'succeeded',
  service: 'api',
  environment: 'production',
  occurred_at: hoursAgo(h).toISOString(),
  ...extra,
});

describe('deploy numbers', () => {
  it('assigns sequential per-project numbers on first sighting and keeps them across merges', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    await ingest([dep('a', 3), dep('b', 2)]);
    await ingest([{ ...dep('a', 3), version: 'v1' }]); // merge must not renumber
    const other = await makeProject(db);
    await ingester(db, other.id)([dep('x', 1)]);
    const { rows } = await db.query('SELECT external_id, number FROM deployments WHERE project_id = $1 ORDER BY number', [p.id]);
    assert.deepEqual(rows, [
      { external_id: 'a', number: 1 },
      { external_id: 'b', number: 2 },
    ]);
    const { rows: o } = await db.query('SELECT number FROM deployments WHERE project_id = $1', [other.id]);
    assert.equal(o[0].number, 1, 'numbering is per project');
  });
});

describe('metrics & onset', () => {
  it('upserts samples idempotently and finds when the error rate breached its baseline', async () => {
    const p = await makeProject(db);
    const pts = [];
    for (let m = 600; m >= 0; m -= 10) {
      const at = new Date(Date.now() - m * 60_000);
      pts.push({ name: 'error_rate', service: 'api', at: at.toISOString(), value: m <= 30 ? 14 : 0.5 });
    }
    await upsertMetrics(db, p.id, pts);
    await upsertMetrics(db, p.id, pts); // same keys again
    const { rows } = await db.query('SELECT count(*)::int AS n FROM metric_points WHERE project_id = $1', [p.id]);
    assert.equal(rows[0].n, pts.length);
    const sig = await errorSignal(db, p.id, 'api', new Date());
    assert.ok(sig);
    assert.equal(sig.baseline, 0.5);
    assert.equal(sig.latest, 14);
    assert.ok(Math.abs(new Date(sig.onset_at!).getTime() - (Date.now() - 30 * 60_000)) < 60_000);
  });

  it('ranks deploys against the metric onset, not the (later) detection time', async () => {
    const p = await makeProject(db);
    const pts = [];
    for (let m = 300; m >= 0; m -= 5) pts.push({ name: 'error_rate', service: 'api', at: new Date(Date.now() - m * 60_000).toISOString(), value: m <= 90 ? 12 : 0.4 });
    await upsertMetrics(db, p.id, pts);
    const ingest = ingester(db, p.id);
    // breaks at −90 min; one deploy just before the breach, one after it but before detection (−10 min)
    await ingest([dep('before-onset', 1.6), dep('after-onset', 0.75)]);
    const [inc] = await ingest([{ type: 'incident', title: 'API errors', service: 'api', environment: 'production', occurred_at: hoursAgo(1 / 6).toISOString() }]);
    const { suspects, signal } = await findSuspects(db, inc.entity_id!);
    assert.ok(signal?.onset_at);
    assert.equal(suspects[0].deployment.external_id, 'before-onset');
    const late = suspects.find((s) => s.deployment.external_id === 'after-onset')!;
    assert.match(late.reasons[0].text, /after the error rate first spiked/);
  });
});

describe('change-level suspects', () => {
  it('scores commits inside a suspect deploy and config changes with no deploy record', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    await ingest([
      { type: 'change', sha: 'aaaa1111', message: 'api: tweak timeouts', files: ['api/timeouts.go'], occurred_at: hoursAgo(1.5).toISOString() },
      { type: 'change', sha: 'bbbb2222', message: 'docs', files: ['README.md'], occurred_at: hoursAgo(1.4).toISOString() },
      { ...dep('d1', 1), commits: ['aaaa1111', 'bbbb2222'] },
      { type: 'change', kind: 'config', sha: 'cccc3333', message: 'config: MAX_CONNS 50 -> 20', files: ['infra/db.tf'], occurred_at: hoursAgo(1.2).toISOString() },
    ]);
    const [inc] = await ingest([{ type: 'incident', title: 'api timeouts', service: 'api', environment: 'production', occurred_at: hoursAgo(0.9).toISOString() }]);
    const { changes } = await findSuspects(db, inc.entity_id!);
    const bySha = Object.fromEntries(changes.map((c) => [c.change.sha, c]));
    assert.ok(bySha.aaaa1111.score > bySha.bbbb2222.score, 'the commit that mentions the symptom ranks above the docs commit');
    assert.equal(bySha.cccc3333.deployment, null);
    assert.ok(bySha.cccc3333.reasons.some((r) => /no deploy record/.test(r.text)));
  });
});

describe('rollback requests', () => {
  it('records a pending rollback deploy once, moves the incident to mitigating, and validates the target', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    const [good] = await ingest([{ ...dep('good', 3), version: 'v1', commit_sha: 'abc1234' }]);
    const [bad] = await ingest([{ ...dep('bad', 1), version: 'v2' }]);
    const [failed] = await ingest([{ ...dep('failed', 2), status: 'failed' }]);
    const [inc] = await ingest([{ type: 'incident', title: 'down', service: 'api', occurred_at: hoursAgo(0.5).toISOString() }]);
    const actor = actorFromUser(alice);

    const first = await requestRollback(db, inc.entity_id!, bad.entity_id!, good.entity_id!, actor);
    assert.equal(first.status, 'created');
    assert.equal(first.deployment.status, 'pending');
    assert.equal(first.deployment.version, 'v1');
    assert.equal(first.deployment.commit_sha, 'abc1234');
    const again = await requestRollback(db, inc.entity_id!, bad.entity_id!, good.entity_id!, actor);
    assert.equal(again.status, 'duplicate');
    assert.equal((await getIncident(db, inc.entity_id!)).status, 'mitigating');

    await assert.rejects(requestRollback(db, inc.entity_id!, bad.entity_id!, failed.entity_id!, actor), /did not succeed/);
    await assert.rejects(requestRollback(db, inc.entity_id!, good.entity_id!, bad.entity_id!, actor), /older/);
  });
});

describe('conflict history & feed', () => {
  it('keeps the rejected edit in the activity feed', async () => {
    const p = await makeProject(db);
    const [r] = await ingester(db, p.id)([{ type: 'incident', title: 'slow', severity: 'sev3' }]);
    const inc = await getIncident(db, r.entity_id!);
    await updateIncident(db, inc.id, inc.version, { severity: 'sev1' }, actorFromUser(alice));
    await assert.rejects(updateIncident(db, inc.id, inc.version, { severity: 'sev2' }, actorFromUser(bob)), (e) => e instanceof HttpError && e.status === 409);
    const feed = await incidentFeed(db, inc.id);
    const conflict = feed.find((f) => (f as any).kind === 'conflict') as any;
    assert.ok(conflict, 'conflict entry exists');
    assert.equal(conflict.data.conflicts[0].field, 'severity');
    assert.equal(conflict.data.conflicts[0].yours, 'sev2');
    assert.equal(conflict.data.conflicts[0].theirs, 'sev1');
    assert.equal(conflict.data.rejected_by, bob.name);
    const since = new Date(Date.now() - 3600_000);
    assert.equal((await intake(db, p.id, since)).edit_conflicts, 1);
  });
});

describe('ledger', () => {
  it('labels what happened after each deploy', async () => {
    const p = await makeProject(db);
    const ingest = ingester(db, p.id);
    const [clean] = await ingest([dep('clean', 5)]);
    const [culprit] = await ingest([dep('culprit', 3)]);
    await ingest([dep('fresh', 0.5, { environment: 'staging' })]);
    await ingest([{ type: 'change', kind: 'config', sha: 'dddd4444', message: 'flag flip', occurred_at: hoursAgo(2).toISOString() }]);
    const [inc] = await ingest([{ type: 'incident', title: 'boom', service: 'api', occurred_at: hoursAgo(2.5).toISOString() }]);
    await setLink(db, inc.entity_id!, { target_type: 'deployment', target_id: culprit.entity_id!, relation: 'suspected' }, system);
    const rows = await ledger(db, p.id, 10);
    const label = (id: string) => rows.find((r: any) => r.id === id)!.after.label;
    assert.equal(label(culprit.entity_id!), 'suspect in INC-001');
    assert.equal(label(clean.entity_id!), 'clean · rollback target');
    assert.equal(rows.find((r: any) => r.external_id === 'fresh')!.after.label, 'soaking');
    assert.equal(rows.find((r: any) => r.sha === 'dddd4444')!.after.label, 'no deploy record');
  });
});

describe('search', () => {
  it('finds incidents by INC number, deploys by #number or SHA, changes and people', async () => {
    const p = await makeProject(db, 'Zephyr Shop');
    const ingest = ingester(db, p.id);
    await ingest([
      { type: 'change', sha: 'feedface99', message: 'zephyr: tune cache', files: [] },
      dep('z1', 1, { commit_sha: 'feedface99', version: 'v9.9.9' }),
      { type: 'incident', title: 'Zephyr checkout melts' },
    ]);
    assert.ok((await search(db, 'INC-001')).incidents.some((i) => i.project_id === p.id));
    assert.ok((await search(db, 'melts')).incidents.length >= 1);
    assert.ok((await search(db, '#1')).deployments.some((d) => d.project_id === p.id));
    assert.ok((await search(db, 'feedface')).deployments.some((d) => d.version === 'v9.9.9'));
    assert.ok((await search(db, 'feedface')).changes.some((c) => c.sha === 'feedface99'));
    assert.ok((await search(db, alice.name)).people.some((u) => u.id === alice.id));
    assert.ok((await search(db, 'zephyr')).projects.some((x) => x.id === p.id));
    assert.deepEqual((await search(db, '   ')).incidents, []);
  });
});

describe('presence', () => {
  it('tracks viewers per incident and expires them', () => {
    presence.heartbeat('inc-1', 'proj-1', { id: 'u1', name: 'A' });
    presence.heartbeat('inc-1', 'proj-1', { id: 'u2', name: 'B' });
    assert.equal(presence.forProject('proj-1')['inc-1'].length, 2);
    presence.leave('inc-1', 'u1');
    assert.deepEqual(presence.forProject('proj-1')['inc-1'], [{ id: 'u2', name: 'B' }]);
    presence.sweep(Date.now() + 60_000);
    assert.equal(presence.forProject('proj-1')['inc-1'], undefined);
  });
});
