import { Router, type Request } from 'express';
import { z } from 'zod';
import { isUuid, type Db } from '../db/index.js';
import { actorFromUser } from '../lib/audit.js';
import { requireRole } from '../lib/auth.js';
import { HttpError, notFound, parse } from '../lib/errors.js';
import { ingestEvents, type IngestResult } from '../services/ingest.js';
import { INCIDENT_SELECT, IncidentPatch, LinkInput, SEVERITIES, STATUSES, addComment, getIncident, removeLink, setLink, updateIncident } from '../services/incidents.js';
import { findSuspects, similarIncidents } from '../services/suspects.js';
import { loadProject } from './projects.js';

/** Which fields a deployment record is still missing — surfaced in the UI as "incomplete". */
export function deploymentGaps(d: any): string[] {
  const gaps: string[] = [];
  if (d.status === 'unknown') gaps.push('status');
  if (!d.commit_sha && !(d.commit_count > 0)) gaps.push('commit');
  if (!d.environment) gaps.push('environment');
  if (!d.started_at && !d.finished_at) gaps.push('timestamps');
  else if (!d.finished_at && !['pending', 'in_progress'].includes(d.status)) gaps.push('finish time');
  return gaps;
}

const DEPLOY_SELECT = `
  SELECT d.*, COALESCE(d.finished_at, d.started_at, d.status_at, d.created_at) AS effective_at,
    (SELECT count(*)::int FROM deployment_commits dc WHERE dc.deployment_id = d.id) AS commit_count,
    (SELECT count(*)::int FROM incident_links l WHERE l.target_type = 'deployment' AND l.target_id = d.id AND l.relation = 'confirmed') AS confirmed_incidents,
    (SELECT count(*)::int FROM incident_links l WHERE l.target_type = 'deployment' AND l.target_id = d.id AND l.relation = 'suspected') AS suspected_incidents
  FROM deployments d`;

/** UI forms go through the same ingestion pipeline as CI and webhooks. */
async function ingestSingle(db: Db, req: Request, project: { id: string; archived_at: Date | null }, event: Record<string, unknown>): Promise<IngestResult> {
  // Same rule as the ingestion API, metrics and webhooks: an archived project accepts no new events.
  if (project.archived_at) throw new HttpError(409, 'archived', 'Project is archived');
  const [result] = await ingestEvents(
    db,
    { projectId: project.id, source: 'ui', actor: actorFromUser(req.user), idempotencyKey: req.get('idempotency-key') ?? undefined },
    [event],
  );
  if (result.status === 'rejected') throw new HttpError(400, 'validation_error', 'Invalid request', result.errors);
  return result;
}

