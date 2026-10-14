import { config } from '../config.js';
import type { Db, Queryable } from '../db/index.js';
import type { Actor } from '../lib/audit.js';
import { HttpError, notFound } from '../lib/errors.js';
import { ACTIVE, INCIDENT_SELECT, addUpdate, getIncident, incLabel, updateIncident, type IncidentRow } from './incidents.js';
import { ingestEvents } from './ingest.js';
import { rollbackTarget } from './suspects.js';

/*
 * Read models for the "war room" overview: everything here is derived from the event log and the
 * materialised tables — no presentation strings are stored, the UI composes them from these facts.
 */

const EFFECTIVE = `COALESCE(d.finished_at, d.started_at, d.status_at, d.created_at)`;
const SOAK_HOURS = 2;

// ---- overview -----------------------------------------------------------------------------

export async function overview(q: Queryable, projectId: string) {
  const [{ rows: active }, { rows: fresh }] = await Promise.all([
    q.query<IncidentRow>(
      `${INCIDENT_SELECT} WHERE i.project_id = $1 AND i.status = ANY($2::text[])
       ORDER BY i.severity, i.detected_at DESC`,
      [projectId, ACTIVE],
    ),
    q.query<{ at: Date | null }>('SELECT max(received_at) AS at FROM events WHERE project_id = $1', [projectId]),
  ]);
  return {
    focus: active[0] ?? null,
    active: active.map((i) => ({ id: i.id, number: i.number, title: i.title, severity: i.severity, status: i.status })),
    data_fresh_at: fresh[0]?.at ?? null,
  };
}

// ---- activity feed ------------------------------------------------------------------------

/**
 * Incident updates plus the "plumbing" events a responder should know about while the incident is
 * running: late reports (with how late) and duplicate deliveries that were folded.
 */
export async function incidentFeed(q: Queryable, incidentId: string, limit = 60) {
  const inc = await getIncident(q, incidentId);
  const from = new Date(inc.detected_at.getTime() - 6 * 3600_000).toISOString();
  const [{ rows: updates }, { rows: events }] = await Promise.all([
    q.query(
      `SELECT u.id, u.kind, u.body, u.data, u.created_at, u.author_id, a.name AS author_name
       FROM incident_updates u LEFT JOIN users a ON a.id = u.author_id
       WHERE u.incident_id = $1 ORDER BY u.created_at DESC LIMIT $2`,
      [incidentId, limit],
    ),
    q.query(
      `SELECT e.id, e.kind, e.action, e.entity_id, e.summary, e.occurred_at, e.received_at, e.source, e.source_name,
              e.late, e.duplicate_count, e.last_duplicate_at, u.name AS actor_name, e.payload->>'sha' AS sha,
              extract(epoch FROM e.received_at - e.occurred_at)::int AS delay_seconds
       FROM events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.project_id = $1 AND e.occurred_at >= $2::timestamptz AND (e.late OR e.duplicate_count > 0)
         -- other incidents' plumbing only when they look like the same problem
         AND (e.kind <> 'incident' OR e.entity_id = $3 OR EXISTS (
               SELECT 1 FROM incidents o WHERE o.id = e.entity_id
                 AND (o.fingerprint = $4 OR (o.service IS NOT NULL AND o.service = $5))))
       ORDER BY e.received_at DESC LIMIT 20`,
      [inc.project_id, from, inc.id, inc.fingerprint, inc.service],
    ),
  ]);
  const items = [
    ...updates.map((u) => ({ type: 'update' as const, at: u.created_at, ...u })),
    ...events.map((e) => ({ type: 'event' as const, at: e.duplicate_count > 0 && e.last_duplicate_at ? e.last_duplicate_at : e.received_at, ...e })),
  ];
  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return items.slice(0, limit);
}

// ---- deploy ledger ------------------------------------------------------------------------

