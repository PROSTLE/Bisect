import { useState, type FormEvent } from 'react';
import { api, ApiError, errorText } from '../api';
import { useAuth } from '../auth';
import { clock, dateTime, depLabel, duration, humanize, shortSha } from '../format';
import { useApi, useDebounced } from '../hooks';
import { useLive } from '../shell';
import type { Deployment, FeedItem, Incident, User, Change } from '../types';
import { Icon } from './Icon';
import { Avatar, ErrorBox, Loading, Modal, useToast } from './ui';

const fieldName = (f: string) => humanize(f.replace(/_id$/, ''));

/**
 * The incident's activity: updates by people, plus plumbing events (late reports, folded
 * duplicates) and rejected concurrent edits — so nobody's input silently disappears.
 */
export function Feed({ incident, onChanged, limit }: { incident: Incident; onChanged: () => void; limit?: number }) {
  const { can } = useAuth();
  const { data, error, reload } = useApi<{ items: FeedItem[] }>(`/incidents/${incident.id}/feed`);
  const { data: usersData } = useApi<{ users: User[] }>('/users');
  const refresh = useDebounced(() => void reload(), 400);
  useLive((m) => (m.data.incident_id === incident.id || m.type === 'event.recorded') && refresh());
  const [compare, setCompare] = useState<FeedItem | null>(null);

  const userName = (id: unknown) => usersData?.users.find((u) => u.id === id)?.name ?? (id ? String(id).slice(0, 8) : 'nobody');
  const show = (field: string, v: unknown) =>
    v == null || v === '' ? '∅' : field.endsWith('_id') ? userName(v) : field === 'detected_at' ? dateTime(String(v)) : String(v);

  const items = (data?.items ?? []).slice(0, limit ?? 100);
  return (
    <div>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : (
        <div className="feed">
          {items.length === 0 && <div className="empty small">No activity yet.</div>}
          {items.map((it) =>
            it.type === 'update' && it.kind === 'conflict' ? (
              <ConflictEntry key={it.id} item={it} incident={incident} show={show} onCompare={() => setCompare(it)} onChanged={onChanged} editable={can('engineer')} />
            ) : (
              <div key={`${it.type}-${it.id}`} className="feed-item">
                <span className="feed-time">{clock(it.at)}</span>
                {it.type === 'event' ? (
                  <span className="avatar system">
                    <Icon name={it.duplicate_count ? 'copy' : 'clock'} size={13} />
                  </span>
                ) : (
                  <Avatar name={it.kind === 'system' && !it.author_name ? null : it.author_name} />
                )}
                <div className="feed-body">{describe(it, show)}</div>
              </div>
            ),
          )}
        </div>
      )}
      {can('engineer') && <Composer incident={incident} onPosted={() => void reload()} />}
      {compare && <CompareModal item={compare} incident={incident} show={show} onClose={() => setCompare(null)} />}
    </div>
  );
}

function describe(it: FeedItem, show: (f: string, v: unknown) => string) {
  const who = <strong>{it.author_name ?? 'System'}</strong>;
  if (it.type === 'event') {
    const source = it.source_name ?? 'An integration';
    if (it.duplicate_count && it.duplicate_count > 0) {
      const what = it.kind === 'change' && it.sha ? `the push for ${shortSha(it.sha)}` : it.summary;
      return (
        <>
          <strong>{source}</strong> sent {what} {it.duplicate_count + 1} times — folded into one
          <div className="feed-sub">same event id · {it.duplicate_count} dropped</div>
        </>
      );
    }
    const delay = duration((it.delay_seconds ?? 0) / 60);
    return (
      <>
        <strong>{it.actor_name ?? source}</strong> reported “{it.summary}”
        <div className="feed-sub">
          arrived {delay} late · placed at {clock(it.occurred_at!)} on the timeline
        </div>
      </>
    );
  }
  switch (it.kind) {
    case 'status':
      return (
        <>
          {who} moved status {it.data?.from} <span className="accent">→ {it.data?.to}</span>
        </>
      );
    case 'field':
      return (
        <>
          {who} updated{' '}
          {(it.data?.changes ?? []).map((c: any, i: number) => (
            <span key={c.field}>
              {i > 0 && ', '}
              {fieldName(c.field)} <span className="muted">{show(c.field, c.from)}</span> → {show(c.field, c.to)}
            </span>
          ))}
        </>
      );
    case 'comment':
      return (
        <>
          {who}
          <div style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>{it.body}</div>
        </>
      );
    case 'link':
      return (
        <>
          {who} {lowerFirstSentence(it.body ?? '')}
        </>
      );
    default:
      return <span className="muted">{it.body}</span>;
  }
}

