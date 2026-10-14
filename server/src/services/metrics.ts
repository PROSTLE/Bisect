import { z } from 'zod';
import type { Queryable } from '../db/index.js';

/** Metric samples, e.g. { name: "error_rate", service: "checkout", at, value: 16.4 } (percent). */
export const MetricPoint = z.object({
  name: z.string().trim().min(1).max(100),
  service: z
    .string()
    .trim()
    .max(100)
    .nullish()
    .transform((v) => v ?? ''),
  at: z.string().datetime({ offset: true }),
  value: z.number().finite(),
});
export type MetricPoint = z.infer<typeof MetricPoint>;

/** Idempotent upsert: re-sending a sample with the same (name, service, at) overwrites, never duplicates. */
export async function upsertMetrics(q: Queryable, projectId: string, points: MetricPoint[]) {
  if (points.length === 0) return 0;
  await q.query(
    `INSERT INTO metric_points (project_id, name, service, at, value)
     SELECT $1, * FROM unnest($2::text[], $3::text[], $4::timestamptz[], $5::float8[])
     ON CONFLICT (project_id, name, service, at) DO UPDATE SET value = EXCLUDED.value`,
    [projectId, points.map((p) => p.name), points.map((p) => p.service), points.map((p) => p.at), points.map((p) => p.value)],
  );
  return points.length;
}

export interface ErrorSignal {
  name: string;
  service: string;
  baseline: number;
  /** First sample that breached max(1, 5 × baseline) — the observed onset of the failure. */
  onset_at: string | null;
  latest: number;
  latest_at: string;
  peak: number;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Describe the error-rate signal around an incident: the baseline over the preceding day, when it
 * first breached, and where it is now. Returns null when nothing is being measured for the service.
 */
export async function errorSignal(q: Queryable, projectId: string, service: string | null, around: Date): Promise<ErrorSignal | null> {
  const { rows: series } = await q.query<{ service: string }>(
    `SELECT service FROM metric_points WHERE project_id = $1 AND name = 'error_rate'
       AND ($2::text IS NULL OR service = $2) GROUP BY service ORDER BY count(*) DESC LIMIT 1`,
    [projectId, service],
  );
  if (!series[0]) return null;
  const svc = series[0].service;
  const T = around.getTime();
  const { rows } = await q.query<{ at: Date; value: number }>(
    `SELECT at, value FROM metric_points WHERE project_id = $1 AND name = 'error_rate' AND service = $2
       AND at >= $3::timestamptz ORDER BY at`,
    [projectId, svc, new Date(T - 26 * 3600_000).toISOString()],
  );
  if (rows.length === 0) return null;
  const before = rows.filter((r) => r.at.getTime() <= T - 2 * 3600_000).map((r) => r.value);
  const baseline = median(before.length ? before : rows.slice(0, Math.max(1, Math.floor(rows.length / 4))).map((r) => r.value));
  const threshold = Math.max(1, baseline * 5);
  const onset = rows.find((r) => r.at.getTime() >= T - 2 * 3600_000 && r.value > threshold);
  const latest = rows[rows.length - 1];
  return {
    name: 'error_rate',
    service: svc,
    baseline: Math.round(baseline * 100) / 100,
    onset_at: onset ? onset.at.toISOString() : null,
    latest: Math.round(latest.value * 10) / 10,
    latest_at: latest.at.toISOString(),
    peak: Math.round(Math.max(...rows.filter((r) => r.at.getTime() >= T - 2 * 3600_000).map((r) => r.value), 0) * 10) / 10,
  };
}
