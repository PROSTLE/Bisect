import { useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorText, newKey } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../components/Icon';
import { DeployBadge, ErrorBox, Loading, Modal, SeverityBadge, StatusBadge, useToast } from '../components/ui';
import { clock, dateTime, depLabel, duration, fromLocalInput, humanize, incLabel, shortSha, toLocalInput } from '../format';
import { useApi, useDebounced } from '../hooks';
import { useLive } from '../shell';
import type { Deployment } from '../types';
import { useProject } from './ProjectLayout';

export default function DeploymentsPage() {
  const { project } = useProject();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [recording, setRecording] = useState(false);
  const status = params.get('status') ?? '';
  const environment = params.get('environment') ?? '';
  const filter = params.get('filter');
  const openId = params.get('open');
  const setParam = (k: string, v: string | null) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(environment ? { environment } : {}), limit: '200' });
  const { data, error, reload } = useApi<{ deployments: Deployment[]; environments: string[] }>(`/projects/${project.id}/deployments?${qs}`);
  const refresh = useDebounced(() => void reload(), 500);
  useLive((m) => ((m.type === 'event.recorded' && m.data.kind !== 'incident') || m.data.changed?.includes('links')) && refresh());

  const rows = (data?.deployments ?? []).filter((d) => (filter === 'conflicts' ? d.conflicts.length > 0 : filter === 'incomplete' ? d.gaps.length > 0 : true));

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Deploys</h1>
          <p>Each record is merged from every event reported about it — in any order, from any source.</p>
        </div>
        {can('engineer') && (
          <button className="btn dark" onClick={() => setRecording(true)}>
            <Icon name="plus" size={14} /> Record deploy
          </button>
        )}
      </div>
      <div className="filters">
        <select value={status} onChange={(e) => setParam('status', e.target.value)} aria-label="Status">
          <option value="">All statuses</option>
          {['pending', 'in_progress', 'succeeded', 'failed', 'rolled_back', 'unknown'].map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </select>
        <select value={environment} onChange={(e) => setParam('environment', e.target.value)} aria-label="Environment">
          <option value="">All environments</option>
          {data?.environments.map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
        <select value={filter ?? ''} onChange={(e) => setParam('filter', e.target.value || null)} aria-label="Data quality">
          <option value="">Any record</option>
          <option value="incomplete">Incomplete records</option>
          <option value="conflicts">Conflicting reports</option>
        </select>
      </div>
      <ErrorBox error={error} />
      <div className="card table-wrap">
        {!data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <div className="empty">No deploys match.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Deploy</th>
                <th>Status</th>
                <th className="hide-sm">Commit</th>
                <th className="hide-sm">By</th>
                <th>Live at</th>
                <th className="right">Incidents</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="clickable" onClick={() => setParam('open', d.id)}>
                  <td>
                    <span className="num">{depLabel(d.number)}</span> <strong>{d.version ?? d.external_id}</strong>
                    <div className="row small muted" style={{ marginTop: 2 }}>
                      {d.service && <span className="badge outline">{d.service}</span>}
                      <span>{d.environment ?? '? env'}</span>
                      {d.gaps.length > 0 && <span className="badge dashed">missing {d.gaps.join(', ')}</span>}
                      {d.conflicts.length > 0 && (
                        <span className="badge warn">
                          {d.conflicts.length} conflict{d.conflicts.length > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </td>
                  <td>
                    <DeployBadge status={d.status} />
                  </td>
                  <td className="hide-sm num">
                    {shortSha(d.commit_sha)}
                    {(d.commit_count ?? 0) > 1 && <span className="muted"> +{(d.commit_count ?? 1) - 1}</span>}
                  </td>
                  <td className="hide-sm">{d.deployed_by ?? '—'}</td>
                  <td className="num" title={dateTime(d.effective_at)}>
                    {clock(d.effective_at)}
                  </td>
                  <td className="right">
                    {d.confirmed_incidents ? <span className="badge danger">{d.confirmed_incidents} caused</span> : null}{' '}
                    {d.suspected_incidents ? <span className="badge warn">{d.suspected_incidents} suspected</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {recording && <RecordDeployment onClose={() => setRecording(false)} onDone={reload} />}
      {openId && <DeploymentDetail id={openId} onClose={() => setParam('open', null)} />}
    </div>
  );
}

function DeploymentDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { project } = useProject();
  const { data, error } = useApi<{ deployment: Deployment; commits: any[]; events: any[]; incidents: any[] }>(`/deployments/${id}`);
  const d = data?.deployment;
  return (
    <Modal title={d ? `Deploy ${depLabel(d.number)} · ${d.version ?? d.external_id}` : 'Deploy'} onClose={onClose} wide>
      <ErrorBox error={error} />
      {!d ? (
        <Loading />
      ) : (
        <>
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <DeployBadge status={d.status} />
            </dd>
            <dt>External id</dt>
            <dd className="mono">{d.external_id}</dd>
            <dt>Service / env</dt>
            <dd>
              {d.service ?? '?'} → {d.environment ?? '?'}
            </dd>
            <dt>Started</dt>
            <dd>{dateTime(d.started_at)}</dd>
            <dt>Finished</dt>
            <dd>
              {dateTime(d.finished_at)}
              {d.started_at && d.finished_at && <span className="muted"> ({duration((+new Date(d.finished_at) - +new Date(d.started_at)) / 60000)})</span>}
            </dd>
            <dt>Commit</dt>
            <dd className="mono">{d.commit_sha ?? '—'}</dd>
            <dt>Deployed by</dt>
            <dd>{d.deployed_by ?? '—'}</dd>
            {d.url && (
              <>
                <dt>Link</dt>
                <dd>
                  <a href={d.url} target="_blank" rel="noreferrer" className="accent">
                    {d.url}
                  </a>
                </dd>
              </>
            )}
            {d.notes && (
              <>
                <dt>Notes</dt>
                <dd style={{ whiteSpace: 'pre-wrap' }}>{d.notes}</dd>
              </>
            )}
          </dl>
          {d.gaps.length > 0 && <div className="notice">Incomplete record — still missing: {d.gaps.join(', ')}. Later events will fill these in.</div>}
          {d.conflicts.length > 0 && (
            <div className="warn-box">
              <strong>Conflicting reports</strong> — the first value was kept; contradicting values are listed for review:
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {d.conflicts.map((c, i) => (
                  <li key={i}>
                    <strong>{c.field}</strong>: kept <code>{c.kept}</code>, rejected <code>{c.rejected}</code> (via {c.source}, {dateTime(c.occurred_at)})
                  </li>
                ))}
              </ul>
            </div>
          )}
          {data.incidents.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 6 }}>
                Linked incidents
              </div>
              {data.incidents.map((i) => (
                <div key={i.id} className="row small">
                  <SeverityBadge severity={i.severity} />
                  <Link to={`/projects/${project.id}/incidents/${i.id}`} onClick={onClose}>
                    {incLabel(i.number)} {i.title}
                  </Link>
                  <StatusBadge status={i.status} />
                  <span className="badge outline">{humanize(i.relation)}</span>
                </div>
              ))}
            </div>
          )}
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Commits ({data.commits.length})
            </div>
            {data.commits.length === 0 && <div className="muted small">None recorded.</div>}
            {data.commits.map((c) => (
              <div key={c.sha} className="small" style={{ padding: '4px 0' }}>
                <span className="mono">{shortSha(c.sha)}</span> {c.message ? c.message.split('\n')[0] : <em className="muted">details not received yet</em>}
                {c.author && <span className="muted"> — {c.author}</span>}
                {c.url && (
                  <a href={c.url} target="_blank" rel="noreferrer" className="accent" style={{ marginLeft: 6 }}>
                    diff ↗
                  </a>
                )}
              </div>
            ))}
          </div>
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Event history — how this record was assembled
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Happened</th>
                    <th>Received</th>
                    <th>Event</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((e) => (
                    <tr key={e.id}>
                      <td className="num small">{dateTime(e.occurred_at)}</td>
                      <td className="num small">{dateTime(e.received_at)}</td>
                      <td className="small">
                        {e.action} <span className="muted">via {e.source}</span> {e.late && <span className="badge warn">late</span>}{' '}
                        {e.out_of_order && <span className="badge info">out of order</span>} {e.duplicate_count > 0 && <span className="badge">+{e.duplicate_count} dup</span>}
                        {e.warnings.map((w: string) => (
                          <div key={w} style={{ color: 'var(--warn)' }}>
                            ⚠ {w}
                          </div>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </Modal>
  );
}

function RecordDeployment({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { project } = useProject();
  const toast = useToast();
  const key = useRef(newKey());
  const [form, setForm] = useState({
    deployment_id: '',
    version: '',
    service: '',
    environment: project.default_environment,
    status: 'succeeded',
    commit_sha: '',
    commits: '',
    occurred_at: toLocalInput(new Date()),
    notes: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api(`/projects/${project.id}/deployments`, {
        method: 'POST',
        idempotencyKey: key.current,
        body: {
          ...form,
          deployment_id: form.deployment_id || undefined,
          commits: form.commits ? form.commits.split(/[\s,]+/).filter(Boolean) : undefined,
          occurred_at: fromLocalInput(form.occurred_at),
        },
      });
      toast(r.status === 'updated' ? 'Merged into the existing deploy record' : r.status === 'duplicate' ? 'Already recorded' : 'Deploy recorded');
      r.warnings?.forEach((w: string) => toast(w));
      onDone();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Record a deploy" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <label className="field">
            <span>Version</span>
            <input value={form.version} onChange={set('version')} placeholder="v2.15.0" autoFocus />
          </label>
          <label className="field">
            <span>Status</span>
            <select value={form.status} onChange={set('status')}>
              {['pending', 'in_progress', 'succeeded', 'failed', 'rolled_back'].map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Service</span>
            <input value={form.service} onChange={set('service')} placeholder="checkout" />
          </label>
          <label className="field">
            <span>Environment</span>
            <input value={form.environment} onChange={set('environment')} />
          </label>
          <label className="field">
            <span>When</span>
            <input type="datetime-local" value={form.occurred_at} onChange={set('occurred_at')} required />
          </label>
          <label className="field">
            <span>Deploy id (optional)</span>
            <input value={form.deployment_id} onChange={set('deployment_id')} placeholder="CI run id — reuse to update" />
          </label>
        </div>
        <label className="field">
          <span>Head commit SHA</span>
          <input value={form.commit_sha} onChange={set('commit_sha')} className="mono" />
        </label>
        <label className="field">
          <span>Other commits in this deploy (space or comma separated)</span>
          <input value={form.commits} onChange={set('commits')} className="mono" />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea value={form.notes} onChange={set('notes')} rows={2} />
        </label>
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            Record
          </button>
        </div>
      </form>
    </Modal>
  );
}
