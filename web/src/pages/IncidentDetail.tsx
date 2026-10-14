import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, api, errorText } from '../api';
import { useAuth } from '../auth';
import { Feed } from '../components/Feed';
import { SuspectList, mergeSuspects } from '../components/Suspects';
import { Timeline } from '../components/Timeline';
import { Avatar, ErrorBox, Loading, SeverityBadge, StatusBadge, useToast } from '../components/ui';
import { clock, dateTime, duration, fromLocalInput, humanize, incLabel, isUrl, timeAgo, toLocalInput } from '../format';
import { useApi, useDebounced, usePresenceHeartbeat } from '../hooks';
import { useLive, useShell } from '../shell';
import type { Incident, IncidentLink, IncidentUpdate, SuspectsResponse, TimelineEvent, User } from '../types';
import { useProject } from './ProjectLayout';

// ---- draft <-> incident mapping -----------------------------------------------------------

const FIELDS = [
  'title',
  'severity',
  'status',
  'assignee_id',
  'commander_id',
  'rollback_owner_id',
  'channel',
  'runbook',
  'service',
  'environment',
  'detected_at',
  'description',
  'root_cause',
  'resolution',
  'duplicate_of',
] as const;
type Field = (typeof FIELDS)[number];
type Draft = Record<Field, string>;
const NULLABLE = new Set<Field>(['assignee_id', 'commander_id', 'rollback_owner_id', 'channel', 'runbook', 'service', 'environment', 'root_cause', 'resolution', 'duplicate_of']);
const STATUSES = ['open', 'investigating', 'identified', 'mitigating', 'monitoring', 'resolved', 'closed'];

function toDraft(i: Incident): Draft {
  return {
    title: i.title,
    severity: i.severity,
    status: i.status,
    assignee_id: i.assignee_id ?? '',
    commander_id: i.commander_id ?? '',
    rollback_owner_id: i.rollback_owner_id ?? '',
    channel: i.channel ?? '',
    runbook: i.runbook ?? '',
    service: i.service ?? '',
    environment: i.environment ?? '',
    detected_at: toLocalInput(i.detected_at),
    description: i.description,
    root_cause: i.root_cause ?? '',
    resolution: i.resolution ?? '',
    duplicate_of: i.duplicate_of ?? '',
  };
}

const changedFields = (draft: Draft, base: Incident) => {
  const b = toDraft(base);
  return FIELDS.filter((f) => draft[f] !== b[f]);
};

function toPayload(draft: Draft, fields: Field[]) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f === 'detected_at') out[f] = fromLocalInput(draft[f]);
    else out[f] = NULLABLE.has(f) && draft[f].trim() === '' ? null : draft[f];
  }
  return out;
}

interface Conflict {
  field: Field;
  yours: unknown;
  theirs: unknown;
  changed_by: string[];
}

interface Detail {
  incident: Incident;
  updates: IncidentUpdate[];
  links: IncidentLink[];
}