export async function ledger(q: Queryable, projectId: string, limit = 15) {
  const { rows: deps } = await q.query(
    `SELECT d.id, d.number, d.external_id, d.version, d.environment, d.service, d.status, d.deployed_by, d.commit_sha,
            d.started_at, d.finished_at, d.project_id, ${EFFECTIVE} AS effective_at,
            COALESCE(d.started_at, d.finished_at, d.status_at, d.created_at) AS begin_at,
            (SELECT count(*)::int FROM deployment_commits dc WHERE dc.deployment_id = d.id) AS commit_count,
            (SELECT row_to_json(h) FROM (
               SELECT c.sha, c.message, c.author FROM deployment_commits dc
               JOIN changes c ON c.project_id = d.project_id AND c.sha = dc.sha
               WHERE dc.deployment_id = d.id
               ORDER BY (c.sha = d.commit_sha) DESC, c.committed_at DESC LIMIT 1) h) AS head,
            (SELECT COALESCE(json_agg(json_build_object('relation', l.relation, 'incident_id', i.id, 'number', i.number)), '[]')
               FROM incident_links l JOIN incidents i ON i.id = l.incident_id
               WHERE l.target_type = 'deployment' AND l.target_id = d.id AND l.relation <> 'ruled_out') AS links
     FROM deployments d WHERE d.project_id = $1
     ORDER BY ${EFFECTIVE} DESC LIMIT $2`,
    [projectId, limit],
  );
  const oldest = deps.length ? deps[deps.length - 1].effective_at : new Date(0);
  const [{ rows: orphans }, rollbackTargets] = await Promise.all([
    q.query(
      `SELECT c.id, c.sha, c.kind, c.message, c.author, c.committed_at FROM changes c
       WHERE c.project_id = $1 AND c.committed_at >= $2::timestamptz
         AND NOT EXISTS (SELECT 1 FROM deployment_commits dc JOIN deployments d ON d.id = dc.deployment_id
                         WHERE dc.sha = c.sha AND d.project_id = c.project_id)
       ORDER BY c.committed_at DESC LIMIT 10`,
      [projectId, new Date(oldest).toISOString()],
    ),
    activeRollbackTargets(q, projectId),
  ]);

  const now = Date.now();
  const rows = deps.map((d) => {
    const confirmed = d.links.find((l: any) => l.relation === 'confirmed');
    const suspected = d.links.find((l: any) => l.relation === 'suspected');
    let after: { label: string; tone: string };
    if (confirmed) after = { label: `caused ${incLabel(confirmed.number)}`, tone: 'danger' };
    else if (d.status === 'failed') after = { label: 'failed', tone: 'danger' };
    else if (d.status === 'rolled_back') after = { label: 'rolled back', tone: 'warn' };
    else if (suspected) after = { label: `suspect in ${incLabel(suspected.number)}`, tone: 'warn' };
    else if (d.status === 'pending' || d.status === 'in_progress') after = { label: 'deploying', tone: 'info' };
    else if (d.status === 'unknown') after = { label: 'no status reported', tone: 'muted' };
    else if (rollbackTargets.has(d.id)) after = { label: 'clean · rollback target', tone: 'muted' };
    else if (now - new Date(d.effective_at).getTime() < SOAK_HOURS * 3600_000) after = { label: 'soaking', tone: 'info' };
    else after = { label: 'clean', tone: 'muted' };
    return { type: 'deployment' as const, at: d.effective_at, ...d, after };
  });
  const changeRows = orphans.map((c) => ({
    type: 'change' as const,
    at: c.committed_at,
    ...c,
    after: { label: 'no deploy record', tone: 'warn' },
  }));
  return [...rows, ...changeRows].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/** Deploys that are the rollback target for a deploy currently suspected/confirmed in an active incident. */
async function activeRollbackTargets(q: Queryable, projectId: string) {
  const { rows } = await q.query(
    `SELECT DISTINCT d.*, COALESCE(d.started_at, d.finished_at, d.status_at, d.created_at) AS begin_at
     FROM incident_links l JOIN incidents i ON i.id = l.incident_id JOIN deployments d ON d.id = l.target_id
     WHERE i.project_id = $1 AND i.status = ANY($2::text[]) AND l.target_type = 'deployment' AND l.relation IN ('suspected', 'confirmed')`,
    [projectId, ACTIVE],
  );
  const out = new Set<string>();
  for (const d of rows) {
    const t = await rollbackTarget(q, d);
    if (t) out.add(t.id);
  }
  return out;
}

// ---- swimlanes ----------------------------------------------------------------------------

export async function swimlanes(q: Queryable, projectId: string, from: Date, to: Date) {
  const p = [projectId, from.toISOString(), to.toISOString()];
  const [deps, changes, incidents, reports, metrics, counts] = await Promise.all([
    q.query(
      `SELECT d.id, d.number, d.version, d.environment, d.service, d.status, d.commit_sha, d.external_id,
              d.started_at, d.finished_at, ${EFFECTIVE} AS effective_at
       FROM deployments d WHERE d.project_id = $1 AND ${EFFECTIVE} BETWEEN $2::timestamptz AND $3::timestamptz
       ORDER BY effective_at`,
      p,
    ),
    q.query(
      `SELECT c.id, c.sha, c.kind, c.message, c.author, c.committed_at,
              EXISTS (SELECT 1 FROM deployment_commits dc JOIN deployments d ON d.id = dc.deployment_id
                      WHERE dc.sha = c.sha AND d.project_id = c.project_id) AS deployed
       FROM changes c WHERE c.project_id = $1 AND c.committed_at BETWEEN $2::timestamptz AND $3::timestamptz
       ORDER BY c.committed_at`,
      p,
    ),
    q.query(
      `SELECT id, number, title, severity, status, detected_at, resolved_at, duplicate_of FROM incidents
       WHERE project_id = $1 AND detected_at <= $3::timestamptz AND (resolved_at IS NULL OR resolved_at >= $2::timestamptz)
       ORDER BY detected_at`,
      p,
    ),
    // Human reports and alerts, plus anything that arrived late: drawn as "happened" → "heard".
    q.query(
      `SELECT e.id, e.kind, e.action, e.entity_id, e.summary, e.occurred_at, e.received_at, e.source, e.source_name,
              e.late, e.duplicate_count, u.name AS actor_name
       FROM events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.project_id = $1 AND e.occurred_at BETWEEN $2::timestamptz AND $3::timestamptz
         AND ((e.kind = 'incident' AND e.action IN ('incident.opened', 'incident.refired')) OR e.late OR e.duplicate_count > 0)
       ORDER BY e.occurred_at`,
      p,
    ),
    q.query(
      `SELECT service, at, value FROM metric_points
       WHERE project_id = $1 AND name = 'error_rate' AND at BETWEEN $2::timestamptz AND $3::timestamptz ORDER BY service, at`,
      p,
    ),
    q.query(
      `SELECT count(*) FILTER (WHERE late)::int AS late, COALESCE(sum(duplicate_count), 0)::int AS duplicates
       FROM events WHERE project_id = $1 AND occurred_at BETWEEN $2::timestamptz AND $3::timestamptz`,
      p,
    ),
  ]);

  // Downsample each metric series to ≤ 300 points (bucket max keeps spikes visible).
  const series = new Map<string, { at: string; value: number }[]>();
  for (const r of metrics.rows) {
    if (!series.has(r.service)) series.set(r.service, []);
    series.get(r.service)!.push({ at: r.at, value: r.value });
  }
  const metricOut = [...series].map(([service, pts]) => {
    const step = Math.ceil(pts.length / 300);
    const out = step <= 1 ? pts : [];
    if (step > 1) {
      for (let i = 0; i < pts.length; i += step) {
        const chunk = pts.slice(i, i + step);
        out.push(chunk.reduce((m, x) => (x.value > m.value ? x : m)));
      }
    }
    return { name: 'error_rate', service, points: out };
  });

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    deployments: deps.rows,
    changes: changes.rows,
    incidents: incidents.rows,
    reports: reports.rows,
    metrics: metricOut,
    counts: counts.rows[0],
  };
}

