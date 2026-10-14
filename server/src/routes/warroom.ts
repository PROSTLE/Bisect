import { Router } from 'express';
import { z } from 'zod';
import { isUuid, type Db } from '../db/index.js';
import { actorFromUser } from '../lib/audit.js';
import { hasRole, requireRole, safeEqual } from '../lib/auth.js';
import { HttpError, notFound, parse } from '../lib/errors.js';
import { presence } from '../lib/presence.js';
import { recurringIssues } from '../services/dashboard.js';
import { getIncident } from '../services/incidents.js';
import { MetricPoint, upsertMetrics } from '../services/metrics.js';
import { eventSources, incidentFeed, intake, ledger, overview, requestRollback, search, swimlanes } from '../services/warroom.js';
import { loadProject } from './projects.js';

const isoDate = z.string().datetime({ offset: true });

export function warroomRoutes(db: Db) {
  const r = Router();

  r.get('/projects/:projectId/overview', requireRole('viewer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    res.json({ ...(await overview(db, p.id)), presence: presence.forProject(p.id) });
  });

  r.get('/projects/:projectId/ledger', requireRole('viewer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 100);
    res.json({ rows: await ledger(db, p.id, limit) });
  });

  r.get('/projects/:projectId/swimlanes', requireRole('viewer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const { from, to } = parse(z.object({ from: isoDate, to: isoDate }), req.query);
    const f = new Date(from);
    const t = new Date(to);
    if (t <= f || t.getTime() - f.getTime() > 31 * 86400_000) throw new HttpError(400, 'bad_range', 'Range must be positive and at most 31 days');
    res.json(await swimlanes(db, p.id, f, t));
  });

  r.get('/projects/:projectId/recurring', requireRole('viewer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 365);
    res.json({ days, groups: await recurringIssues(db, p.id, days) });
  });

  r.get('/projects/:projectId/intake', requireRole('viewer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const { since } = parse(z.object({ since: isoDate }), req.query);
    res.json(await intake(db, p.id, new Date(since)));
  });

  r.get('/projects/:projectId/sources', requireRole('viewer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    res.json({ sources: await eventSources(db, p.id) });
  });

  // ---- metrics ------------------------------------------------------------------------------

  r.post('/projects/:projectId/metrics', async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const token = req.get('x-ingest-token');
    if (token ? !safeEqual(token, p.ingest_token) : !hasRole(req.user, 'engineer')) {
      throw new HttpError(401, 'unauthorized', 'Provide X-Ingest-Token or sign in as an engineer');
    }
    if (p.archived_at) throw new HttpError(409, 'archived', 'Project is archived');
    const { points } = parse(z.object({ points: z.array(MetricPoint).min(1).max(5000) }), req.body);
    res.status(201).json({ upserted: await upsertMetrics(db, p.id, points) });
  });

  r.get('/projects/:projectId/metrics', requireRole('viewer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const q = parse(z.object({ name: z.string().max(100).default('error_rate'), service: z.string().max(100).optional(), from: isoDate, to: isoDate }), req.query);
    const { rows } = await db.query(
      `SELECT service, at, value FROM metric_points WHERE project_id = $1 AND name = $2 AND ($3::text IS NULL OR service = $3)
         AND at BETWEEN $4::timestamptz AND $5::timestamptz ORDER BY service, at LIMIT 20000`,
      [p.id, q.name, q.service ?? null, q.from, q.to],
    );
    res.json({ points: rows });
  });

  // ---- incidents: feed, presence, rollback --------------------------------------------------

  r.get('/incidents/:id/feed', requireRole('viewer'), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Incident');
    res.json({ items: await incidentFeed(db, req.params.id) });
  });

  r.post('/incidents/:id/presence', requireRole('viewer'), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Incident');
    const inc = await getIncident(db, req.params.id);
    presence.heartbeat(inc.id, inc.project_id, req.user!);
    res.json({ viewers: presence.forProject(inc.project_id)[inc.id] ?? [] });
  });

  r.delete('/incidents/:id/presence', requireRole('viewer'), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Incident');
    presence.leave(req.params.id, req.user!.id);
    res.status(204).end();
  });

  r.post('/incidents/:id/rollback', requireRole('engineer'), async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Incident');
    const body = parse(z.object({ from_deployment_id: z.string().uuid(), target_deployment_id: z.string().uuid() }), req.body);
    const out = await requestRollback(db, req.params.id, body.from_deployment_id, body.target_deployment_id, actorFromUser(req.user));
    res.status(out.status === 'duplicate' ? 200 : 201).json(out);
  });

  // ---- search -------------------------------------------------------------------------------

  r.get('/search', requireRole('viewer'), async (req, res) => {
    const { q } = parse(z.object({ q: z.string().max(200).default('') }), req.query);
    res.json(await search(db, q));
  });

  return r;
}