const lowerFirstSentence = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

function ConflictEntry({
  item,
  incident,
  show,
  onCompare,
  onChanged,
  editable,
}: {
  item: FeedItem;
  incident: Incident;
  show: (f: string, v: unknown) => string;
  onCompare: () => void;
  onChanged: () => void;
  editable: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = item.data;
  const conflicts: { field: string; yours: unknown; theirs: unknown; changed_by: string[] }[] = d?.conflicts ?? [];
  const adopted = conflicts.every((c) => JSON.stringify((incident as any)[c.field] ?? null) === JSON.stringify(c.yours ?? null));

  async function adopt() {
    setBusy(true);
    setErr(null);
    try {
      const fresh = await api<{ incident: Incident }>(`/incidents/${incident.id}`);
      const body: Record<string, unknown> = { version: fresh.incident.version };
      for (const c of conflicts) body[c.field] = c.yours;
      await api(`/incidents/${incident.id}`, { method: 'PATCH', body });
      toast(`Applied ${d.rejected_by}'s ${conflicts.map((c) => fieldName(c.field)).join(', ')}`);
      onChanged();
    } catch (e) {
      setErr(e instanceof ApiError && e.code === 'edit_conflict' ? 'Someone changed it again — reload and compare.' : errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="feed-item conflict">
      <span className="feed-time">{clock(item.at)}</span>
      <span className="conflict-icon">
        <Icon name="merge" size={14} />
      </span>
      <div className="feed-body">
        <strong style={{ color: 'var(--warn)' }}>
          Concurrent edits to {conflicts.map((c) => fieldName(c.field)).join(', ')}
        </strong>
        <div className="conflict-lines">
          {conflicts.map((c) => (
            <FragmentRows key={c.field} c={c} d={d} show={show} />
          ))}
        </div>
        <div className="row">
          <button className="btn sm" onClick={onCompare}>
            Compare
          </button>
          {editable &&
            (adopted ? (
              <span className="muted small">{d.rejected_by}'s value is now current</span>
            ) : (
              <button className="btn ghost sm" disabled={busy} onClick={adopt}>
                Keep {d.rejected_by}'s instead
              </button>
            ))}
        </div>
        <ErrorBox error={err} />
      </div>
    </div>
  );
}

function FragmentRows({ c, d, show }: { c: { field: string; yours: unknown; theirs: unknown; changed_by: string[] }; d: any; show: (f: string, v: unknown) => string }) {
  return (
    <>
      <span>
        v{d.current_version} · {c.changed_by.join(', ')}
      </span>
      <span>
        {show(c.field, c.theirs)} — kept, newest version
      </span>
      <span className="strike">
        v{d.base_version} · {d.rejected_by}
      </span>
      <span className="muted">
        {show(c.field, c.yours)} — edited from stale v{d.base_version}, saved to history
      </span>
    </>
  );
}

function CompareModal({ item, incident, show, onClose }: { item: FeedItem; incident: Incident; show: (f: string, v: unknown) => string; onClose: () => void }) {
  const d = item.data;
  return (
    <Modal title="Compare concurrent edits" onClose={onClose}>
      {(d?.conflicts ?? []).map((c: any) => {
        const current = (incident as any)[c.field];
        const theirsCurrent = JSON.stringify(current ?? null) === JSON.stringify(c.theirs ?? null);
        const yoursCurrent = JSON.stringify(current ?? null) === JSON.stringify(c.yours ?? null);
        return (
          <div key={c.field} className="stack" style={{ gap: 8 }}>
            <div className="label">{fieldName(c.field)}</div>
            <div className="compare">
              <div className={theirsCurrent ? 'won' : ''}>
                <div className="label">kept · v{d.current_version} · {c.changed_by.join(', ')}</div>
                <div style={{ fontWeight: 600, marginTop: 4 }}>{show(c.field, c.theirs)}</div>
                {theirsCurrent && <div className="small" style={{ color: 'var(--ok)' }}>current value</div>}
              </div>
              <div className={yoursCurrent ? 'won' : ''}>
                <div className="label">rejected · from v{d.base_version} · {d.rejected_by}</div>
                <div style={{ fontWeight: 600, marginTop: 4 }}>{show(c.field, c.yours)}</div>
                {yoursCurrent && <div className="small" style={{ color: 'var(--ok)' }}>current value</div>}
              </div>
            </div>
            {!theirsCurrent && !yoursCurrent && (
              <div className="muted small">
                Changed again since: now <strong>{show(c.field, current)}</strong>.
              </div>
            )}
          </div>
        );
      })}
      <p className="muted small">
        Edits made from an older version than the current one are rejected for the overlapping fields; edits to different fields merge
        automatically.
      </p>
    </Modal>
  );
}

// ---- composer -----------------------------------------------------------------------------

function Composer({ incident, onPosted }: { incident: Incident; onPosted: () => void }) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<'deploy' | 'commit' | null>(null);
  const deploys = useApi<{ deployments: Deployment[] }>(picker === 'deploy' ? `/projects/${incident.project_id}/deployments?limit=20` : null);
  const commits = useApi<{ changes: Change[] }>(picker === 'commit' ? `/projects/${incident.project_id}/changes?limit=25` : null);

  async function post(e: FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    try {
      await api(`/incidents/${incident.id}/comments`, { method: 'POST', body: { body } });
      setBody('');
      setError(null);
      onPosted();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function link(targetType: 'deployment' | 'change', targetId: string, label: string) {
    setPicker(null);
    try {
      await api(`/incidents/${incident.id}/links`, { method: 'PUT', body: { target_type: targetType, target_id: targetId, relation: 'suspected', note: body.trim() || undefined } });
      toast(`Linked ${label} as a suspect`);
      onPosted();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <form className="composer" onSubmit={post}>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Add an update — what did you try, what did you see?" aria-label="Update" />
      <div className="composer-bar">
        <button type="button" className="chip-btn" onClick={() => setPicker(picker === 'deploy' ? null : 'deploy')}>
          + link deploy
        </button>
        <button type="button" className="chip-btn" onClick={() => setPicker(picker === 'commit' ? null : 'commit')}>
          + link commit
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn dark sm" disabled={busy || !body.trim()}>
          Post update
        </button>
        {picker && (
          <div className="popover" role="listbox">
            {picker === 'deploy' &&
              (deploys.data ? (
                deploys.data.deployments.map((d) => (
                  <button type="button" key={d.id} onClick={() => link('deployment', d.id, depLabel(d.number))}>
                    <span className="mono">{depLabel(d.number)}</span> {d.version ?? d.external_id} <span className="muted">→ {d.environment ?? '?'} · {clock(d.effective_at)}</span>
                  </button>
                ))
              ) : (
                <Loading />
              ))}
            {picker === 'commit' &&
              (commits.data ? (
                commits.data.changes.map((c) => (
                  <button type="button" key={c.id} onClick={() => link('change', c.id, shortSha(c.sha))}>
                    <span className="mono">{shortSha(c.sha)}</span> {c.message.split('\n')[0]} <span className="muted">{c.author ?? ''}</span>
                  </button>
                ))
              ) : (
                <Loading />
              ))}
          </div>
        )}
      </div>
      {error && (
        <div style={{ padding: '0 8px 8px' }}>
          <ErrorBox error={error} />
        </div>
      )}
    </form>
  );
}
