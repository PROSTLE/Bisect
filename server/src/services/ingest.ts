import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from '../config.js';
import { json, type Db, type Queryable } from '../db/index.js';
import { audit, type Actor } from '../lib/audit.js';
import { bus } from '../lib/bus.js';
import { HttpError, formatZod } from '../lib/errors.js';
import { addUpdate, createIncident, formatMinutes, getIncident, incLabel, type IncidentRow } from './incidents.js';

/*
 * Every fact about a project — from the UI, the REST API, CI scripts or GitHub — goes through
 * ingestEvents(). Inside one transaction per event we:
 *
 *   1. insert into the append-only `events` log keyed by a dedup key
 *        → an identical delivery hits the UNIQUE constraint and is counted, not re-applied
 *   2. flag the event as late (reported long after it happened) / out-of-order
 *   3. fold it into the materialised entity (deployment / change / incident) using
 *      *event time* rather than arrival time, so the final state does not depend on delivery order
 *   4. record any contradictions instead of silently overwriting data
 */

// ---- schemas ------------------------------------------------------------------------------

const DEPLOY_STATUS: Record<string, DeployStatus> = {
  pending: 'pending',
  queued: 'pending',
  waiting: 'pending',
  started: 'in_progress',
  in_progress: 'in_progress',
  running: 'in_progress',
  succeeded: 'succeeded',
  success: 'succeeded',
  successful: 'succeeded',
  completed: 'succeeded',
  deployed: 'succeeded',
  failed: 'failed',
  failure: 'failed',
  error: 'failed',
  errored: 'failed',
  rolled_back: 'rolled_back',
  rollback: 'rolled_back',
  reverted: 'rolled_back',
};
export type DeployStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'rolled_back';
const TERMINAL: DeployStatus[] = ['succeeded', 'failed', 'rolled_back'];

const iso = z.string().datetime({ offset: true });
/** Optional trimmed string; "" and null are treated as absent. */
const opt = (max = 500) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v == null || v.trim() === '' ? undefined : v.trim()));

