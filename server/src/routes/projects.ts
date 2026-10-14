import { Router, type Request } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { isUuid, type Db, type Queryable } from '../db/index.js';
import { actorFromUser, audit } from '../lib/audit.js';
import { hasRole, randomToken, requireRole, safeEqual } from '../lib/auth.js';
import { bus } from '../lib/bus.js';
import { HttpError, notFound, parse } from '../lib/errors.js';
import { overview, projectDashboard } from '../services/dashboard.js';
import { ingestEvents, type IngestContext } from '../services/ingest.js';

export async function loadProject(q: Queryable, id: unknown) {
  if (!isUuid(id)) throw notFound('Project');
  const { rows } = await q.query('SELECT * FROM projects WHERE id = $1', [id]);
  if (!rows[0]) throw notFound('Project');
  return rows[0];
}

/** Secrets are only shown to admins. */
export function presentProject(p: any, req: Request) {
  const { ingest_token, webhook_secret, ...rest } = p;
  return hasRole(req.user, 'admin') ? { ...rest, ingest_token, webhook_secret, webhook_url: webhookUrl(p.id, req) } : rest;
}

function webhookUrl(projectId: string, req: Request) {
  const origin = config.publicUrl || `${req.protocol}://${req.get('host')}`;
  return `${origin}/api/webhooks/github/${projectId}`;
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

const ProjectInput = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9-]+$/, 'lowercase letters, numbers and dashes only')
    .max(60)
    .optional(),
  description: z.string().max(2000).optional(),
  repo_url: z.string().url().max(500).nullish(),
  default_environment: z.string().trim().min(1).max(100).optional(),
});

