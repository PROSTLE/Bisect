import crypto from 'node:crypto';
import { z } from 'zod';
import { json, type Db, type Queryable } from '../db/index.js';
import { audit, type Actor } from '../lib/audit.js';
import { bus } from '../lib/bus.js';
import { HttpError, notFound } from '../lib/errors.js';
import { computeFingerprint } from '../lib/fingerprint.js';

export const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'] as const;
export const STATUSES = ['open', 'investigating', 'identified', 'mitigating', 'monitoring', 'resolved', 'closed'] as const;
export type IncidentStatus = (typeof STATUSES)[number];
export const ACTIVE: IncidentStatus[] = ['open', 'investigating', 'identified', 'mitigating', 'monitoring'];

/** INC-007, INC-102 … */
export const incLabel = (n: number) => `INC-${String(n).padStart(3, '0')}`;

export interface IncidentRow {
  id: string;
  project_id: string;
  number: number;
  external_id: string | null;
  title: string;
  description: string;
  severity: string;
  status: IncidentStatus;
  service: string | null;
  environment: string | null;
  detected_at: Date;
  reported_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
  assignee_id: string | null;
  commander_id: string | null;
  rollback_owner_id: string | null;
  channel: string | null;
  runbook: string | null;
  root_cause: string | null;
  resolution: string | null;
  fingerprint: string;
  duplicate_of: string | null;
  version: number;
  created_by: string | null;
  source: string;
  created_at: Date;
  updated_at: Date;
  [key: string]: unknown;
}

export const INCIDENT_SELECT = `
  SELECT i.*, a.name AS assignee_name, c.name AS created_by_name, d.number AS duplicate_of_number,
         cm.name AS commander_name, ro.name AS rollback_owner_name
  FROM incidents i
  LEFT JOIN users a ON a.id = i.assignee_id
  LEFT JOIN users cm ON cm.id = i.commander_id
  LEFT JOIN users ro ON ro.id = i.rollback_owner_id
  LEFT JOIN users c ON c.id = i.created_by
  LEFT JOIN incidents d ON d.id = i.duplicate_of`;

export async function getIncident(q: Queryable, id: string, lock = false): Promise<IncidentRow> {
  const { rows } = lock
    ? await q.query<IncidentRow>('SELECT * FROM incidents WHERE id = $1 FOR UPDATE', [id])
    : await q.query<IncidentRow>(`${INCIDENT_SELECT} WHERE i.id = $1`, [id]);
  if (!rows[0]) throw notFound('Incident');
  return rows[0];
}

export async function addUpdate(
  q: Queryable,
  incidentId: string,
  authorId: string | null,
  kind: 'comment' | 'status' | 'field' | 'link' | 'system' | 'conflict',
  body: string,
  data: Record<string, unknown> = {},
  createdAt?: Date,
) {
  const { rows } = await q.query(
    `INSERT INTO incident_updates (incident_id, author_id, kind, body, data, created_at)
     VALUES ($1, $2, $3, $4, $5::text::jsonb, COALESCE($6::timestamptz, clock_timestamp())) RETURNING *`,
    [incidentId, authorId, kind, body, json(data), createdAt?.toISOString() ?? null],
  );
  return rows[0];
}

/** Timeline entries for things that happen *to* an incident after it was opened. */
export async function recordIncidentEvent(
  q: Queryable,
  incident: IncidentRow,
  action: string,
  summary: string,
  actor: Actor,
  occurredAt = new Date(),
) {
  await q.query(
    `INSERT INTO events (project_id, kind, action, entity_id, summary, occurred_at, received_at, source, source_name, dedup_key, actor_id)
     VALUES ($1, 'incident', $2, $3, $4, $5, now(), 'ui', 'bisect UI', $6, $7)`,
    [incident.project_id, action, incident.id, summary, occurredAt.toISOString(), `internal:${crypto.randomUUID()}`, actor.user?.id ?? null],
  );
}

// ---- creation -----------------------------------------------------------------------------

export interface NewIncident {
  projectId: string;
  title: string;
  description?: string;
  severity: string;
  service?: string;
  environment?: string;
  detectedAt: Date;
  reportedAt: Date;
  externalId?: string;
  assigneeId?: string | null;
  errorSignature?: string;
  source: string;
  resolvedAt?: Date;
}

