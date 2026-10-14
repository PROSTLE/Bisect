import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Db } from '../src/db/index.js';
import { actorFromUser } from '../src/lib/audit.js';
import { HttpError } from '../src/lib/errors.js';
import { getIncident, updateIncident } from '../src/services/incidents.js';
import { ingester, makeProject, makeUser, setupDb } from './helpers.js';

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

async function newIncident() {
  const p = await makeProject(db);
  const [r] = await ingester(db, p.id)([{ type: 'incident', title: 'Checkout is slow', severity: 'sev3' }]);
  return getIncident(db, r.entity_id!);
}

const rejects409 = (err: unknown) => err instanceof HttpError && err.status === 409;

describe('concurrent incident updates', () => {
  it('merges edits to different fields made from the same base version', async () => {
    const inc = await newIncident();
    await updateIncident(db, inc.id, inc.version, { severity: 'sev1' }, actorFromUser(alice));
    const res = await updateIncident(db, inc.id, inc.version, { assignee_id: bob.id }, actorFromUser(bob));
    assert.equal(res.merged, true);
    assert.equal(res.incident.severity, 'sev1');
    assert.equal(res.incident.assignee_id, bob.id);
    assert.equal(res.incident.version, inc.version + 2);
  });

  it('rejects conflicting edits to the same field with both values', async () => {
    const inc = await newIncident();
    await updateIncident(db, inc.id, inc.version, { severity: 'sev1' }, actorFromUser(alice));
    await assert.rejects(updateIncident(db, inc.id, inc.version, { severity: 'sev4' }, actorFromUser(bob)), (err: any) => {
      assert.ok(rejects409(err));
      assert.equal(err.details.conflicts[0].field, 'severity');
      assert.equal(err.details.conflicts[0].theirs, 'sev1');
      assert.equal(err.details.conflicts[0].yours, 'sev4');
      return true;
    });
  });

  it('does not treat setting the same value as a conflict', async () => {
    const inc = await newIncident();
    await updateIncident(db, inc.id, inc.version, { severity: 'sev1' }, actorFromUser(alice));
    const res = await updateIncident(db, inc.id, inc.version, { severity: 'sev1' }, actorFromUser(bob));
    assert.equal(res.incident.version, inc.version + 1);
  });

  it('serialises truly simultaneous writers without lost updates', async () => {
    const inc = await newIncident();
    const results = await Promise.allSettled([
      updateIncident(db, inc.id, inc.version, { title: 'Checkout is slow (EU)' }, actorFromUser(alice)),
      updateIncident(db, inc.id, inc.version, { title: 'Checkout is very slow' }, actorFromUser(bob)),
      updateIncident(db, inc.id, inc.version, { description: 'p99 is 8s' }, actorFromUser(bob)),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const conflicts = results.filter((r) => r.status === 'rejected' && rejects409(r.reason)).length;
    assert.equal(ok, 2);
    assert.equal(conflicts, 1);
    const final = await getIncident(db, inc.id);
    assert.equal(final.description, 'p99 is 8s');
    assert.equal(final.version, inc.version + 2);
  });
});

describe('incident lifecycle', () => {
  it('requires resolution details before resolving', async () => {
    const inc = await newIncident();
    await assert.rejects(updateIncident(db, inc.id, inc.version, { status: 'resolved' }, actorFromUser(alice)), /resolution/i);
    const res = await updateIncident(db, inc.id, inc.version, { status: 'resolved', resolution: 'Scaled DB' }, actorFromUser(alice));
    assert.equal(res.incident.status, 'resolved');
    assert.ok(res.incident.resolved_at);
  });

  it('cannot close an unresolved incident, but can reopen a resolved one', async () => {
    const inc = await newIncident();
    await assert.rejects(updateIncident(db, inc.id, inc.version, { status: 'closed' }, actorFromUser(alice)), /Resolve the incident/);
    const r1 = await updateIncident(db, inc.id, inc.version, { status: 'resolved', resolution: 'ok' }, actorFromUser(alice));
    const r2 = await updateIncident(db, inc.id, r1.incident.version, { status: 'investigating' }, actorFromUser(alice));
    assert.equal(r2.incident.resolved_at, null);
  });

  it('keeps an alert-based fingerprint when the title is edited', async () => {
    const p = await makeProject(db);
    const alert = { type: 'incident', severity: 'sev2', service: 'api', error_signature: 'pq: too many clients' };
    const [a] = await ingester(db, p.id)([{ ...alert, alert_id: 'a-1', title: 'API 5xx spike' }]);
    const [b] = await ingester(db, p.id)([{ ...alert, alert_id: 'a-2', title: 'API errors again' }]);
    const before = await getIncident(db, a.entity_id!);
    const r = await updateIncident(db, before.id, before.version, { title: 'DB connection pool exhausted' }, actorFromUser(alice));
    assert.equal(r.incident.fingerprint, before.fingerprint, 'renaming must not split it from its recurring group');
    assert.equal(r.incident.fingerprint, (await getIncident(db, b.entity_id!)).fingerprint);
  });

  it('records acknowledgement time and an activity trail', async () => {
    const inc = await newIncident();
    await updateIncident(db, inc.id, inc.version, { status: 'investigating', severity: 'sev2' }, actorFromUser(alice));
    const final = await getIncident(db, inc.id);
    assert.ok(final.acknowledged_at);
    const { rows } = await db.query(`SELECT kind FROM incident_updates WHERE incident_id = $1 ORDER BY created_at`, [inc.id]);
    assert.deepEqual(
      rows.map((r) => r.kind),
      ['system', 'status', 'field'],
    );
    const { rows: audit } = await db.query(`SELECT before, after FROM audit_log WHERE entity_id = $1 AND action = 'incident.update'`, [inc.id]);
    assert.equal(audit[0].after.severity, 'sev2');
    assert.equal(audit[0].before.severity, 'sev3');
  });
});