export default function IncidentDetail() {
  const { incidentId } = useParams();
  const { project } = useProject();
  const { presence } = useShell();
  const { can, user } = useAuth();
  const toast = useToast();
  const detail = useApi<Detail>(`/incidents/${incidentId}`);
  const suspects = useApi<SuspectsResponse>(`/incidents/${incidentId}/suspects`);
  const similar = useApi<{ incidents: any[] }>(`/incidents/${incidentId}/similar`);
  const context = useApi<{ events: TimelineEvent[]; anchor: any }>(`/projects/${project.id}/timeline?incident_id=${incidentId}&limit=200`);
  const { data: usersData } = useApi<{ users: User[] }>('/users');
  const users = usersData?.users ?? [];
  usePresenceHeartbeat(incidentId);

  // Editing state: `base` is the server version my draft started from.
  const [base, setBase] = useState<Incident | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [remoteNote, setRemoteNote] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [choices, setChoices] = useState<Record<string, 'mine' | 'theirs'>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const server = detail.data?.incident;
  const dirty = base && draft ? changedFields(draft, base) : [];

  // Adopt fresh server state unless the user has unsaved edits.
  useEffect(() => {
    if (!server) return;
    if (!base || base.id !== server.id || (dirty.length === 0 && !conflicts)) {
      setBase(server);
      setDraft(toDraft(server));
      setRemoteNote(null);
    } else if (server.version !== base.version && !conflicts) {
      setRemoteNote(`Someone saved a newer version (v${server.version}) while you were editing.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  const reloadAll = useDebounced(() => {
    void detail.reload();
    void suspects.reload();
    void context.reload();
  }, 300);
  useLive((m) => {
    if (m.data.incident_id === incidentId) reloadAll();
    else if (m.type === 'event.recorded' && m.data.kind !== 'incident') reloadAll();
  });

  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!server || !base || !draft) return <Loading />;
  const editable = can('engineer');
  const viewers = presence[server.id] ?? [];
  const userName = (id: unknown) => users.find((u) => u.id === id)?.name ?? (id ? String(id).slice(0, 8) : 'nobody');
  const show = (field: string, v: unknown) =>
    v == null || v === '' ? '(empty)' : field.endsWith('_id') && field !== 'duplicate_of' ? userName(v) : field === 'detected_at' ? dateTime(String(v)) : String(v);

  async function save(d: Draft, fields: Field[], version: number) {
    setSaving(true);
    setSaveError(null);
    try {
      const r = await api<{ incident: Incident; merged: boolean }>(`/incidents/${incidentId}`, { method: 'PATCH', body: { version, ...toPayload(d, fields) } });
      toast(r.merged ? 'Saved — merged with changes someone else made to other fields.' : 'Saved');
      setConflicts(null);
      setRemoteNote(null);
      setBase(r.incident);
      setDraft(toDraft(r.incident));
      void detail.reload();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'edit_conflict') {
        // Rebase my draft onto the latest version and ask which value wins for each clash.
        const latest = await api<Detail>(`/incidents/${incidentId}`);
        detail.setData(latest);
        setBase(latest.incident);
        setDraft(d);
        setRemoteNote(null);
        setConflicts(err.details.conflicts);
        setChoices(Object.fromEntries(err.details.conflicts.map((c: Conflict) => [c.field, 'mine'])));
      } else {
        setSaveError(errorText(err));
      }
    } finally {
      setSaving(false);
    }
  }

  function resolveConflicts() {
    const latest = toDraft(base!);
    const next = { ...draft! };
    for (const c of conflicts!) if (choices[c.field] === 'theirs') next[c.field] = latest[c.field];
    const fields = FIELDS.filter((f) => next[f] !== latest[f]);
    setConflicts(null);
    setDraft(next);
    if (fields.length) void save(next, fields, base!.version);
  }

  const reportDelay = (new Date(server.reported_at).getTime() - new Date(server.detected_at).getTime()) / 60000;
  const fieldProps = (f: Field) => ({
    value: draft[f],
    disabled: !editable,
    onChange: (e: { target: { value: string } }) => setDraft({ ...draft, [f]: e.target.value }),
  });
  const cls = (f: Field) => `field${dirty.includes(f) ? ' changed' : ''}`;
  const people = users.filter((u) => u.role !== 'viewer');
  const personSelect = (f: Field, emptyLabel: string) => (
    <select {...fieldProps(f)}>
      <option value="">{emptyLabel}</option>
      {people.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
          {u.id === user?.id ? ' (me)' : ''}
        </option>
      ))}
    </select>
  );

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div>
        <Link to={`/projects/${project.id}/incidents`} className="small muted">
          ← Incidents
        </Link>
        <div className="row" style={{ marginTop: 8 }}>
          <SeverityBadge severity={server.severity} />
          <StatusBadge status={server.status} />
          <h1>
            <span className="mono muted" style={{ fontSize: 18 }}>
              {incLabel(server.number)}
            </span>{' '}
            {server.title}
          </h1>
        </div>
        <div className="row small muted" style={{ marginTop: 8 }}>
          <span>detected {dateTime(server.detected_at)}</span>
          {reportDelay > 5 && <span className="badge warn">reported {duration(reportDelay)} later</span>}
          {server.acknowledged_at && <span>· acknowledged after {duration((+new Date(server.acknowledged_at) - +new Date(server.detected_at)) / 60000)}</span>}
          {server.resolved_at && <span>· resolved after {duration((+new Date(server.resolved_at) - +new Date(server.detected_at)) / 60000)}</span>}
          <span>· via {server.source}</span>
          {server.external_id && <span className="badge outline">{server.external_id}</span>}
          {server.signature && <span className="badge outline" title="Error signature">{server.signature}</span>}
          <span className="badge outline" title="Optimistic-concurrency version">
            v{server.version}
          </span>
          {viewers.length > 0 && (
            <span className="row" title={viewers.map((v) => v.name).join(', ')}>
              · <span className="avatars">{viewers.map((v) => <Avatar key={v.id} name={v.name} size="sm" />)}</span> viewing now
            </span>
          )}
        </div>
      </div>

      <div className="split">
        <div className="stack" style={{ gap: 18 }}>
          <form
            className="card"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void save(draft, dirty, base.version);
            }}
          >
            <div className="card-head">
              <h2>Details</h2>
              {editable && (
                <div className="row">
                  {dirty.length > 0 && (
                    <button type="button" className="btn ghost sm" onClick={() => setDraft(toDraft(base))}>
                      Discard
                    </button>
                  )}
                  <button className="btn primary sm" disabled={saving || dirty.length === 0 || !!conflicts}>
                    {dirty.length ? `Save ${dirty.length} change${dirty.length > 1 ? 's' : ''}` : 'Saved'}
                  </button>
                </div>
              )}
            </div>
            <div className="card-body stack">
              {remoteNote && (
                <div className="notice row between">
                  <span>{remoteNote} Saving merges your edits if they touch different fields.</span>
                  <button
                    type="button"
                    className="btn sm"
                    onClick={() => {
                      setBase(server);
                      setDraft(toDraft(server));
                      setRemoteNote(null);
                    }}
                  >
                    Discard mine &amp; load latest
                  </button>
                </div>
              )}
              {conflicts && (
                <div className="warn-box">
                  <strong>Edit conflict.</strong> These fields were changed by someone else since you started editing. Choose which value to keep:
                  <div style={{ marginTop: 8 }}>
                    {conflicts.map((c) => (
                      <div key={c.field} className="conflict-row">
                        <strong>{humanize(c.field.replace('_id', ''))}</strong>
                        <label>
                          <input type="radio" name={c.field} checked={choices[c.field] === 'theirs'} onChange={() => setChoices({ ...choices, [c.field]: 'theirs' })} />
                          <span>
                            Theirs ({c.changed_by.join(', ')}): <em>{show(c.field, c.theirs)}</em>
                          </span>
                        </label>
                        <label>
                          <input type="radio" name={c.field} checked={choices[c.field] === 'mine'} onChange={() => setChoices({ ...choices, [c.field]: 'mine' })} />
                          <span>
                            Mine: <em>{show(c.field, c.yours)}</em>
                          </span>
                        </label>
                      </div>
                    ))}
                  </div>
                  <div className="row" style={{ marginTop: 10 }}>
                    <button type="button" className="btn primary sm" onClick={resolveConflicts} disabled={saving}>
                      Save with these choices
                    </button>
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        setConflicts(null);
                        setDraft(toDraft(base));
                      }}
                    >
                      Discard all my edits
                    </button>
                  </div>
                </div>
              )}
              <ErrorBox error={saveError} />
              <label className={cls('title')}>
                <span>Title</span>
                <input {...fieldProps('title')} />
              </label>
              <div className="form-grid">
                <label className={cls('status')}>
                  <span>Status</span>
                  <select {...fieldProps('status')}>
                    {STATUSES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <label className={cls('severity')}>
                  <span>Severity</span>
                  <select {...fieldProps('severity')}>
                    {['sev1', 'sev2', 'sev3', 'sev4'].map((s) => (
                      <option key={s} value={s}>
                        {s.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={cls('assignee_id')}>
                  <span>Assignee</span>
                  {personSelect('assignee_id', 'Unassigned')}
                </label>
              </div>
              <div className="form-grid">
                <label className={cls('commander_id')}>
                  <span>Commander</span>
                  {personSelect('commander_id', 'No commander')}
                </label>
                <label className={cls('rollback_owner_id')}>
                  <span>Rollback owner</span>
                  {personSelect('rollback_owner_id', 'Nobody')}
                </label>
                <label className={cls('channel')}>
                  <span>Channel</span>
                  <input {...fieldProps('channel')} placeholder="#inc-…" />
                </label>
                <label className={cls('runbook')}>
                  <span>
                    Runbook{' '}
                    {isUrl(draft.runbook) && (
                      <a href={draft.runbook} target="_blank" rel="noreferrer" className="accent" style={{ textTransform: 'none' }}>
                        open ↗
                      </a>
                    )}
                  </span>
                  <input {...fieldProps('runbook')} placeholder="URL or name" />
                </label>
              </div>
              <div className="form-grid">
                <label className={cls('service')}>
                  <span>Service</span>
                  <input {...fieldProps('service')} />
                </label>
                <label className={cls('environment')}>
                  <span>Environment</span>
                  <input {...fieldProps('environment')} />
                </label>
                <label className={cls('detected_at')}>
                  <span>Detected at</span>
                  <input type="datetime-local" {...fieldProps('detected_at')} />
                </label>
              </div>
              <label className={cls('description')}>
                <span>Description</span>
                <textarea {...fieldProps('description')} rows={3} />
              </label>
              <div className="form-grid">
                <label className={cls('root_cause')}>
                  <span>Root cause</span>
                  <textarea {...fieldProps('root_cause')} rows={2} placeholder="What actually broke?" />
                </label>
                <label className={cls('resolution')}>
                  <span>Resolution {draft.status === 'resolved' && !draft.resolution && <span className="accent">· required</span>}</span>
                  <textarea {...fieldProps('resolution')} rows={2} placeholder="How was it fixed?" />
                </label>
              </div>
              <label className={cls('duplicate_of')}>
                <span>Duplicate of</span>
                <select {...fieldProps('duplicate_of')}>
                  <option value="">— not a duplicate —</option>
                  {server.duplicate_of && !similar.data?.incidents.some((s) => s.id === server.duplicate_of) && (
                    <option value={server.duplicate_of}>{incLabel(server.duplicate_of_number ?? 0)}</option>
                  )}
                  {similar.data?.incidents.map((s) => (
                    <option key={s.id} value={s.id}>
                      {incLabel(s.number)} {s.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </form>

          <div className="card">
            <div className="card-head">
              <div>
                <h2>Who broke it?</h2>
                <p className="muted small">
                  {suspects.data?.signal
                    ? `Ranked against the error-rate onset (${suspects.data.signal.service}: ${suspects.data.signal.baseline}% → ${suspects.data.signal.latest}%${suspects.data.signal.onset_at ? `, first spike ${clock(suspects.data.signal.onset_at, true)}` : ''}).`
                    : 'Ranked against the detection time (no error-rate samples recorded).'}
                </p>
              </div>
              <span className="label">{mergeSuspects(suspects.data).length} candidates</span>
            </div>
            <div className="card-body">
              <ErrorBox error={suspects.error} />
              {!suspects.data ? <Loading /> : <SuspectList data={suspects.data} incidentId={server.id} projectId={project.id} onChange={reloadAll} expandAll />}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>What happened around it</h2>
              <span className="label">24h before → 12h after detection</span>
            </div>
            <div className="card-body">{context.data ? <Timeline events={context.data.events} projectId={project.id} anchor={context.data.anchor} /> : <Loading />}</div>
          </div>
        </div>

        <div className="stack" style={{ gap: 18 }}>
          <div className="card">
            <div className="card-head">
              <h2>Activity</h2>
            </div>
            <div className="card-body">
              <Feed incident={server} onChanged={reloadAll} />
            </div>
          </div>
          <LinksCard links={detail.data!.links} projectId={project.id} />
          <SimilarCard items={similar.data?.incidents} projectId={project.id} />
        </div>
      </div>
    </div>
  );
}

function LinksCard({ links, projectId }: { links: IncidentLink[]; projectId: string }) {
  if (links.length === 0) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Linked deploys &amp; changes</h2>
      </div>
      <div className="card-body stack" style={{ gap: 10 }}>
        {links.map((l) => (
          <div key={l.target_id} className="small">
            <div className="row">
              <span className={`badge ${l.relation === 'confirmed' ? 'danger' : l.relation === 'ruled_out' ? 'outline' : 'warn'}`}>{humanize(l.relation)}</span>
              <Link to={l.target_type === 'deployment' ? `/projects/${projectId}/deploys?open=${l.target_id}` : `/projects/${projectId}/changes?q=${(l.target_label ?? '').split(' ')[0]}`}>
                {l.target_type} <strong>{l.target_label ?? l.target_id.slice(0, 8)}</strong>
              </Link>
              {l.created_by_name && <span className="muted">by {l.created_by_name}</span>}
            </div>
            {l.note && <div className="muted" style={{ marginTop: 3 }}>“{l.note}”</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

function SimilarCard({ items, projectId }: { items?: any[]; projectId: string }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>Has this happened before?</h2>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        {!items ? (
          <Loading />
        ) : items.length === 0 ? (
          <div className="muted small">No similar incidents found.</div>
        ) : (
          items.map((s) => (
            <div key={s.id} className="small">
              <Link to={`/projects/${projectId}/incidents/${s.id}`}>
                <span className="mono muted">{incLabel(s.number)}</span> {s.title}
              </Link>
              <div className="row muted" style={{ marginTop: 2 }}>
                <StatusBadge status={s.status} />
                <span>{timeAgo(s.detected_at)}</span>
                <span>{s.same_fingerprint ? 'same error fingerprint' : `${Math.round(s.similarity * 100)}% similar`}</span>
              </div>
              {(s.root_cause || s.resolution) && (
                <div style={{ marginTop: 4, color: 'var(--text-2)' }}>
                  {s.root_cause && (
                    <div>
                      <strong>Cause:</strong> {s.root_cause}
                    </div>
                  )}
                  {s.resolution && (
                    <div>
                      <strong>Fix:</strong> {s.resolution}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