export function recordRoutes(db: Db) {
  const r = Router();

  // ---- deployments --------------------------------------------------------------------

  r.get('/projects/:projectId/deployments', requireRole('viewer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const q = parse(
      z.object({
        status: z.string().optional(),
        environment: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    const { rows } = await db.query(
      `${DEPLOY_SELECT}
       WHERE d.project_id = $1 AND ($2::text IS NULL OR d.status = $2) AND ($3::text IS NULL OR d.environment = $3)
       ORDER BY effective_at DESC LIMIT $4`,
      [p.id, q.status ?? null, q.environment ?? null, q.limit],
    );
    const { rows: envs } = await db.query(
      'SELECT DISTINCT environment FROM deployments WHERE project_id = $1 AND environment IS NOT NULL ORDER BY 1',
      [p.id],
    );
    res.json({ deployments: rows.map((d) => ({ ...d, gaps: deploymentGaps(d) })), environments: envs.map((e) => e.environment) });
  });

  r.post('/projects/:projectId/deployments', requireRole('engineer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const body = { environment: p.default_environment, ...req.body, type: 'deployment' };
    if (!body.deployment_id) body.deployment_id = `manual-${Date.now().toString(36)}`;
    const result = await ingestSingle(db, req, p, body);
    res.status(result.status === 'duplicate' ? 200 : 201).json(result);
  });

  r.get('/deployments/:id', requireRole('viewer'), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Deployment');
    const { rows } = await db.query(`${DEPLOY_SELECT} WHERE d.id = $1`, [req.params.id]);
    const d = rows[0];
    if (!d) throw notFound('Deployment');
    const [commits, events, incidents] = await Promise.all([
      db.query(
        `SELECT dc.sha, c.id, c.message, c.author, c.url, c.files, c.committed_at FROM deployment_commits dc
         LEFT JOIN changes c ON c.project_id = $2 AND c.sha = dc.sha
         WHERE dc.deployment_id = $1 ORDER BY c.committed_at DESC NULLS LAST`,
        [d.id, d.project_id],
      ),
      db.query(
        `SELECT id, action, summary, occurred_at, received_at, source, late, out_of_order, duplicate_count, warnings, payload
         FROM events WHERE entity_id = $1 ORDER BY occurred_at, received_at`,
        [d.id],
      ),
      db.query(
        `SELECT i.id, i.number, i.title, i.severity, i.status, l.relation FROM incident_links l
         JOIN incidents i ON i.id = l.incident_id WHERE l.target_type = 'deployment' AND l.target_id = $1`,
        [d.id],
      ),
    ]);
    res.json({ deployment: { ...d, gaps: deploymentGaps(d) }, commits: commits.rows, events: events.rows, incidents: incidents.rows });
  });

  // ---- changes ------------------------------------------------------------------------

  r.get('/projects/:projectId/changes', requireRole('viewer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const { rows } = await db.query(
      `SELECT c.*,
         (SELECT COALESCE(json_agg(json_build_object('id', d.id, 'number', d.number, 'label', '#' || d.number::text, 'environment', d.environment, 'status', d.status)), '[]')
          FROM deployment_commits dc JOIN deployments d ON d.id = dc.deployment_id WHERE dc.sha = c.sha AND d.project_id = c.project_id) AS deployments
       FROM changes c WHERE c.project_id = $1 ORDER BY c.committed_at DESC NULLS LAST LIMIT $2`,
      [p.id, limit],
    );
    res.json({ changes: rows });
  });

  r.post('/projects/:projectId/changes', requireRole('engineer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const result = await ingestSingle(db, req, p, { ...req.body, type: 'change' });
    res.status(result.status === 'duplicate' ? 200 : 201).json(result);
  });

  // ---- incidents ----------------------------------------------------------------------

  r.get('/projects/:projectId/incidents', requireRole('viewer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const q = parse(
      z.object({
        status: z.enum(['active', 'all', ...STATUSES]).default('all'),
        severity: z.enum(SEVERITIES).optional(),
        assignee_id: z.string().uuid().optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      }),
      req.query,
    );
    const statusFilter = q.status === 'active' ? `AND i.status NOT IN ('resolved', 'closed')` : q.status === 'all' ? '' : `AND i.status = '${q.status}'`;
    const { rows } = await db.query(
      `${INCIDENT_SELECT}
       WHERE i.project_id = $1 ${statusFilter}
         AND ($2::text IS NULL OR i.severity = $2) AND ($3::uuid IS NULL OR i.assignee_id = $3)
         AND ($4::text IS NULL OR i.title ILIKE '%' || $4 || '%' OR i.description ILIKE '%' || $4 || '%')
       ORDER BY (i.status IN ('resolved', 'closed')), i.detected_at DESC LIMIT $5`,
      [p.id, q.severity ?? null, q.assignee_id ?? null, q.q ?? null, q.limit],
    );
    res.json({ incidents: rows });
  });

  r.post('/projects/:projectId/incidents', requireRole('engineer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const { detected_at, ...rest } = req.body ?? {};
    const result = await ingestSingle(db, req, p, { environment: p.default_environment, ...rest, occurred_at: detected_at, type: 'incident' });
    res.status(result.status === 'duplicate' ? 200 : 201).json(result);
  });

  r.get('/incidents/:id', requireRole('viewer'), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Incident');
    const incident = await getIncident(db, req.params.id);
    const [updates, links] = await Promise.all([
      db.query(
        `SELECT u.*, a.name AS author_name FROM incident_updates u LEFT JOIN users a ON a.id = u.author_id
         WHERE u.incident_id = $1 ORDER BY u.created_at`,
        [incident.id],
      ),
      db.query(
        `SELECT l.*, u.name AS created_by_name,
           CASE WHEN l.target_type = 'deployment'
                THEN (SELECT '#' || number::text || COALESCE(' ' || version, '') || COALESCE(' → ' || environment, '') FROM deployments WHERE id = l.target_id)
                ELSE (SELECT substr(sha, 1, 7) || ' ' || split_part(message, E'\\n', 1) FROM changes WHERE id = l.target_id) END AS target_label
         FROM incident_links l LEFT JOIN users u ON u.id = l.created_by
         WHERE l.incident_id = $1 ORDER BY l.created_at`,
        [incident.id],
      ),
    ]);
    res.json({ incident, updates: updates.rows, links: links.rows });
  });

  r.patch('/incidents/:id', requireRole('engineer'), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Incident');
    const { version, ...fields } = req.body ?? {};
    const baseVersion = parse(z.number().int().min(1, 'version is required for optimistic concurrency'), version);
    const patch = parse(IncidentPatch, fields);
    res.json(await updateIncident(db, req.params.id, baseVersion, patch, actorFromUser(req.user)));
  });

  r.post('/incidents/:id/comments', requireRole('engineer'), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Incident');
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(10000) }), req.body);
    res.status(201).json({ update: await addComment(db, req.params.id, body, actorFromUser(req.user)) });
  });

  r.put('/incidents/:id/links', requireRole('engineer'), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Incident');
    res.json({ link: await setLink(db, req.params.id, parse(LinkInput, req.body), actorFromUser(req.user)) });
  });

  r.delete('/incidents/:id/links/:type/:targetId', requireRole('engineer'), async (req, res) => {
    if (!isUuid(req.params.id) || !isUuid(req.params.targetId)) throw notFound('Link');
    await removeLink(db, req.params.id, String(req.params.type), req.params.targetId, actorFromUser(req.user));
    res.status(204).end();
  });

  r.get('/incidents/:id/suspects', requireRole('viewer'), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Incident');
    const { suspects, changes, signal } = await findSuspects(db, req.params.id);
    res.json({
      suspects: suspects.map((s) => ({ ...s, deployment: { ...s.deployment, gaps: deploymentGaps({ ...s.deployment, commit_count: s.commits.length }) } })),
      changes,
      signal,
    });
  });

  r.get('/incidents/:id/similar', requireRole('viewer'), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Incident');
    res.json({ incidents: await similarIncidents(db, req.params.id) });
  });

  return r;
}