const deployStatus = z
  .string()
  .transform((v, ctx) => {
    const s = DEPLOY_STATUS[v.toLowerCase().replace(/[\s-]/g, '_')];
    if (!s) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown deployment status "${v}"` });
      return z.NEVER;
    }
    return s;
  })
  .optional();

const base = {
  /** Caller-supplied unique id for this event (CI run step, webhook delivery…). Strongest dedup signal. */
  event_id: opt(200),
  occurred_at: iso.optional(),
};

export const DeploymentEvent = z.object({
  type: z.literal('deployment'),
  ...base,
  deployment_id: z.string().trim().min(1).max(200),
  status: deployStatus,
  version: opt(200),
  commit_sha: opt(64).transform((v) => v?.toLowerCase()),
  environment: opt(100),
  service: opt(100),
  deployed_by: opt(200),
  url: opt(1000),
  notes: opt(5000),
  started_at: iso.optional(),
  finished_at: iso.optional(),
  commits: z.array(z.string().trim().min(4).max(64)).max(1000).optional(),
});

export const ChangeEvent = z.object({
  type: z.literal('change'),
  ...base,
  sha: z
    .string()
    .trim()
    .min(4)
    .max(64)
    .transform((v) => v.toLowerCase()),
  message: opt(5000),
  author: opt(200),
  url: opt(1000),
  branch: opt(200),
  files: z.array(z.string().max(1000)).max(5000).optional(),
  deployment_id: opt(200),
  /** "config" = infrastructure/env change that may never get a deploy record (terraform, flags). */
  kind: z.enum(['commit', 'config']).default('commit'),
});

export const IncidentEvent = z.object({
  type: z.literal('incident'),
  ...base,
  alert_id: opt(200),
  title: z.string().trim().min(3).max(300),
  description: opt(10000),
  severity: z.enum(['sev1', 'sev2', 'sev3', 'sev4']).default('sev3'),
  service: opt(100),
  environment: opt(100),
  status: z.enum(['open', 'resolved']).default('open'),
  assignee_id: z.string().uuid().nullish(),
  error_signature: opt(500),
});

export const EventSchema = z.discriminatedUnion('type', [DeploymentEvent, ChangeEvent, IncidentEvent]);
export type IngestEvent = z.infer<typeof EventSchema>;

export interface IngestContext {
  projectId: string;
  source: 'ui' | 'api' | 'github';
  actor: Actor;
  /** Idempotency-Key header: makes a retried request a no-op. */
  idempotencyKey?: string;
  /** Override "now" — used by tests to replay history. Not reachable over HTTP. */
  receivedAt?: Date;
  /** Integration name shown to people: "GitHub webhooks", "Kubernetes", "PagerDuty"… */
  sourceName?: string;
}

const DEFAULT_SOURCE_NAME: Record<IngestContext['source'], string> = {
  ui: 'bisect UI',
  api: 'API',
  github: 'GitHub webhooks',
};

export interface IngestResult {
  index: number;
  status: 'created' | 'updated' | 'duplicate' | 'rejected';
  type?: string;
  event_id?: string;
  entity_id?: string | null;
  late?: boolean;
  out_of_order?: boolean;
  warnings?: string[];
  errors?: { path: string; message: string }[];
}

interface Applied {
  entityId: string;
  action: string;
  summary: string;
  status: 'created' | 'updated';
  warnings: string[];
  after?: () => void; // bus notifications to send after commit
}

// ---- dedup key ----------------------------------------------------------------------------

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as any)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Priority: explicit event_id  >  Idempotency-Key header  >  content hash.
 * When the event has no occurred_at, the content hash is bucketed into 10-minute windows so the
 * same payload sent twice in quick succession dedups, but a genuinely repeated event later does not.
 */
export function dedupKey(ev: IngestEvent, ctx: IngestContext, index: number, receivedAt: Date): string {
  if (ev.event_id) return `id:${ev.type}:${ev.event_id}`;
  if (ctx.idempotencyKey) return `idem:${ctx.idempotencyKey}:${index}`;
  const bucket = ev.occurred_at ? '' : `@${Math.floor(receivedAt.getTime() / 600_000)}`;
  return `hash:${crypto.createHash('sha256').update(stableStringify(ev) + bucket).digest('hex').slice(0, 32)}`;
}

// ---- entry point --------------------------------------------------------------------------

export async function ingestEvents(db: Db, ctx: IngestContext, raw: unknown[]): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = EventSchema.safeParse(raw[i]);
    if (!parsed.success) {
      results.push({ index: i, status: 'rejected', type: (raw[i] as any)?.type, errors: formatZod(parsed.error) });
      continue;
    }
    try {
      results.push(await ingestOne(db, ctx, parsed.data, i));
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      results.push({ index: i, status: 'rejected', type: parsed.data.type, errors: [{ path: '', message: err.message }] });
    }
  }
  return results;
}

async function ingestOne(db: Db, ctx: IngestContext, ev: IngestEvent, index: number): Promise<IngestResult> {
  const receivedAt = ctx.receivedAt ?? new Date();
  const occurredAt = ev.occurred_at ? new Date(ev.occurred_at) : receivedAt;
  const skewMs = occurredAt.getTime() - receivedAt.getTime();
  if (skewMs > 3600_000) throw new HttpError(422, 'future_event', 'occurred_at is more than 1 hour in the future (clock skew?)');

  const key = dedupKey(ev, ctx, index, receivedAt);
  const late = receivedAt.getTime() - occurredAt.getTime() > config.lateThresholdMinutes * 60_000;

  const out = await db.tx(async (q) => {
    const { rows } = await q.query<{ id: string; entity_id: string | null; duplicate_count: number }>(
      `INSERT INTO events (project_id, kind, action, occurred_at, received_at, source, dedup_key, actor_id, payload, late, source_name)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8::text::jsonb, $9, $10)
       ON CONFLICT (project_id, dedup_key)
       DO UPDATE SET duplicate_count = events.duplicate_count + 1, last_duplicate_at = EXCLUDED.received_at
       RETURNING id, entity_id, duplicate_count`,
      [
        ctx.projectId,
        ev.type,
        occurredAt.toISOString(),
        receivedAt.toISOString(),
        ctx.source,
        key,
        ctx.actor.user?.id ?? null,
        json(ev),
        late,
        ctx.sourceName ?? DEFAULT_SOURCE_NAME[ctx.source],
      ],
    );
    const row = rows[0];
    if (row.duplicate_count > 0) {
      return { result: { index, status: 'duplicate', type: ev.type, event_id: row.id, entity_id: row.entity_id } as IngestResult };
    }

    // Out of order = something that happened *later* was already recorded before this arrived.
    const { rows: ooo } = await q.query<{ x: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM events WHERE project_id = $1 AND id <> $2
                       AND occurred_at > $3::timestamptz + interval '1 minute') AS x`,
      [ctx.projectId, row.id, occurredAt.toISOString()],
    );
    const outOfOrder = ooo[0].x;

    const applied =
      ev.type === 'deployment'
        ? await applyDeployment(q, ctx, ev, occurredAt, late)
        : ev.type === 'change'
          ? await applyChange(q, ctx, ev, occurredAt)
          : await applyIncident(q, ctx, ev, occurredAt, receivedAt);

    await q.query(
      `UPDATE events SET entity_id = $2, action = $3, summary = $4, out_of_order = $5, warnings = $6::text::jsonb WHERE id = $1`,
      [row.id, applied.entityId, applied.action, applied.summary, outOfOrder, json(applied.warnings)],
    );
    return {
      applied,
      result: {
        index,
        status: applied.status,
        type: ev.type,
        event_id: row.id,
        entity_id: applied.entityId,
        late,
        out_of_order: outOfOrder,
        warnings: applied.warnings,
      } as IngestResult,
    };
  });

  if (out.applied) {
    out.applied.after?.();
    bus.publish('event.recorded', ctx.projectId, {
      kind: ev.type,
      action: out.applied.action,
      summary: out.applied.summary,
      entity_id: out.applied.entityId,
      late,
    });
  }
  return out.result;
}

