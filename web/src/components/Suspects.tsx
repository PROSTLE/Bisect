import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, errorText } from '../api';
import { useAuth } from '../auth';
import { clock, depLabel, humanize, shortSha } from '../format';
import type { ChangeSuspect, Suspect, SuspectsResponse } from '../types';
import { ErrorBox, Meter } from './ui';

export type AnySuspect = Suspect | ChangeSuspect;

const rank = (s: AnySuspect) => (s.link?.relation === 'confirmed' ? 2 : s.link?.relation === 'ruled_out' ? -1 : 0);

/** Deploys and individual changes in one ranked list: human verdicts first, then evidence score. */
export function mergeSuspects(r: SuspectsResponse | null | undefined): AnySuspect[] {
  if (!r) return [];
  return [...r.suspects, ...r.changes].sort((a, b) => rank(b) - rank(a) || b.score - a.score);
}

export function suspectId(s: AnySuspect) {
  return s.type === 'deployment' ? s.deployment.id : s.change.id;
}

export function headCommit(s: Suspect) {
  return s.commits.find((c) => c.sha === s.deployment.commit_sha) ?? s.commits[0] ?? null;
}

export function suspectName(s: AnySuspect) {
  if (s.type === 'deployment') return `Deploy ${depLabel(s.deployment.number)}`;
  return s.change.kind === 'config' ? `Config change ${shortSha(s.change.sha)}` : `Commit ${shortSha(s.change.sha)}`;
}

function diffUrl(s: AnySuspect): string | null {
  if (s.type === 'change') return s.change.url;
  return headCommit(s)?.url ?? s.deployment.url ?? null;
}

export async function setVerdict(incidentId: string, s: AnySuspect, relation: 'confirmed' | 'ruled_out' | 'suspected' | null) {
  const targetType = s.type === 'deployment' ? 'deployment' : 'change';
  const targetId = suspectId(s);
  if (relation === null) await api(`/incidents/${incidentId}/links/${targetType}/${targetId}`, { method: 'DELETE' });
  else await api(`/incidents/${incidentId}/links`, { method: 'PUT', body: { target_type: targetType, target_id: targetId, relation, score: s.score } });
}

export function SuspectCard({
  s,
  index,
  incidentId,
  projectId,
  expanded,
  onChange,
}: {
  s: AnySuspect;
  index: number;
  incidentId: string;
  projectId: string;
  expanded: boolean;
  onChange: () => void;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rel = s.link?.relation;
  const url = diffUrl(s);

  async function mark(relation: 'confirmed' | 'ruled_out' | 'suspected' | null) {
    setBusy(true);
    setErr(null);
    try {
      await setVerdict(incidentId, s, relation);
      onChange();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  let kicker: string;
  let title: React.ReactNode;
  let sub: string;
  let href: string;
  if (s.type === 'deployment') {
    const d = s.deployment;
    const head = headCommit(s);
    kicker = `deploy · ${s.commits.length} commit${s.commits.length === 1 ? '' : 's'}${d.environment ? ` · ${d.environment}` : ''}`;
    title = (
      <>
        {depLabel(d.number)} · {head?.message?.split('\n')[0] ?? d.version ?? d.external_id}
      </>
    );
    sub = [head ? shortSha(head.sha) : null, d.deployed_by, `live ${clock(d.effective_at ?? d.finished_at ?? d.started_at ?? '')}`].filter(Boolean).join(' · ');
    href = `/projects/${projectId}/deploys?open=${d.id}`;
  } else {
    const c = s.change;
    kicker = c.kind === 'config' ? (s.deployment ? `config · inside ${depLabel(s.deployment.number)}` : 'config · no deploy record') : s.deployment ? `commit · inside ${depLabel(s.deployment.number)}` : 'commit · not deployed';
    title = c.message.split('\n')[0];
    sub = [shortSha(c.sha), c.author, clock(c.committed_at)].filter(Boolean).join(' · ');
    href = `/projects/${projectId}/changes?q=${c.sha.slice(0, 10)}`;
  }

  return (
    <div className={`suspect ${index === 0 && rel !== 'ruled_out' ? 'top' : ''} ${rel ?? ''}`}>
      <div className="suspect-head">
        <span className="rank">{index + 1}</span>
        <div style={{ minWidth: 0 }}>
          <div className="label">
            {kicker}
            {rel && <span className={`badge ${rel === 'confirmed' ? 'danger' : rel === 'ruled_out' ? 'outline' : 'warn'}`} style={{ marginLeft: 6 }}>{humanize(rel)}</span>}
          </div>
          <Link to={href} className="suspect-title" style={{ display: 'block' }} title={typeof title === 'string' ? title : undefined}>
            {title}
          </Link>
          <div className="mono muted">{sub}</div>
        </div>
        <div>
          <div className="score">{Math.round(s.score * 100)}</div>
          <div style={{ width: 44, marginTop: 4 }}>
            <Meter value={s.score} thin color={index === 0 ? 'var(--accent)' : 'var(--text-2)'} />
          </div>
        </div>
      </div>
      {expanded && (
        <ul className="reasons">
          {s.reasons.map((r) => (
            <li key={r.text} className={r.weight < 0 ? 'neg' : undefined}>
              {r.text}
            </li>
          ))}
        </ul>
      )}
      {(expanded || rel) && (
        <div className="suspect-actions">
          {can('engineer') && rel !== 'confirmed' && (
            <button className="btn dark sm" disabled={busy} onClick={() => mark('confirmed')}>
              Mark as cause
            </button>
          )}
          {can('engineer') && rel !== 'ruled_out' && (
            <button className="btn sm" disabled={busy} onClick={() => mark('ruled_out')}>
              Rule out
            </button>
          )}
          {can('engineer') && rel && (
            <button className="btn ghost sm" disabled={busy} onClick={() => mark(null)}>
              Clear verdict
            </button>
          )}
          {url ? (
            <a className="btn ghost sm" href={url} target="_blank" rel="noreferrer">
              View diff
            </a>
          ) : (
            <span className="muted small" title="No commit URL was recorded for this change">
              no diff link
            </span>
          )}
        </div>
      )}
      <ErrorBox error={err} />
    </div>
  );
}

export function SuspectList({
  data,
  incidentId,
  projectId,
  limit,
  onChange,
  expandAll,
}: {
  data: SuspectsResponse | null;
  incidentId: string;
  projectId: string;
  limit?: number;
  onChange: () => void;
  expandAll?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const all = mergeSuspects(data);
  const cap = limit ?? (showAll ? all.length : 6);
  const list = all.slice(0, cap);
  if (!data) return null;
  if (list.length === 0) return <div className="empty small">No deploys or changes in the window before this incident. If one is reported late it will appear here automatically.</div>;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {list.map((s, i) => (
        <SuspectCard key={`${s.type}-${suspectId(s)}`} s={s} index={i} incidentId={incidentId} projectId={projectId} expanded={expandAll || i === 0} onChange={onChange} />
      ))}
      {!limit && all.length > 6 && (
        <button className="btn ghost sm" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show top 6' : `Show all ${all.length}`}
        </button>
      )}
    </div>
  );
}
