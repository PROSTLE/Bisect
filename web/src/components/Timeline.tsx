import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { clock, dateTime, duration, incLabel } from '../format';
import type { TimelineEvent } from '../types';

function markerClass(e: TimelineEvent) {
  if (/\.(succeeded|resolved|closed)$/.test(e.action)) return 'ok';
  if (e.action === 'deployment.failed' || e.action === 'deployment.rolled_back') return 'incident';
  return e.kind;
}

function entityLink(e: TimelineEvent, projectId: string) {
  if (!e.entity_id) return null;
  if (e.kind === 'incident') return `/projects/${projectId}/incidents/${e.entity_id}`;
  if (e.kind === 'deployment') return `/projects/${projectId}/deploys?open=${e.entity_id}`;
  return `/projects/${projectId}/changes`;
}

/**
 * Events ordered by when they *happened*. Late arrivals still land in the right place, and are
 * labelled with how late they were reported so the sequence of events stays trustworthy.
 */
export function Timeline({
  events,
  projectId,
  anchor,
}: {
  events: TimelineEvent[];
  projectId: string;
  anchor?: { id: string; number: number; title: string; detected_at: string } | null;
}) {
  if (events.length === 0) return <div className="empty">No events in this range.</div>;
  let lastDay = '';
  let anchorShown = !anchor;
  const anchorTime = anchor ? new Date(anchor.detected_at).getTime() : 0;

  return (
    <div className="timeline">
      {events.map((e) => {
        const day = new Date(e.occurred_at).toDateString();
        const showDay = day !== lastDay;
        lastDay = day;
        let anchorEl = null;
        if (!anchorShown && new Date(e.occurred_at).getTime() < anchorTime) {
          anchorShown = true;
          anchorEl = (
            <div className="tl-anchor">
              ⚠ {incLabel(anchor!.number)} detected · {dateTime(anchor!.detected_at)}
            </div>
          );
        }
        const href = entityLink(e, projectId);
        const delayMin = Math.round(e.delay_seconds / 60);
        return (
          <Fragment key={e.id}>
            {anchorEl}
            {showDay && <div className="tl-day label">{new Date(e.occurred_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>}
            <div className="tl-item">
              <span className={`tl-marker ${markerClass(e)}`} />
              <div>
                {href ? <Link to={href}>{e.summary}</Link> : e.summary}
                {e.entity_id === anchor?.id && <span className="badge danger" style={{ marginLeft: 6 }}>this incident</span>}
              </div>
              <div className="tl-meta">
                <span className="mono">{clock(e.occurred_at)}</span>
                <span className="badge outline">{e.kind}</span>
                <span>via {e.source}</span>
                {e.actor_name && <span>by {e.actor_name}</span>}
                {e.late && (
                  <span className="badge warn" title={`Received ${dateTime(e.received_at)}`}>
                    reported {duration(delayMin)} late
                  </span>
                )}
                {e.out_of_order && (
                  <span className="badge info" title="Events that happened later had already been recorded when this arrived">
                    arrived out of order
                  </span>
                )}
                {e.duplicate_count > 0 && <span className="badge accent">{e.duplicate_count} duplicate{e.duplicate_count > 1 ? 's' : ''} dropped</span>}
              </div>
              {e.warnings.length > 0 && (
                <div className="small" style={{ color: 'var(--warn)', marginTop: 2 }}>
                  {e.warnings.map((w) => (
                    <div key={w}>⚠ {w}</div>
                  ))}
                </div>
              )}
            </div>
          </Fragment>
        );
      })}
      {!anchorShown && anchor && <div className="tl-anchor">⚠ {incLabel(anchor.number)} detected · {dateTime(anchor.detected_at)}</div>}
    </div>
  );
}
