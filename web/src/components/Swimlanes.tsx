import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { clock, duration, incLabel, shortSha } from '../format';
import { useApi, useDebounced } from '../hooks';
import { useLive } from '../shell';
import { ErrorBox, Loading } from './ui';

interface LaneData {
  from: string;
  to: string;
  deployments: { id: string; number: number; version: string | null; environment: string | null; service: string | null; status: string; effective_at: string; external_id: string }[];
  changes: { id: string; sha: string; kind: 'commit' | 'config'; message: string; author: string | null; committed_at: string; deployed: boolean }[];
  incidents: { id: string; number: number; title: string; severity: string; status: string; detected_at: string; resolved_at: string | null }[];
  reports: { id: string; kind: string; action: string; entity_id: string | null; summary: string; occurred_at: string; received_at: string; source_name: string | null; late: boolean; duplicate_count: number; actor_name: string | null }[];
  metrics: { name: string; service: string; points: { at: string; value: number }[] }[];
  counts: { late: number; duplicates: number };
}

export const RANGES = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 } as const;
export type RangeKey = keyof typeof RANGES;

const LABEL_W = 118;
const LANES = [
  { key: 'axis', h: 22 },
  { key: 'changes', h: 44, label: 'changes' },
  { key: 'deploys', h: 46, label: 'deploys' },
  { key: 'incidents', h: 58, label: 'incidents' },
  { key: 'reports', h: 58, label: 'reports', sub: 'human + alerts' },
  { key: 'metric', h: 76, label: 'error rate' },
] as const;
const TOTAL_H = LANES.reduce((s, l) => s + l.h, 0) + 6;
const laneTop = (key: string) => {
  let y = 0;
  for (const l of LANES) {
    if (l.key === key) return y;
    y += l.h;
  }
  return y;
};

function tickStep(hours: number) {
  if (hours <= 1) return 10 * 60_000;
  if (hours <= 6) return 3600_000;
  if (hours <= 24) return 3 * 3600_000;
  return 86400_000;
}

/** Window: `range` hours before the anchor (the failure onset) and a little after it, capped at now. */
export function windowFor(anchor: string | null, range: RangeKey) {
  const now = Date.now();
  const hours = RANGES[range];
  if (!anchor) return { from: new Date(now - hours * 3600_000), to: new Date(now) };
  const a = new Date(anchor).getTime();
  const to = Math.min(now, a + hours * 3600_000 * 0.4);
  return { from: new Date(Math.min(a, to) - hours * 3600_000), to: new Date(Math.max(to, a + 60_000)) };
}