export async function createIncident(q: Queryable, input: NewIncident, actor: Actor) {
  const warnings: string[] = [];
  const { rows: seq } = await q.query<{ incident_seq: number }>(
    'UPDATE projects SET incident_seq = incident_seq + 1 WHERE id = $1 RETURNING incident_seq',
    [input.projectId],
  );
  if (!seq[0]) throw notFound('Project');
  const fingerprint = computeFingerprint(input.service, input.errorSignature ?? input.title);
  const status: IncidentStatus = input.resolvedAt ? 'resolved' : 'open';
  const { rows } = await q.query<IncidentRow>(
    `INSERT INTO incidents (project_id, number, external_id, title, description, severity, status, service, environment,
                            detected_at, reported_at, resolved_at, assignee_id, fingerprint, created_by, source, resolution, signature)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [
      input.projectId,
      seq[0].incident_seq,
      input.externalId ?? null,
      input.title,
      input.description ?? '',
      input.severity,
      status,
      input.service ?? null,
      input.environment ?? null,
      input.detectedAt.toISOString(),
      input.reportedAt.toISOString(),
      input.resolvedAt?.toISOString() ?? null,
      input.assigneeId ?? null,
      fingerprint,
      actor.user?.id ?? null,
      input.source,
      input.resolvedAt ? 'Resolved by source alert' : null,
      input.errorSignature ?? null,
    ],
  );
  const incident = rows[0];
  await q.query(`INSERT INTO incident_revisions (incident_id, version, changed_fields, actor_id) VALUES ($1, 1, $2::text[], $3)`, [
    incident.id,
    ['*'],
    actor.user?.id ?? null,
  ]);
  const delayMin = Math.round((input.reportedAt.getTime() - input.detectedAt.getTime()) / 60000);
  await addUpdate(
    q,
    incident.id,
    actor.user?.id ?? null,
    'system',
    `Incident opened via ${input.source} (${input.severity})` + (delayMin > 5 ? ` — reported ${formatMinutes(delayMin)} after detection` : ''),
    {},
    input.reportedAt,
  );

  // Soft duplicate detection: same fingerprint, still active, detected within 24h of this one.
  const { rows: dupes } = await q.query<{ id: string; number: number }>(
    `SELECT id, number FROM incidents
     WHERE project_id = $1 AND fingerprint = $2 AND id <> $3 AND status NOT IN ('resolved', 'closed')
       AND detected_at BETWEEN $4::timestamptz - interval '24 hours' AND $4::timestamptz + interval '24 hours'
     ORDER BY detected_at LIMIT 1`,
    [input.projectId, fingerprint, incident.id, input.detectedAt.toISOString()],
  );
  if (dupes[0]) {
    warnings.push(`Possible duplicate of ${incLabel(dupes[0].number)}`);
    await addUpdate(q, incident.id, null, 'system', `Looks like a duplicate of ${incLabel(dupes[0].number)} (same error fingerprint, still open).`, {
      possible_duplicate_of: dupes[0].id,
      possible_duplicate_number: dupes[0].number,
    }, input.reportedAt);
  }
  await audit(q, actor, 'incident.create', 'incident', incident.id, input.projectId, null, incident);
  return { incident, warnings, possibleDuplicateOf: dupes[0] ?? null };
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ${min % 60}m`;
  return `${Math.round(min / 1440)}d`;
}

// ---- updates with optimistic concurrency --------------------------------------------------

/**
 * A rejected concurrent edit is still somebody's intent. When an update fails with an edit
 * conflict, write it to the activity feed (outside the failed transaction) so the team can compare
 * both values and adopt the rejected one with a click.
 */
async function keepRejectedEdits<T>(db: Db, incidentId: string, baseVersion: number, actor: Actor, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof HttpError && err.code === 'edit_conflict') {
      const details = err.details as { conflicts: ConflictDetail[]; current_version: number };
      const fields = details.conflicts.map((c) => c.field.replace('_id', '').replace('_', ' '));
      const update = await addUpdate(
        db,
        incidentId,
        actor.user?.id ?? null,
        'conflict',
        `Concurrent edits to ${fields.join(', ')}`,
        { conflicts: details.conflicts, base_version: baseVersion, current_version: details.current_version, rejected_by: actor.user?.name ?? actor.label },
      );
      const inc = await getIncident(db, incidentId);
      bus.publish('incident.updated', inc.project_id, {
        incident_id: incidentId,
        number: inc.number,
        changed: ['conflict'],
        by: actor.user?.name ?? actor.label,
        update_id: update.id,
      });
    }
    throw err;
  }
}