// ---- deployments --------------------------------------------------------------------------

/**
 * Get-or-create the deployment row for an external id and lock it. New rows take the next
 * per-project deploy number; the advisory lock serialises concurrent first sightings of the same
 * deployment so numbers are never burned on a lost insert race.
 */
export async function ensureDeployment(q: Queryable, projectId: string, externalId: string, source: string) {
  await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`deploy:${projectId}:${externalId}`]);
  const { rows: existing } = await q.query('SELECT * FROM deployments WHERE project_id = $1 AND external_id = $2 FOR UPDATE', [
    projectId,
    externalId,
  ]);
  if (existing[0]) return { dep: existing[0], created: false };
  const { rows } = await q.query(
    `WITH seq AS (UPDATE projects SET deploy_seq = deploy_seq + 1 WHERE id = $1 RETURNING deploy_seq)
     INSERT INTO deployments (project_id, external_id, source, number)
     SELECT $1, $2, $3, deploy_seq FROM seq RETURNING *`,
    [projectId, externalId, source],
  );
  return { dep: rows[0], created: true };
}

async function applyDeployment(
  q: Queryable,
  ctx: IngestContext,
  ev: z.infer<typeof DeploymentEvent>,
  occurredAt: Date,
  late: boolean,
): Promise<Applied> {
  const { dep: cur, created } = await ensureDeployment(q, ctx.projectId, ev.deployment_id, ctx.source);
  const warnings: string[] = [];
  const set: Record<string, unknown> = {};
  const conflicts: unknown[] = [...cur.conflicts];

  // Descriptive fields: fill gaps; never overwrite a known value with a contradicting one.
  for (const f of ['version', 'commit_sha', 'environment', 'service', 'deployed_by', 'url'] as const) {
    const v = ev[f];
    if (v === undefined) continue;
    if (cur[f] == null) set[f] = v;
    else if (cur[f] !== v) {
      conflicts.push({ field: f, kept: cur[f], rejected: v, occurred_at: occurredAt.toISOString(), source: ctx.source });
      warnings.push(`Conflicting ${f}: kept "${cur[f]}", rejected "${v}"`);
    }
  }
  if (conflicts.length !== cur.conflicts.length) set.conflicts = conflicts;
  if (ev.notes) set.notes = cur.notes ? `${cur.notes}\n${ev.notes}` : ev.notes;

  // Timestamps: widest known interval wins regardless of arrival order.
  const start = ev.started_at ? new Date(ev.started_at) : ev.status && !TERMINAL.includes(ev.status) ? occurredAt : undefined;
  const finish = ev.finished_at ? new Date(ev.finished_at) : ev.status && TERMINAL.includes(ev.status) ? occurredAt : undefined;
  if (start && (!cur.started_at || start < cur.started_at)) set.started_at = start.toISOString();
  if (finish && (!cur.finished_at || finish > cur.finished_at)) set.finished_at = finish.toISOString();

  // Status: last-writer-wins by *event time*, so a late "started" cannot undo an earlier-arrived "succeeded".
  if (ev.status) {
    if (!cur.status_at || occurredAt >= cur.status_at) {
      set.status = ev.status;
      set.status_at = occurredAt.toISOString();
    } else {
      warnings.push(`Stale status "${ev.status}" ignored — current status "${cur.status}" is from a later event`);
    }
  }

  let dep = cur;
  const keys = Object.keys(set);
  if (keys.length) {
    const assignments = keys.map((k, i) => (k === 'conflicts' ? `${k} = $${i + 2}::text::jsonb` : `${k} = $${i + 2}`)).join(', ');
    const { rows } = await q.query(`UPDATE deployments SET ${assignments}, updated_at = now() WHERE id = $1 RETURNING *`, [
      cur.id,
      ...keys.map((k) => (k === 'conflicts' ? json(set[k]) : set[k])),
    ]);
    dep = rows[0];
  }
  if (dep.started_at && dep.finished_at && dep.finished_at < dep.started_at) {
    warnings.push('finished_at is earlier than started_at — check the source clocks');
  }

  // A commit_sha we just rejected as conflicting must not sneak in through the commit list.
  const headSha = ev.commit_sha && dep.commit_sha === ev.commit_sha ? [ev.commit_sha] : [];
  const shas = [...new Set([...(ev.commits ?? []).map((s) => s.toLowerCase()), ...headSha])];
  if (shas.length) {
    await q.query(`INSERT INTO deployment_commits (deployment_id, sha) SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [dep.id, shas]);
  }

  await audit(q, ctx.actor, created ? 'deployment.create' : 'deployment.merge', 'deployment', dep.id, ctx.projectId, created ? null : cur, dep);

  // A deployment we only just heard about may explain incidents that are already open.
  let after: (() => void) | undefined;
  const effective = dep.finished_at ?? dep.started_at ?? occurredAt;
  if (late && created) {
    const { rows: affected } = await q.query<IncidentRow>(
      `SELECT * FROM incidents WHERE project_id = $1 AND status NOT IN ('resolved', 'closed')
         AND detected_at BETWEEN $2::timestamptz AND $2::timestamptz + interval '6 hours'`,
      [ctx.projectId, new Date(effective).toISOString()],
    );
    for (const inc of affected) {
      const gap = Math.round((inc.detected_at.getTime() - new Date(effective).getTime()) / 60000);
      await addUpdate(
        q,
        inc.id,
        null,
        'system',
        `Late-arriving deployment #${dep.number}${dep.version ? ` (${dep.version})` : ''} was just recorded — it finished ${formatMinutes(gap)} before this incident was detected. Check the suspects list.`,
        { deployment_id: dep.id },
      );
    }
    if (affected.length) {
      after = () =>
        affected.forEach((inc) =>
          bus.publish('incident.suspect', ctx.projectId, { incident_id: inc.id, number: inc.number, deployment_id: dep.id }),
        );
    }
  }

  const label = `#${dep.number}${dep.version ? ` ${dep.version}` : ''}`;
  const statusText = ev.status ?? 'updated';
  return {
    entityId: dep.id,
    action: `deployment.${statusText}`,
    summary: `Deployment ${label}${dep.environment ? ` → ${dep.environment}` : ''}: ${statusText.replace('_', ' ')}`,
    status: created ? 'created' : 'updated',
    warnings,
    after,
  };
}