export function projectRoutes(db: Db) {
  const r = Router();

  r.get('/projects', requireRole('viewer'), async (_req, res) => {
    res.json({ projects: await overview(db) });
  });

  r.post('/projects', requireRole('admin'), async (req, res) => {
    const body = parse(ProjectInput, req.body);
    const slug = body.slug ?? slugify(body.name);
    const project = await db.tx(async (q) => {
      const { rows: taken } = await q.query('SELECT 1 FROM projects WHERE slug = $1', [slug]);
      if (taken[0]) throw new HttpError(409, 'slug_taken', `A project with slug "${slug}" already exists`);
      const { rows } = await q.query(
        `INSERT INTO projects (name, slug, description, repo_url, default_environment, ingest_token, webhook_secret, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [body.name, slug, body.description ?? '', body.repo_url ?? null, body.default_environment ?? 'production', `ing_${randomToken()}`, randomToken(), req.user!.id],
      );
      await audit(q, actorFromUser(req.user), 'project.create', 'project', rows[0].id, rows[0].id, null, presentProject(rows[0], { user: undefined } as Request));
      return rows[0];
    });
    res.status(201).json({ project: presentProject(project, req) });
  });

  r.get('/projects/:projectId', requireRole('viewer'), async (req, res) => {
    res.json({ project: presentProject(await loadProject(db, req.params.projectId), req) });
  });

  r.patch('/projects/:projectId', requireRole('admin'), async (req, res) => {
    const body = parse(ProjectInput.partial(), req.body);
    const project = await db.tx(async (q) => {
      const before = await loadProject(q, req.params.projectId);
      const fields = Object.entries(body).filter(([, v]) => v !== undefined);
      if (!fields.length) return before;
      const { rows } = await q.query(
        `UPDATE projects SET ${fields.map(([k], i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
        [before.id, ...fields.map(([, v]) => v)],
      );
      await audit(q, actorFromUser(req.user), 'project.update', 'project', before.id, before.id, before, rows[0]);
      return rows[0];
    });
    bus.publish('project.updated', project.id, {});
    res.json({ project: presentProject(project, req) });
  });

  r.delete('/projects/:projectId', requireRole('admin'), async (req, res) => {
    await db.tx(async (q) => {
      const p = await loadProject(q, req.params.projectId);
      await q.query('UPDATE projects SET archived_at = now() WHERE id = $1', [p.id]);
      await audit(q, actorFromUser(req.user), 'project.archive', 'project', p.id, p.id);
    });
    res.status(204).end();
  });

  r.post('/projects/:projectId/rotate-secrets', requireRole('admin'), async (req, res) => {
    const project = await db.tx(async (q) => {
      const p = await loadProject(q, req.params.projectId);
      const { rows } = await q.query('UPDATE projects SET ingest_token = $2, webhook_secret = $3, updated_at = now() WHERE id = $1 RETURNING *', [
        p.id,
        `ing_${randomToken()}`,
        randomToken(),
      ]);
      await audit(q, actorFromUser(req.user), 'project.rotate_secrets', 'project', p.id, p.id);
      return rows[0];
    });
    res.json({ project: presentProject(project, req) });
  });

  r.get('/projects/:projectId/dashboard', requireRole('viewer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
    res.json(await projectDashboard(db, p.id, days));
  });

  r.get('/projects/:projectId/timeline', requireRole('viewer'), async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const query = parse(
      z.object({
        kinds: z.string().optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        incident_id: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(300),
        flags: z.enum(['late', 'out_of_order', 'duplicates', 'warnings']).optional(),
      }),
      req.query,
    );
    let { from, to } = query;
    let anchor = null;
    if (query.incident_id) {
      const { rows } = await db.query('SELECT id, number, title, detected_at FROM incidents WHERE id = $1 AND project_id = $2', [
        query.incident_id,
        p.id,
      ]);
      if (!rows[0]) throw notFound('Incident');
      anchor = rows[0];
      from ??= new Date(rows[0].detected_at.getTime() - 24 * 3600_000).toISOString();
      to ??= new Date(rows[0].detected_at.getTime() + 12 * 3600_000).toISOString();
    }
    const kinds = query.kinds?.split(',').filter((k) => ['deployment', 'change', 'incident'].includes(k));
    if (kinds && kinds.length === 0) {
      res.json({ events: [], anchor, from: from ?? null, to: to ?? null });
      return;
    }
    const flagSql = query.flags
      ? {
          late: 'AND e.late',
          out_of_order: 'AND e.out_of_order',
          duplicates: 'AND e.duplicate_count > 0',
          warnings: 'AND jsonb_array_length(e.warnings) > 0',
        }[query.flags]
      : '';
    const { rows } = await db.query(
      `SELECT e.id, e.kind, e.action, e.entity_id, e.summary, e.occurred_at, e.received_at, e.source, e.late, e.out_of_order,
              e.duplicate_count, e.last_duplicate_at, e.warnings, u.name AS actor_name,
              extract(epoch FROM e.received_at - e.occurred_at)::int AS delay_seconds
       FROM events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.project_id = $1
         AND ($2::text[] IS NULL OR e.kind = ANY($2::text[]))
         AND ($3::timestamptz IS NULL OR e.occurred_at >= $3::timestamptz)
         AND ($4::timestamptz IS NULL OR e.occurred_at <= $4::timestamptz)
         ${flagSql}
       ORDER BY e.occurred_at DESC, e.received_at DESC
       LIMIT $5`,
      [p.id, kinds?.length ? kinds : null, from ?? null, to ?? null, query.limit],
    );
    res.json({ events: rows, anchor, from: from ?? null, to: to ?? null });
  });

  /**
   * Generic ingestion endpoint for CI/CD pipelines, alerting tools and scripts.
   * Auth: a signed-in engineer, or the project's ingest token in X-Ingest-Token.
   */
  r.post('/projects/:projectId/events', async (req, res) => {
    const p = await loadProject(db, req.params.projectId);
    const token = req.get('x-ingest-token');
    let ctx: IngestContext;
    if (token) {
      if (!safeEqual(token, p.ingest_token)) throw new HttpError(401, 'invalid_token', 'Invalid ingest token');
      ctx = { projectId: p.id, source: 'api', actor: { user: null, label: 'ingest token' } };
      // Lets one token serve several integrations while keeping them apart in "event sources".
      const name = req.get('x-event-source')?.trim().slice(0, 40);
      if (name) ctx.sourceName = name;
    } else if (hasRole(req.user, 'engineer')) {
      ctx = { projectId: p.id, source: 'api', actor: actorFromUser(req.user) };
    } else {
      throw new HttpError(req.user ? 403 : 401, 'unauthorized', 'Provide X-Ingest-Token or sign in as an engineer');
    }
    if (p.archived_at) throw new HttpError(409, 'archived', 'Project is archived');
    const body = req.body;
    const events = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : body ? [body] : [];
    if (events.length === 0) throw new HttpError(400, 'no_events', 'Send an event object, an array, or { "events": [...] }');
    if (events.length > 500) throw new HttpError(413, 'too_many_events', 'At most 500 events per request');
    ctx.idempotencyKey = req.get('idempotency-key') ?? undefined;
    const results = await ingestEvents(db, ctx, events);
    const summary = results.reduce<Record<string, number>>((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {});
    res.status(results.some((r) => r.status === 'created' || r.status === 'updated') ? 201 : 200).json({ summary, results });
  });

  r.get('/audit', requireRole('admin'), async (req, res) => {
    const q = parse(
      z.object({
        project_id: z.string().uuid().optional(),
        entity_type: z.string().max(50).optional(),
        entity_id: z.string().max(100).optional(),
        before_id: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    const { rows } = await db.query(
      `SELECT a.*, p.name AS project_name FROM audit_log a LEFT JOIN projects p ON p.id = a.project_id
       WHERE ($1::uuid IS NULL OR a.project_id = $1) AND ($2::text IS NULL OR a.entity_type = $2)
         AND ($3::text IS NULL OR a.entity_id = $3) AND ($4::bigint IS NULL OR a.id < $4)
       ORDER BY a.id DESC LIMIT $5`,
      [q.project_id ?? null, q.entity_type ?? null, q.entity_id ?? null, q.before_id ?? null, q.limit],
    );
    res.json({ entries: rows });
  });

  return r;
}