// ---- intake & sources ---------------------------------------------------------------------

export async function intake(q: Queryable, projectId: string, since: Date) {
  const s = since.toISOString();
  const [{ rows: ev }, { rows: dups }, { rows: conflicts }] = await Promise.all([
    q.query(
      `SELECT count(*)::int AS received, count(*) FILTER (WHERE late)::int AS late,
              COALESCE(max(extract(epoch FROM received_at - occurred_at)) FILTER (WHERE late), 0)::int AS max_delay_seconds,
              count(*) FILTER (WHERE out_of_order)::int AS out_of_order
       FROM events WHERE project_id = $1 AND received_at >= $2::timestamptz`,
      [projectId, s],
    ),
    q.query(
      `SELECT COALESCE(sum(duplicate_count), 0)::int AS duplicates FROM events
       WHERE project_id = $1 AND last_duplicate_at >= $2::timestamptz`,
      [projectId, s],
    ),
    q.query(
      `SELECT count(*)::int AS n FROM incident_updates u JOIN incidents i ON i.id = u.incident_id
       WHERE i.project_id = $1 AND u.kind = 'conflict' AND u.created_at >= $2::timestamptz`,
      [projectId, s],
    ),
  ]);
  return {
    since: s,
    received: ev[0].received,
    duplicates: dups[0].duplicates,
    late: ev[0].late,
    max_delay_seconds: ev[0].max_delay_seconds,
    out_of_order: ev[0].out_of_order,
    edit_conflicts: conflicts[0].n,
    policy: {
      dedup: 'event_id › Idempotency-Key › content hash',
      ordering: 'occurred_at, then received_at',
      conflicts: 'version check; rejected edit kept in the feed',
      late_threshold_minutes: config.lateThresholdMinutes,
    },
  };
}