// ---- changes (commits) --------------------------------------------------------------------

async function applyChange(q: Queryable, ctx: IngestContext, ev: z.infer<typeof ChangeEvent>, occurredAt: Date): Promise<Applied> {
  const { rows: created } = await q.query(
    `INSERT INTO changes (project_id, sha, source, kind) VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, sha) DO NOTHING RETURNING id`,
    [ctx.projectId, ev.sha, ctx.source, ev.kind],
  );
  const { rows } = await q.query('SELECT * FROM changes WHERE project_id = $1 AND sha = $2 FOR UPDATE', [ctx.projectId, ev.sha]);
  const cur = rows[0];
  const warnings: string[] = [];
  const files = [...new Set([...(cur.files as string[]), ...(ev.files ?? [])])];
  const { rows: updated } = await q.query(
    `UPDATE changes SET message = CASE WHEN message = '' THEN COALESCE($2, '') ELSE message END,
            author = COALESCE(author, $3), url = COALESCE(url, $4), branch = COALESCE(branch, $5),
            committed_at = COALESCE(committed_at, $6), files = $7::text::jsonb
     WHERE id = $1 RETURNING *`,
    [cur.id, ev.message ?? null, ev.author ?? null, ev.url ?? null, ev.branch ?? null, occurredAt.toISOString(), json(files)],
  );
  const change = updated[0];

  if (ev.deployment_id) {
    // The deployment may not have been reported yet — create a placeholder that later events complete.
    const { dep, created: placeholder } = await ensureDeployment(q, ctx.projectId, ev.deployment_id, ctx.source);
    if (placeholder) warnings.push(`Deployment "${ev.deployment_id}" not seen yet — created an incomplete placeholder`);
    await q.query('INSERT INTO deployment_commits (deployment_id, sha) VALUES ($1, $2) ON CONFLICT DO NOTHING', [dep.id, ev.sha]);
  }
  if (created.length) await audit(q, ctx.actor, 'change.create', 'change', change.id, ctx.projectId, null, change);

  const firstLine = (change.message as string).split('\n')[0].slice(0, 120);
  return {
    entityId: change.id,
    action: change.kind === 'config' ? 'change.config' : 'change.recorded',
    summary: `${change.kind === 'config' ? 'Config change' : 'Commit'} ${ev.sha.slice(0, 7)}${firstLine ? `: ${firstLine}` : ''}${change.author ? ` (${change.author})` : ''}`,
    status: created.length ? 'created' : 'updated',
    warnings,
  };
}

