import type { Queryable } from '../db/index.js';
import { jaccard, normalizeSignature, tokens } from '../lib/fingerprint.js';

export async function projectDashboard(q: Queryable, projectId: string, days: number) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const p = [projectId, since];

  const [open, incidentStats, deployStats, deploysPerDay, incidentsPerDay, quality, topCulprits, recent] = await Promise.all([
    q.query(
      `SELECT severity, count(*)::int AS n FROM incidents
       WHERE project_id = $1 AND status NOT IN ('resolved', 'closed') GROUP BY severity`,
      [projectId],
    ),
    q.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status IN ('resolved', 'closed'))::int AS resolved,
              avg(extract(epoch FROM resolved_at - detected_at)) FILTER (WHERE resolved_at IS NOT NULL) / 60 AS mttr_minutes,
              avg(extract(epoch FROM acknowledged_at - detected_at)) FILTER (WHERE acknowledged_at IS NOT NULL) / 60 AS mtta_minutes,
              avg(extract(epoch FROM reported_at - detected_at)) / 60 AS avg_report_delay_minutes
       FROM incidents WHERE project_id = $1 AND detected_at >= $2`,
      p,
    ),
    q.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
              count(*) FILTER (WHERE status IN ('failed', 'rolled_back'))::int AS failed,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM incident_links l
                     WHERE l.target_type = 'deployment' AND l.target_id = d.id AND l.relation = 'confirmed'))::int AS caused_incident,
              count(*) FILTER (WHERE status IN ('failed', 'rolled_back') OR EXISTS (SELECT 1 FROM incident_links l
                     WHERE l.target_type = 'deployment' AND l.target_id = d.id AND l.relation = 'confirmed'))::int AS bad
       FROM deployments d
       WHERE project_id = $1 AND COALESCE(finished_at, started_at, status_at, created_at) >= $2`,
      p,
    ),
    q.query(
      `SELECT to_char((COALESCE(finished_at, started_at, status_at, created_at) AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
              count(*)::int AS total,
              count(*) FILTER (WHERE status IN ('failed', 'rolled_back'))::int AS failed
       FROM deployments WHERE project_id = $1 AND COALESCE(finished_at, started_at, status_at, created_at) >= $2
       GROUP BY 1 ORDER BY 1`,
      p,
    ),
    q.query(
      `SELECT to_char((detected_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day, count(*)::int AS total,
              count(*) FILTER (WHERE severity IN ('sev1', 'sev2'))::int AS major
       FROM incidents WHERE project_id = $1 AND detected_at >= $2 GROUP BY 1 ORDER BY 1`,
      p,
    ),
    q.query(
      `SELECT
         (SELECT count(*)::int FROM events WHERE project_id = $1 AND late) AS late_events,
         (SELECT count(*)::int FROM events WHERE project_id = $1 AND out_of_order) AS out_of_order_events,
         (SELECT COALESCE(sum(duplicate_count), 0)::int FROM events WHERE project_id = $1) AS duplicates_suppressed,
         (SELECT count(*)::int FROM deployments WHERE project_id = $1 AND jsonb_array_length(conflicts) > 0) AS conflicting_deployments,
         (SELECT count(*)::int FROM deployments WHERE project_id = $1
            AND (status = 'unknown' OR commit_sha IS NULL OR environment IS NULL
                 OR (finished_at IS NULL AND status NOT IN ('pending', 'in_progress')))) AS incomplete_deployments,
         (SELECT count(*)::int FROM events WHERE project_id = $1) AS total_events`,
      [projectId],
    ),
    q.query(
      `SELECT d.id, d.version, d.external_id, d.environment, count(*)::int AS incidents
       FROM incident_links l JOIN deployments d ON d.id = l.target_id
       WHERE l.target_type = 'deployment' AND l.relation = 'confirmed' AND d.project_id = $1
       GROUP BY d.id ORDER BY incidents DESC LIMIT 5`,
      [projectId],
    ),
    q.query(
      `SELECT i.id, i.number, i.title, i.severity, i.status, i.detected_at, u.name AS assignee_name
       FROM incidents i LEFT JOIN users u ON u.id = i.assignee_id
       WHERE i.project_id = $1 ORDER BY i.detected_at DESC LIMIT 8`,
      [projectId],
    ),
  ]);

  const ds = deployStats.rows[0];
  return {
    days,
    open_by_severity: Object.fromEntries(open.rows.map((r) => [r.severity, r.n])),
    open_total: open.rows.reduce((s, r) => s + r.n, 0),
    incidents: {
      ...incidentStats.rows[0],
      mttr_minutes: round(incidentStats.rows[0].mttr_minutes),
      mtta_minutes: round(incidentStats.rows[0].mtta_minutes),
      avg_report_delay_minutes: round(incidentStats.rows[0].avg_report_delay_minutes),
    },
    deployments: { ...ds, change_failure_rate: ds.total ? Math.round((ds.bad / ds.total) * 1000) / 10 : null },
    deploys_per_day: fillDays(deploysPerDay.rows, days, ['total', 'failed']),
    incidents_per_day: fillDays(incidentsPerDay.rows, days, ['total', 'major']),
    recurring: await recurringIssues(q, projectId, Math.max(days, 90)),
    data_quality: quality.rows[0],
    top_culprits: topCulprits.rows,
    recent_incidents: recent.rows,
  };
}