const nullableText = (max: number) =>
  z
    .string()
    .max(max)
    .nullable()
    .transform((v) => (v === null || v.trim() === '' ? null : v.trim()));

export const IncidentPatch = z
  .object({
    title: z.string().trim().min(3).max(300),
    description: z.string().max(10000),
    severity: z.enum(SEVERITIES),
    status: z.enum(STATUSES),
    service: nullableText(100),
    environment: nullableText(100),
    assignee_id: z.string().uuid().nullable(),
    commander_id: z.string().uuid().nullable(),
    rollback_owner_id: z.string().uuid().nullable(),
    channel: nullableText(100),
    runbook: nullableText(500),
    root_cause: nullableText(10000),
    resolution: nullableText(10000),
    detected_at: z.string().datetime({ offset: true }),
    duplicate_of: z.string().uuid().nullable(),
  })
  .partial()
  .strict();
export type IncidentPatch = z.infer<typeof IncidentPatch>;

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    const ta = a == null ? null : new Date(a as string).getTime();
    const tb = b == null ? null : new Date(b as string).getTime();
    return ta === tb;
  }
  return (a ?? null) === (b ?? null);
}

function serialize(v: unknown) {
  return v instanceof Date ? v.toISOString() : v;
}

function checkTransition(from: IncidentStatus, to: IncidentStatus, duplicateOf: string | null) {
  if (from === to) return;
  const ok =
    (ACTIVE.includes(from) && (ACTIVE.includes(to) || to === 'resolved')) ||
    (ACTIVE.includes(from) && to === 'closed' && duplicateOf) ||
    (from === 'resolved' && (to === 'closed' || ACTIVE.includes(to))) ||
    (from === 'closed' && ACTIVE.includes(to));
  if (!ok) {
    throw new HttpError(
      422,
      'invalid_transition',
      to === 'closed' ? 'Resolve the incident before closing it (or mark it as a duplicate).' : `Cannot move from ${from} to ${to}`,
    );
  }
}

export interface ConflictDetail {
  field: string;
  yours: unknown;
  theirs: unknown;
  changed_by: string[];
}

/**
 * Apply a partial update made against `baseVersion`.
 *
 *  - Row is locked (SELECT … FOR UPDATE) so concurrent writers serialise — no lost updates.
 *  - If someone else saved in between, we look at which fields *they* changed (incident_revisions).
 *    Disjoint field sets are merged automatically; overlapping fields with different values → 409
 *    with both values so the client can resolve the conflict explicitly.
 */