export async function eventSources(q: Queryable, projectId: string) {
  const { rows } = await q.query(
    `SELECT COALESCE(source_name, CASE source WHEN 'github' THEN 'GitHub webhooks' WHEN 'ui' THEN 'bisect UI' ELSE 'API' END) AS name,
            max(received_at) AS last_received_at,
            count(*) FILTER (WHERE received_at > now() - interval '24 hours')::int AS last_24h
     FROM events WHERE project_id = $1 GROUP BY 1 ORDER BY 2 DESC LIMIT 8`,
    [projectId],
  );
  return rows;
}

// ---- search -------------------------------------------------------------------------------

export async function search(q: Queryable, term: string) {
  const t = term.trim();
  if (!t) return { incidents: [], deployments: [], changes: [], people: [], projects: [] };
  const like = `%${t.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const num = /^(?:inc-?|#)?(\d{1,9})$/i.exec(t)?.[1];
  const hex = /^[0-9a-f]{4,40}$/i.test(t) ? t.toLowerCase() : null;
  const [incidents, deployments, changes, people, projects] = await Promise.all([
    q.query(
      `SELECT i.id, i.project_id, i.number, i.title, i.severity, i.status, p.name AS project_name
       FROM incidents i JOIN projects p ON p.id = i.project_id
       WHERE p.archived_at IS NULL AND (i.title ILIKE $1 OR ($2::int IS NOT NULL AND i.number = $2::int) OR i.external_id ILIKE $1)
       ORDER BY i.detected_at DESC LIMIT 6`,
      [like, num ?? null],
    ),
    q.query(
      `SELECT d.id, d.project_id, d.number, d.version, d.environment, d.status, d.commit_sha, p.name AS project_name
       FROM deployments d JOIN projects p ON p.id = d.project_id
       WHERE p.archived_at IS NULL AND (($1::int IS NOT NULL AND d.number = $1::int) OR d.version ILIKE $2 OR d.external_id ILIKE $2
              OR ($3::text IS NOT NULL AND d.commit_sha LIKE $3 || '%'))
       ORDER BY ${EFFECTIVE} DESC LIMIT 6`,
      [num ?? null, like, hex],
    ),
    q.query(
      `SELECT c.id, c.project_id, c.sha, c.kind, c.message, c.author, p.name AS project_name
       FROM changes c JOIN projects p ON p.id = c.project_id
       WHERE p.archived_at IS NULL AND (($1::text IS NOT NULL AND c.sha LIKE $1 || '%') OR c.message ILIKE $2 OR c.author ILIKE $2)
       ORDER BY c.committed_at DESC NULLS LAST LIMIT 6`,
      [hex, like],
    ),
    q.query(`SELECT id, name, email, role FROM users WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY name LIMIT 5`, [like]),
    q.query(`SELECT id, name, slug FROM projects WHERE archived_at IS NULL AND (name ILIKE $1 OR slug ILIKE $1) ORDER BY name LIMIT 5`, [
      like,
    ]),
  ]);
  return {
    incidents: incidents.rows,
    deployments: deployments.rows,
    changes: changes.rows,
    people: people.rows,
    projects: projects.rows,
  };
}

// ---- rollback request ---------------------------------------------------------------------

/**
 * bisect does not run deployments. A rollback request is recorded as a *pending deployment* of the
 * target version with a deterministic id (`rollback:<from>-><target>:<incident>`), so the CD system
 * reports progress against it through the normal ingestion API, and a second click is a duplicate.
 */
export async function requestRollback(db: Db, incidentId: string, fromId: string, targetId: string, actor: Actor) {
  const inc = await getIncident(db, incidentId);
  const { rows } = await db.query(
    `SELECT d.*, ${EFFECTIVE} AS effective_at FROM deployments d WHERE d.project_id = $1 AND d.id = ANY($2::uuid[])`,
    [inc.project_id, [fromId, targetId]],
  );
  const from = rows.find((r) => r.id === fromId);
  const target = rows.find((r) => r.id === targetId);
  if (!from || !target) throw notFound('Deployment');
  if (target.status !== 'succeeded') throw new HttpError(422, 'bad_target', `#${target.number} did not succeed — pick a clean deploy`);
  if (new Date(target.effective_at) >= new Date(from.effective_at)) {
    throw new HttpError(422, 'bad_target', 'The rollback target must be older than the deploy being rolled back');
  }
  const externalId = `rollback:${from.number}->${target.number}:${incLabel(inc.number)}`;
  const [result] = await ingestEvents(
    db,
    { projectId: inc.project_id, source: 'ui', actor, sourceName: 'bisect UI' },
    [
      {
        type: 'deployment',
        event_id: `${externalId}:requested`,
        deployment_id: externalId,
        status: 'pending',
        version: target.version ?? undefined,
        commit_sha: target.commit_sha ?? undefined,
        environment: from.environment ?? undefined,
        service: from.service ?? undefined,
        deployed_by: actor.user?.name ?? actor.label,
        notes: `Rollback of #${from.number} to #${target.number} requested for ${incLabel(inc.number)}`,
      },
    ],
  );
  if (result.status === 'rejected') throw new HttpError(400, 'rollback_rejected', result.errors?.[0]?.message ?? 'Rejected');
  const { rows: created } = await db.query('SELECT * FROM deployments WHERE id = $1', [result.entity_id]);
  if (result.status !== 'duplicate') {
    await addUpdate(
      db,
      incidentId,
      actor.user?.id ?? null,
      'system',
      `Requested rollback of #${from.number} to #${target.number}. Tracked as deploy #${created[0].number} — waiting for the pipeline to report progress.`,
      { deployment_id: created[0].id, from: from.id, target: target.id },
    );
    if (['open', 'investigating', 'identified'].includes(inc.status)) {
      const fresh = await getIncident(db, incidentId);
      await updateIncident(db, incidentId, fresh.version, { status: 'mitigating' }, actor).catch(() => undefined);
    }
  }
  return { status: result.status, deployment: created[0], deployment_id: externalId };
}