const round = (v: unknown) => (v == null ? null : Math.round(Number(v)));

function fillDays(rows: any[], days: number, keys: string[]) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = Math.min(days, 30) - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    const r = byDay.get(day);
    out.push({ day, ...Object.fromEntries(keys.map((k) => [k, r?.[k] ?? 0])) });
  }
  return out;
}

/**
 * Group incidents into recurring issues: same fingerprint OR (same service and title-token
 * Jaccard ≥ 0.5). Union-find over the last 500 incidents — cheap and catches rephrased titles
 * that an exact fingerprint would miss.
 */
export async function recurringIssues(q: Queryable, projectId: string, days = 90) {
  const { rows } = await q.query(
    `SELECT i.id, i.number, i.title, i.service, i.severity, i.status, i.fingerprint, i.signature, i.detected_at, i.resolved_at, i.resolution,
            (SELECT COALESCE(json_agg(json_build_object('type', l.target_type,
                      'kind', CASE WHEN l.target_type = 'change' THEN (SELECT c.kind FROM changes c WHERE c.id = l.target_id) END)), '[]')
               FROM incident_links l WHERE l.incident_id = i.id AND l.relation = 'confirmed') AS causes
     FROM incidents i WHERE i.project_id = $1 AND i.duplicate_of IS NULL
       AND i.detected_at > now() - make_interval(days => $2::int)
     ORDER BY i.detected_at DESC LIMIT 500`,
    [projectId, days],
  );
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const toks = rows.map((r) => tokens(r.title));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const sameService = (rows[i].service ?? '') === (rows[j].service ?? '');
      if (rows[i].fingerprint === rows[j].fingerprint || (sameService && jaccard(toks[i], toks[j]) >= 0.5)) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, any[]>();
  rows.forEach((r, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(r);
  });
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => {
      const resolved = g.filter((r) => r.resolved_at);
      const ttr = resolved.map((r) => (new Date(r.resolved_at).getTime() - new Date(r.detected_at).getTime()) / 60000).sort((a, b) => a - b);
      const causes = { deployment: 0, commit: 0, config: 0 };
      for (const r of g) {
        for (const c of r.causes as { type: string; kind: string | null }[]) {
          if (c.type === 'deployment') causes.deployment++;
          else if (c.kind === 'config') causes.config++;
          else causes.commit++;
        }
      }
      return {
        title: g[g.length - 1].title, // earliest occurrence's title
        service: g[0].service,
        signature: g.find((r) => r.signature)?.signature ?? normalizeSignature(g[g.length - 1].title),
        count: g.length,
        open: g.filter((r) => !['resolved', 'closed'].includes(r.status)).length,
        first_seen: g[g.length - 1].detected_at,
        last_seen: g[0].detected_at,
        resolved: resolved.length,
        median_resolve_minutes: ttr.length ? Math.round(ttr[Math.floor((ttr.length - 1) / 2)]) : null,
        confirmed_causes: causes,
        incidents: g.map((r) => ({ id: r.id, number: r.number, status: r.status, severity: r.severity, detected_at: r.detected_at })),
      };
    })
    .sort((a, b) => b.count - a.count || +new Date(b.last_seen) - +new Date(a.last_seen))
    .slice(0, 10);
}

export async function overview(q: Queryable) {
  const { rows } = await q.query(
    `SELECT p.id, p.name, p.slug, p.description, p.repo_url, p.default_environment, p.created_at,
       (SELECT count(*)::int FROM incidents i WHERE i.project_id = p.id AND i.status NOT IN ('resolved', 'closed')) AS open_incidents,
       (SELECT count(*)::int FROM incidents i WHERE i.project_id = p.id AND i.status NOT IN ('resolved', 'closed')
          AND i.severity IN ('sev1', 'sev2')) AS open_major,
       (SELECT count(*)::int FROM deployments d WHERE d.project_id = p.id
          AND COALESCE(d.finished_at, d.started_at, d.status_at, d.created_at) > now() - interval '7 days') AS deploys_7d,
       (SELECT min(i.severity) FROM incidents i WHERE i.project_id = p.id AND i.status NOT IN ('resolved', 'closed')) AS worst_open_severity,
       (SELECT row_to_json(x) FROM (SELECT d.number, d.version, d.external_id, d.status, d.environment,
                 COALESCE(d.finished_at, d.started_at, d.status_at, d.created_at) AS at
               FROM deployments d WHERE d.project_id = p.id
               ORDER BY COALESCE(d.finished_at, d.started_at, d.status_at, d.created_at) DESC LIMIT 1) x) AS last_deployment
     FROM projects p WHERE p.archived_at IS NULL ORDER BY p.name`,
  );
  return rows;
}