export async function updateIncident(db: Db, incidentId: string, baseVersion: number, patch: IncidentPatch, actor: Actor) {
  const result = await keepRejectedEdits(db, incidentId, baseVersion, actor, () => db.tx(async (q) => {
    const cur = await getIncident(q, incidentId, true);
    const requested = Object.entries(patch).filter(([k, v]) => !sameValue(cur[k], v)) as [keyof IncidentPatch & string, unknown][];
    if (requested.length === 0) return { incident: cur, merged: false, changed: [] as string[], noop: true };

    let merged = false;
    if (baseVersion !== cur.version) {
      if (baseVersion > cur.version) throw new HttpError(409, 'stale_version', 'Unknown version — reload the incident');
      const { rows: revs } = await q.query<{ changed_fields: string[]; actor_name: string | null }>(
        `SELECT r.changed_fields, u.name AS actor_name FROM incident_revisions r LEFT JOIN users u ON u.id = r.actor_id
         WHERE r.incident_id = $1 AND r.version > $2`,
        [incidentId, baseVersion],
      );
      const changedBy = new Map<string, Set<string>>();
      for (const r of revs) {
        for (const f of r.changed_fields) {
          if (!changedBy.has(f)) changedBy.set(f, new Set());
          changedBy.get(f)!.add(r.actor_name ?? 'automation');
        }
      }
      const conflicts: ConflictDetail[] = requested
        .filter(([f]) => changedBy.has(f) || changedBy.has('*'))
        .map(([f, v]) => ({ field: f, yours: v, theirs: serialize(cur[f]), changed_by: [...(changedBy.get(f) ?? changedBy.get('*') ?? [])] }));
      if (conflicts.length > 0) {
        throw new HttpError(409, 'edit_conflict', 'Someone else changed the same fields since you loaded this incident', {
          conflicts,
          current_version: cur.version,
        });
      }
      merged = true;
    }

    const next: Record<string, unknown> = Object.fromEntries(requested);
    const newStatus = (next.status as IncidentStatus | undefined) ?? cur.status;
    const duplicateOf = 'duplicate_of' in next ? (next.duplicate_of as string | null) : cur.duplicate_of;
    if (next.status) checkTransition(cur.status, newStatus, duplicateOf);

    if (duplicateOf && 'duplicate_of' in next) {
      if (duplicateOf === cur.id) throw new HttpError(422, 'invalid_duplicate', 'An incident cannot duplicate itself');
      const { rows } = await q.query('SELECT 1 FROM incidents WHERE id = $1 AND project_id = $2', [duplicateOf, cur.project_id]);
      if (!rows[0]) throw new HttpError(422, 'invalid_duplicate', 'Duplicate target must be an incident in the same project');
    }
    for (const f of ['assignee_id', 'commander_id', 'rollback_owner_id'] as const) {
      if (!(f in next) || !next[f]) continue;
      const { rows } = await q.query('SELECT 1 FROM users WHERE id = $1', [next[f]]);
      if (!rows[0]) throw new HttpError(422, 'invalid_user', `${f.replace('_id', '').replace('_', ' ')} does not exist`);
    }

    // Derived fields
    if (next.status) {
      if (newStatus !== 'open' && ACTIVE.includes(newStatus) && !cur.acknowledged_at) next.acknowledged_at = new Date().toISOString();
      if (newStatus === 'resolved' && !cur.resolved_at) next.resolved_at = new Date().toISOString();
      if (ACTIVE.includes(newStatus) && cur.resolved_at) next.resolved_at = null; // reopened
      const resolution = 'resolution' in next ? next.resolution : cur.resolution;
      if (newStatus === 'resolved' && !resolution) {
        throw new HttpError(422, 'resolution_required', 'Add resolution details before resolving the incident');
      }
    }
    if ('title' in next || 'service' in next) {
      // Same basis as createIncident: an alert's error signature outranks its (editable) title.
      const service = 'service' in next ? (next.service as string | null) : cur.service;
      const basis = (cur.signature as string | null) ?? ((next.title as string | undefined) ?? cur.title);
      next.fingerprint = computeFingerprint(service, basis);
    }

    const fields = Object.keys(next);
    const assignments = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
    const { rows } = await q.query<IncidentRow>(
      `UPDATE incidents SET ${assignments}, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [incidentId, ...fields.map((f) => next[f])],
    );
    const updated = rows[0];
    await q.query(`INSERT INTO incident_revisions (incident_id, version, changed_fields, actor_id) VALUES ($1, $2, $3::text[], $4)`, [
      incidentId,
      updated.version,
      fields,
      actor.user?.id ?? null,
    ]);

    const actorId = actor.user?.id ?? null;
    if (next.status) {
      await addUpdate(q, incidentId, actorId, 'status', `Status changed: ${cur.status} → ${newStatus}`, { from: cur.status, to: newStatus });
      await recordIncidentEvent(q, updated, `incident.${newStatus}`, `${incLabel(updated.number)} ${newStatus}: ${updated.title}`, actor);
    }
    const fieldChanges = requested
      .filter(([f]) => f !== 'status')
      .map(([f, v]) => ({ field: f, from: serialize(cur[f]), to: serialize(v) }));
    if (fieldChanges.length) {
      await addUpdate(q, incidentId, actorId, 'field', `Updated ${fieldChanges.map((c) => c.field.replace('_id', '')).join(', ')}`, {
        changes: fieldChanges,
      });
    }
    await audit(q, actor, 'incident.update', 'incident', incidentId, cur.project_id, cur, updated);
    return { incident: updated, merged, changed: fields, noop: false };
  }));

  if (!result.noop) {
    bus.publish('incident.updated', result.incident.project_id, {
      incident_id: incidentId,
      number: result.incident.number,
      version: result.incident.version,
      changed: result.changed,
      by: actor.user?.name ?? actor.label,
    });
  }
  return { incident: await getIncident(db, incidentId), merged: result.merged };
}

// ---- comments & links ---------------------------------------------------------------------

export async function addComment(db: Db, incidentId: string, body: string, actor: Actor) {
  const inc = await getIncident(db, incidentId);
  const update = await db.tx(async (q) => {
    const u = await addUpdate(q, incidentId, actor.user?.id ?? null, 'comment', body);
    await audit(q, actor, 'incident.comment', 'incident', incidentId, inc.project_id, null, { body });
    return u;
  });
  bus.publish('incident.comment', inc.project_id, { incident_id: incidentId, number: inc.number, by: actor.user?.name ?? actor.label });
  return update;
}

export const LinkInput = z.object({
  target_type: z.enum(['deployment', 'change']),
  target_id: z.string().uuid(),
  relation: z.enum(['suspected', 'confirmed', 'ruled_out']),
  note: z.string().max(2000).optional(),
  score: z.number().min(0).max(1).optional(),
});

export async function setLink(db: Db, incidentId: string, input: z.infer<typeof LinkInput>, actor: Actor) {
  const out = await db.tx(async (q) => {
    const inc = await getIncident(q, incidentId);
    const table = input.target_type === 'deployment' ? 'deployments' : 'changes';
    const label = input.target_type === 'deployment' ? `'#' || number::text` : `substr(sha, 1, 7)`;
    const { rows: targets } = await q.query<{ label: string }>(`SELECT ${label} AS label FROM ${table} WHERE id = $1 AND project_id = $2`, [
      input.target_id,
      inc.project_id,
    ]);
    if (!targets[0]) throw new HttpError(422, 'invalid_target', `${input.target_type} not found in this project`);
    const { rows: prev } = await q.query('SELECT * FROM incident_links WHERE incident_id = $1 AND target_type = $2 AND target_id = $3', [
      incidentId,
      input.target_type,
      input.target_id,
    ]);
    const { rows } = await q.query(
      `INSERT INTO incident_links (incident_id, target_type, target_id, relation, note, score, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (incident_id, target_type, target_id)
       DO UPDATE SET relation = EXCLUDED.relation, note = COALESCE(EXCLUDED.note, incident_links.note),
                     score = COALESCE(EXCLUDED.score, incident_links.score), updated_at = now()
       RETURNING *`,
      [incidentId, input.target_type, input.target_id, input.relation, input.note ?? null, input.score ?? null, actor.user?.id ?? null],
    );
    const verb = { suspected: 'flagged as a suspect', confirmed: 'confirmed as the cause', ruled_out: 'ruled out' }[input.relation];
    const what = `${input.target_type === 'deployment' ? 'Deployment' : 'Commit'} ${targets[0].label}`;
    await addUpdate(q, incidentId, actor.user?.id ?? null, 'link', `${what} ${verb}${input.note ? `: ${input.note}` : ''}`, {
      target_type: input.target_type,
      target_id: input.target_id,
      relation: input.relation,
    });
    if (input.relation === 'confirmed') {
      await recordIncidentEvent(q, inc, 'incident.cause_confirmed', `${what} confirmed as cause of ${incLabel(inc.number)}`, actor);
    }
    await audit(q, actor, 'incident.link', 'incident', incidentId, inc.project_id, prev[0] ?? null, rows[0]);
    return { link: rows[0], inc };
  });
  bus.publish('incident.updated', out.inc.project_id, {
    incident_id: incidentId,
    number: out.inc.number,
    changed: ['links'],
    by: actor.user?.name ?? actor.label,
  });
  return out.link;
}

export async function removeLink(db: Db, incidentId: string, targetType: string, targetId: string, actor: Actor) {
  const inc = await getIncident(db, incidentId);
  await db.tx(async (q) => {
    const { rows } = await q.query('DELETE FROM incident_links WHERE incident_id = $1 AND target_type = $2 AND target_id = $3 RETURNING *', [
      incidentId,
      targetType,
      targetId,
    ]);
    if (!rows[0]) throw notFound('Link');
    await addUpdate(q, incidentId, actor.user?.id ?? null, 'link', `Removed ${targetType} link`, { target_type: targetType, target_id: targetId, relation: null });
    await audit(q, actor, 'incident.unlink', 'incident', incidentId, inc.project_id, rows[0], null);
  });
  bus.publish('incident.updated', inc.project_id, { incident_id: incidentId, number: inc.number, changed: ['links'], by: actor.user?.name ?? actor.label });
}
