import { Link } from 'react-router-dom';
import { duration, incLabel, timeAgo } from '../format';
import type { RecurringGroup } from '../types';
import { Icon } from './Icon';

/** One cell per `bucketDays` over the window; filled where an occurrence landed. */
function Strip({ group, days, bucketDays }: { group: RecurringGroup; days: number; bucketDays: number }) {
  const n = Math.ceil(days / bucketDays);
  const now = Date.now();
  const cells: ('hit' | 'open' | null)[] = Array(n).fill(null);
  for (const i of group.incidents) {
    const ageDays = (now - new Date(i.detected_at).getTime()) / 86400_000;
    const idx = n - 1 - Math.floor(ageDays / bucketDays);
    if (idx < 0 || idx >= n) continue;
    const open = !['resolved', 'closed'].includes(i.status);
    if (open || cells[idx] !== 'open') cells[idx] = open ? 'open' : 'hit';
  }
  return (
    <div className="strip" aria-label={`${group.count} occurrences over ${days} days`}>
      {cells.map((c, i) => (
        <span key={i} className={c ? `hit ${c === 'open' ? 'open' : ''}` : ''} />
      ))}
    </div>
  );
}

export function RecurringList({ groups, days, projectId, showIncidents }: { groups: RecurringGroup[]; days: number; projectId: string; showIncidents?: boolean }) {
  if (groups.length === 0) return <div className="empty small">Nothing has happened twice in the last {days} days.</div>;
  return (
    <div>
      {groups.map((g) => (
        <div className="recur" key={g.incidents[0].id}>
          <div className="row between" style={{ flexWrap: 'nowrap', alignItems: 'baseline' }}>
            <strong>{g.title}</strong>
            <span className={`recur-count ${g.open ? 'open' : ''}`}>
              {g.count}
              <small>×</small>
            </span>
          </div>
          <Strip group={g} days={days} bucketDays={days > 45 ? 2 : 1} />
          <div className="row between mono muted" style={{ fontSize: 11 }}>
            <span>
              {g.service ? `${g.service} · ` : ''}
              {g.signature}
            </span>
            <span>{new Date(g.last_seen).toDateString() === new Date().toDateString() ? 'again today' : timeAgo(g.last_seen)}</span>
          </div>
          {showIncidents && (
            <div className="row small" style={{ marginTop: 6 }}>
              {g.incidents.map((i) => (
                <Link key={i.id} to={`/projects/${projectId}/incidents/${i.id}`} className="mono">
                  {incLabel(i.number)}
                </Link>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** "INC-102 matches X. Last N times: …" — composed only from recorded outcomes. */
export function MatchCallout({ groups, incidentId, incidentNumber }: { groups: RecurringGroup[]; incidentId: string; incidentNumber: number }) {
  const g = groups.find((x) => x.incidents.some((i) => i.id === incidentId));
  if (!g) return null;
  const past = g.incidents.filter((i) => i.id !== incidentId);
  const c = g.confirmed_causes;
  const parts = [
    c.deployment ? `${c.deployment} deploy${c.deployment > 1 ? 's' : ''}` : null,
    c.config ? `${c.config} config change${c.config > 1 ? 's' : ''}` : null,
    c.commit ? `${c.commit} commit${c.commit > 1 ? 's' : ''}` : null,
  ].filter(Boolean);
  return (
    <div className="callout">
      <Icon name="clock" />
      <div>
        {incLabel(incidentNumber)} matches <strong>{g.title}</strong>.{' '}
        {parts.length ? <>Of the last {past.length} times, the confirmed causes were {parts.join(' and ')}</> : <>It happened {past.length} times before; no cause was confirmed</>}
        {g.median_resolve_minutes != null ? <>, resolved in a median of {duration(g.median_resolve_minutes)}.</> : '.'}
      </div>
    </div>
  );
}