// ---- incidents ----------------------------------------------------------------------------

async function applyIncident(
  q: Queryable,
  ctx: IngestContext,
  ev: z.infer<typeof IncidentEvent>,
  occurredAt: Date,
  receivedAt: Date,
): Promise<Applied> {
  const warnings: string[] = [];
  let existing: IncidentRow | undefined;
  if (ev.alert_id) {
    // Serialise concurrent deliveries for the same alert.
    await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${ctx.projectId}:${ev.alert_id}`]);
    const { rows } = await q.query<IncidentRow>('SELECT * FROM incidents WHERE project_id = $1 AND external_id = $2 FOR UPDATE', [
      ctx.projectId,
      ev.alert_id,
    ]);
    existing = rows[0];
  }

  if (!existing) {
    if (ev.assignee_id) {
      const { rows } = await q.query('SELECT 1 FROM users WHERE id = $1', [ev.assignee_id]);
      if (!rows[0]) throw new HttpError(422, 'invalid_assignee', 'Assignee does not exist');
    }
    const resolvedFirst = ev.status === 'resolved';
    if (resolvedFirst) warnings.push('Resolution arrived before the alert opened — detection time is provisional until the opening event arrives');
    const { incident, warnings: w } = await createIncident(
      q,
      {
        projectId: ctx.projectId,
        title: ev.title,
        description: ev.description,
        severity: ev.severity,
        service: ev.service,
        environment: ev.environment,
        detectedAt: occurredAt,
        reportedAt: receivedAt,
        externalId: ev.alert_id,
        assigneeId: ev.assignee_id,
        errorSignature: ev.error_signature,
        source: ctx.source,
        resolvedAt: resolvedFirst ? occurredAt : undefined,
      },
      ctx.actor,
    );
    warnings.push(...w);
    return {
      entityId: incident.id,
      action: resolvedFirst ? 'incident.resolved' : 'incident.opened',
      summary: `${incLabel(incident.number)} ${resolvedFirst ? 'resolved' : 'opened'} (${incident.severity}): ${incident.title}`,
      status: 'created',
      warnings,
      after: () => bus.publish('incident.updated', ctx.projectId, { incident_id: incident.id, number: incident.number, changed: ['*'], by: ctx.actor.label }),
    };
  }

  // Existing alert → merge.
  const set: Record<string, unknown> = {};
  const notes: string[] = [];
  let action = 'incident.refired';
  if (occurredAt < existing.detected_at) {
    set.detected_at = occurredAt.toISOString();
    notes.push(`Detection time moved earlier to ${occurredAt.toISOString()} by a late-arriving alert event`);
  }
  if (ev.status === 'resolved') {
    if (existing.status !== 'resolved' && existing.status !== 'closed') {
      set.status = 'resolved';
      set.resolved_at = occurredAt.toISOString();
      set.resolution = existing.resolution ?? 'Resolved by source alert';
      notes.push('Alert resolved at source');
      action = 'incident.resolved';
    } else {
      warnings.push('Incident already resolved');
      action = 'incident.updated';
    }
  } else if (existing.status === 'resolved' && occurredAt > (existing.resolved_at ?? existing.detected_at)) {
    set.status = 'investigating';
    set.resolved_at = null;
    notes.push('Alert fired again after resolution — incident reopened');
    action = 'incident.reopened';
  } else if (!set.detected_at) {
    notes.push(`Alert fired again at ${occurredAt.toISOString()}`);
  }
  if (Object.keys(set).length) {
    const keys = Object.keys(set);
    await q.query(
      `UPDATE incidents SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, version = version + 1, updated_at = now() WHERE id = $1`,
      [existing.id, ...keys.map((k) => set[k])],
    );
    await q.query(
      `INSERT INTO incident_revisions (incident_id, version, changed_fields, actor_id) VALUES ($1, $2, $3::text[], $4)`,
      [existing.id, existing.version + 1, keys, ctx.actor.user?.id ?? null],
    );
    await audit(q, ctx.actor, 'incident.merge', 'incident', existing.id, ctx.projectId, existing, { ...existing, ...set });
  }
  for (const n of notes) await addUpdate(q, existing.id, null, 'system', n);
  const inc = await getIncident(q, existing.id);
  return {
    entityId: inc.id,
    action,
    summary: `${incLabel(inc.number)} ${action.split('.')[1]}: ${inc.title}`,
    status: 'updated',
    warnings,
    after: () => bus.publish('incident.updated', ctx.projectId, { incident_id: inc.id, number: inc.number, changed: Object.keys(set), by: ctx.actor.label }),
  };
}