export function Swimlanes({
  projectId,
  anchor,
  anchorLabel,
  range,
  highlightDeploymentId,
  service,
  defaultEnvironment,
}: {
  projectId: string;
  anchor: string | null;
  anchorLabel: string;
  range: RangeKey;
  highlightDeploymentId?: string | null;
  service?: string | null;
  defaultEnvironment: string;
}) {
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(760);
  const [{ from, to }, setWin] = useState(() => windowFor(anchor, range));
  useEffect(() => setWin(windowFor(anchor, range)), [anchor, range]);
  const { data, error, reload } = useApi<LaneData>(`/projects/${projectId}/swimlanes?from=${from.toISOString()}&to=${to.toISOString()}`);
  const refresh = useDebounced(() => {
    // Slide the window forward on live updates; a changed window refetches by itself.
    const next = windowFor(anchor, range);
    if (next.from.getTime() === from.getTime() && next.to.getTime() === to.getTime()) void reload();
    else setWin(next);
  }, 1500);
  useLive((m) => m.type === 'event.recorded' && refresh());

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(640, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = width;
  const t0 = from.getTime();
  const t1 = to.getTime();
  const x = (iso: string | number) => LABEL_W + ((new Date(iso).getTime() - t0) / (t1 - t0)) * (W - LABEL_W - 12);
  const inRange = (iso: string | null) => !!iso && new Date(iso).getTime() >= t0 && new Date(iso).getTime() <= t1;
  const step = tickStep(RANGES[range]);
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);
  const fmtTick = (t: number) =>
    step >= 86400_000 ? new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

  let content = null;
  if (data) {
    const series = data.metrics.find((m) => m.service === service) ?? data.metrics[0];
    const mTop = laneTop('metric') + 10;
    const mH = 76 - 22;
    const maxV = Math.max(1, ...(series?.points.map((p) => p.value) ?? [1])) * 1.1;
    const y = (v: number) => mTop + mH - (v / maxV) * mH;
    const linePts = series?.points.map((p) => `${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const latest = series?.points[series.points.length - 1];
    const sortedVals = series ? [...series.points.map((p) => p.value)].sort((a, b) => a - b) : [];
    const baseline = sortedVals.length ? sortedVals[Math.floor(sortedVals.length * 0.25)] : null;

    // Deploy labels: skip if too close to the previous one.
    let lastLabelX = -100;
    // "reported … late" labels: skip any that would overlap the previous one (tooltip still has it).
    let lastLateLabelX = -1000;
    // Incident rows: alternate when overlapping.
    const rowEnd = [0, 0, 0];

    content = (
      <svg width={W} height={TOTAL_H} viewBox={`0 0 ${W} ${TOTAL_H}`} role="img" aria-label="Swimlane timeline of changes, deploys, incidents, reports and error rate">
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--accent-soft)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--accent)" strokeWidth="1.2" opacity="0.35" />
          </pattern>
        </defs>
        {/* grid + axis */}
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid-line" x1={x(t)} x2={x(t)} y1={18} y2={TOTAL_H - 4} />
            <text x={x(t) + 3} y={12}>
              {fmtTick(t)}
            </text>
          </g>
        ))}
        {LANES.filter((l) => l.key !== 'axis').map((l) => (
          <g key={l.key}>
            <line className="grid-line" x1={0} x2={W} y1={laneTop(l.key)} y2={laneTop(l.key)} />
            <text className="lane-label" x={4} y={laneTop(l.key) + 20}>
              {l.label}
            </text>
            {'sub' in l && (
              <text x={4} y={laneTop(l.key) + 33}>
                {l.sub}
              </text>
            )}
          </g>
        ))}

        {/* changes */}
        {data.changes.map((c, i) => {
          const cx = x(c.committed_at);
          const cy = laneTop('changes') + 22 + (i % 2 ? 5 : -3);
          const go = () => navigate(`/projects/${projectId}/changes?q=${c.sha.slice(0, 10)}`);
          const tip = `${shortSha(c.sha)} ${c.message.split('\n')[0]}${c.author ? ` — ${c.author}` : ''} · ${clock(c.committed_at)}${c.kind === 'config' && !c.deployed ? ' · no deploy record' : ''}`;
          return c.kind === 'config' ? (
            <g key={c.id} className="clickable" onClick={go}>
              <title>{tip}</title>
              <rect x={cx - 5} y={cy - 5} width={10} height={10} transform={`rotate(45 ${cx} ${cy})`} fill="var(--warn-soft)" stroke="var(--warn)" strokeWidth={1.5} />
              {!c.deployed && (
                <text x={cx} y={cy + 17} textAnchor="middle" style={{ fill: 'var(--warn)' }}>
                  config · no record
                </text>
              )}
            </g>
          ) : (
            <g key={c.id} className="clickable" onClick={go}>
              <title>{tip}</title>
              <circle cx={cx} cy={cy} r={4.5} fill="var(--surface)" stroke="var(--text-2)" strokeWidth={1.4} />
            </g>
          );
        })}

        {/* deploys */}
        {data.deployments.map((d) => {
          const cx = x(d.effective_at);
          const cy = laneTop('deploys') + 26;
          const prod = d.environment === defaultEnvironment;
          const hot = d.id === highlightDeploymentId;
          const showLabel = hot || cx - lastLabelX > 38;
          if (showLabel) lastLabelX = cx;
          const s = hot ? 14 : 11;
          return (
            <g key={d.id} className="clickable" onClick={() => navigate(`/projects/${projectId}/deploys?open=${d.id}`)}>
              <title>{`#${d.number} ${d.version ?? ''} → ${d.environment ?? '?'} (${d.service ?? '?'}) · ${d.status.replace('_', ' ')} · ${clock(d.effective_at)}`}</title>
              {hot && <rect x={cx - s / 2 - 3} y={cy - s / 2 - 3} width={s + 6} height={s + 6} rx={4} fill="none" stroke="var(--accent)" strokeWidth={1.5} />}
              <rect x={cx - s / 2} y={cy - s / 2} width={s} height={s} rx={2.5} fill={prod ? (hot ? 'var(--blue)' : 'var(--blue)') : 'var(--surface)'} stroke="var(--blue)" strokeWidth={1.5} />
              {showLabel && (
                <text x={cx} y={hot ? cy + 22 : cy - 11} textAnchor="middle" style={hot ? { fill: 'var(--accent)', fontWeight: 600 } : undefined}>
                  #{d.number}
                  {hot ? ` ${d.environment === defaultEnvironment ? 'prod' : d.environment}` : prod ? '' : ` ${d.environment ?? ''}`}
                </text>
              )}
            </g>
          );
        })}

        {/* incidents */}
        {data.incidents.map((inc) => {
          const startX = Math.max(LABEL_W, x(inc.detected_at));
          const endX = Math.min(W - 8, inc.resolved_at ? x(inc.resolved_at) : W - 8);
          // first free row, else the one that frees up soonest
          let row = rowEnd.findIndex((end) => startX > end);
          if (row < 0) row = rowEnd.indexOf(Math.min(...rowEnd));
          rowEnd[row] = endX + 4;
          const y0 = laneTop('incidents') + 5 + row * 17;
          const active = !['resolved', 'closed'].includes(inc.status);
          const w = Math.max(6, endX - startX);
          return (
            <g key={inc.id} className="clickable" onClick={() => navigate(`/projects/${projectId}/incidents/${inc.id}`)}>
              <title>{`${incLabel(inc.number)} · ${inc.severity.toUpperCase()} · ${inc.title} · ${inc.status}`}</title>
              <rect x={startX} y={y0} width={w} height={14} rx={3} fill={active ? 'url(#hatch)' : 'var(--surface-3)'} stroke={active ? 'var(--accent)' : 'var(--border-strong)'} />
              <clipPath id={`clip-${inc.id}`}>
                <rect x={startX} y={y0} width={w} height={14} />
              </clipPath>
              <text x={startX + 5} y={y0 + 10.5} clipPath={`url(#clip-${inc.id})`} style={{ fill: active ? 'var(--accent-strong)' : 'var(--muted)', fontWeight: active ? 600 : 400 }}>
                {incLabel(inc.number)} · {inc.severity.toUpperCase()} · {inc.title}
              </text>
            </g>
          );
        })}

        {/* reports: when it happened (●) → when we heard (◌) */}
        {data.reports.map((r, i) => {
          const x1 = x(r.occurred_at);
          const x2 = inRange(r.received_at) ? x(r.received_at) : W - 8;
          const cy = laneTop('reports') + 15 + (i % 2) * 24;
          const target = r.kind === 'incident' && r.entity_id ? `/projects/${projectId}/incidents/${r.entity_id}` : r.kind === 'deployment' && r.entity_id ? `/projects/${projectId}/deploys?open=${r.entity_id}` : null;
          const lateMin = (new Date(r.received_at).getTime() - new Date(r.occurred_at).getTime()) / 60000;
          const lateText = `reported ${duration(lateMin)} late`;
          const labelW = lateText.length * 6;
          const showLate = r.late && x2 - labelW - 6 > lastLateLabelX + 4 && x2 - labelW - 6 > LABEL_W;
          if (showLate) lastLateLabelX = x2 - 6;
          return (
            <g key={r.id} className={target ? 'clickable' : undefined} onClick={target ? () => navigate(target) : undefined}>
              <title>{`${r.summary} — happened ${clock(r.occurred_at)}, received ${clock(r.received_at)}${r.duplicate_count ? `, ${r.duplicate_count} duplicate(s) folded` : ''}`}</title>
              {r.late && (
                <>
                  <line x1={x1} x2={x2} y1={cy} y2={cy} stroke="var(--text-2)" strokeDasharray="3 3" />
                  <circle cx={x2} cy={cy} r={4.5} fill="var(--surface)" stroke="var(--text-2)" strokeDasharray="2 2" />
                  {showLate && (
                    <text x={x2 - 6} y={cy - 6} textAnchor="end">
                      {lateText}
                    </text>
                  )}
                </>
              )}
              <circle cx={x1} cy={cy} r={4.5} fill="var(--text)" />
              {r.duplicate_count > 0 && (
                <g>
                  <rect x={x1 - 70} y={cy - 8} width={62} height={16} rx={3} fill="var(--text-2)" />
                  <text x={x1 - 39} y={cy + 3.5} textAnchor="middle" style={{ fill: 'var(--bg)' }}>
                    {r.kind === 'change' ? 'push' : r.kind === 'incident' ? 'alert' : 'deploy'} ×{r.duplicate_count + 1}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* metric */}
        {series && series.points.length > 1 ? (
          <g>
            <polygon points={`${x(series.points[0].at)},${mTop + mH} ${linePts} ${x(series.points[series.points.length - 1].at)},${mTop + mH}`} fill="var(--accent-soft)" opacity={0.7} />
            <polyline points={linePts} fill="none" stroke="var(--accent)" strokeWidth={1.6} />
            {latest && (
              <text x={4} y={laneTop('metric') + 40} style={{ fill: 'var(--accent)', fontSize: 14, fontWeight: 600 }}>
                {latest.value.toFixed(1)}%
              </text>
            )}
            <text x={4} y={laneTop('metric') + 56}>
              {series.service}
            </text>
            {baseline !== null && (
              <text x={LABEL_W + 4} y={mTop + mH - 3}>
                baseline {baseline.toFixed(1)}%
              </text>
            )}
          </g>
        ) : (
          <text x={LABEL_W + 6} y={laneTop('metric') + 40}>
            no error-rate samples in this window — POST /api/projects/:id/metrics to add them
          </text>
        )}

        {/* anchor line */}
        {anchor && inRange(anchor) && (
          <g>
            <line x1={x(anchor)} x2={x(anchor)} y1={18} y2={TOTAL_H - 4} stroke="var(--accent)" strokeWidth={1.4} />
            <text x={x(anchor) + 5} y={laneTop('changes') + 12} style={{ fill: 'var(--accent)', fontWeight: 600 }}>
              {anchorLabel} · {clock(anchor, true)}
            </text>
          </g>
        )}
      </svg>
    );
  }

  return (
    <div>
      <ErrorBox error={error} />
      <div className="lanes" ref={box} style={{ overflowX: 'auto' }}>
        {data ? content : <Loading />}
      </div>
      <div className="row between" style={{ marginTop: 12 }}>
        <div className="legend">
          <span>
            <i style={{ background: 'var(--text)', borderRadius: '50%' }} />
            when it happened
          </span>
          <span>
            <i style={{ border: '1.5px dashed var(--text-2)', borderRadius: '50%' }} />
            when we heard
          </span>
          <span>
            <i style={{ border: '1.5px solid var(--warn)', background: 'var(--warn-soft)', transform: 'rotate(45deg)' }} />
            config / no deploy record
          </span>
          <span>
            <i style={{ background: 'var(--blue)', borderRadius: 2 }} />
            deploy to {defaultEnvironment}
          </span>
        </div>
        {data && (
          <span className="muted small">
            {data.counts.late} late event{data.counts.late === 1 ? '' : 's'} re-sorted · {data.counts.duplicates} duplicate{data.counts.duplicates === 1 ? '' : 's'} folded
          </span>
        )}
      </div>
    </div>
  );
}
