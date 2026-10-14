import { json, type Queryable } from '../db/index.js';
import type { AuthUser } from './auth.js';

export interface Actor {
  user?: AuthUser | null;
  /** Human-readable label for non-user actors: "github webhook", "ingest token". */
  label: string;
}

export const actorFromUser = (user: AuthUser | undefined, fallback = 'anonymous'): Actor => ({
  user: user ?? null,
  label: user ? user.email : fallback,
});

/** Keep only the keys that actually changed, so audit rows stay readable. */
export function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  if (!before || !after) return { before, after };
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === 'updated_at' || key === 'version') continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: b, after: a };
}

export async function audit(
  q: Queryable,
  actor: Actor,
  action: string,
  entityType: string,
  entityId: string | null,
  projectId: string | null,
  before: Record<string, unknown> | null = null,
  after: Record<string, unknown> | null = null,
) {
  const d = diff(before, after);
  await q.query(
    `INSERT INTO audit_log (actor_id, actor_label, action, entity_type, entity_id, project_id, before, after)
     VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::jsonb)`,
    [actor.user?.id ?? null, actor.label, action, entityType, entityId, projectId, json(d.before), json(d.after)],
  );
}
