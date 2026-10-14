import { useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, errorText, newKey } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../components/Icon';
import { DeployBadge, ErrorBox, Loading, Modal, useToast } from '../components/ui';
import { dateTime, depLabel, fromLocalInput, shortSha, timeAgo, toLocalInput } from '../format';
import { useApi, useDebounced } from '../hooks';
import { useLive } from '../shell';
import type { Change } from '../types';
import { useProject } from './ProjectLayout';

export default function ChangesPage() {
  const { project } = useProject();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const kind = params.get('kind') ?? '';
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const [recording, setRecording] = useState(false);
  const { data, error, reload } = useApi<{ changes: Change[] }>(`/projects/${project.id}/changes?limit=500`);
  const refresh = useDebounced(() => void reload(), 500);
  useLive((m) => m.type === 'event.recorded' && m.data.kind !== 'incident' && refresh());

  const needle = q.toLowerCase();
  const rows = (data?.changes ?? []).filter(
    (c) =>
      (!kind || c.kind === kind) &&
      (!needle || c.message.toLowerCase().includes(needle) || c.sha.startsWith(needle) || (c.author ?? '').toLowerCase().includes(needle) || c.files.some((f) => f.toLowerCase().includes(needle))),
  );

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Changes</h1>
          <p>Commits and config changes — including the ones that never got a deploy record.</p>
        </div>
        {can('engineer') && (
          <button className="btn dark" onClick={() => setRecording(true)}>
            <Icon name="plus" size={14} /> Record change
          </button>
        )}
      </div>
      <div className="filters">
        <input placeholder="Filter by message, SHA, author or file…" value={q} onChange={(e) => setParam('q', e.target.value)} style={{ minWidth: 320 }} aria-label="Filter changes" />
        <select value={kind} onChange={(e) => setParam('kind', e.target.value)} aria-label="Kind">
          <option value="">Commits and config</option>
          <option value="commit">Commits</option>
          <option value="config">Config changes</option>
        </select>
      </div>
      <ErrorBox error={error} />
      <div className="card table-wrap">
        {!data ? (
          <Loading />
        ) : rows.length === 0 ? (
          <div className="empty">No changes match. Connect the GitHub webhook under Integrations to track commits automatically.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>SHA</th>
                <th>Change</th>
                <th className="hide-sm">Files</th>
                <th>Shipped in</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className={c.kind === 'config' && c.deployments.length === 0 ? 'tone-warn' : ''}>
                  <td className="num">
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer" className="accent">
                        {shortSha(c.sha)}
                      </a>
                    ) : (
                      shortSha(c.sha)
                    )}
                    <div className="muted small" title={dateTime(c.committed_at)}>
                      {timeAgo(c.committed_at)}
                    </div>
                  </td>
                  <td>
                    {c.kind === 'config' && <span className="badge dashed" style={{ marginRight: 6 }}>config</span>}
                    {c.message.split('\n')[0] || <em className="muted">no message</em>}
                    <div className="muted small">
                      {c.author ?? 'unknown author'}
                      {c.branch && ` · ${c.branch}`} · via {c.source}
                    </div>
                  </td>
                  <td className="hide-sm mono small muted" style={{ maxWidth: 260 }}>
                    {c.files.slice(0, 4).join(', ')}
                    {c.files.length > 4 && ` +${c.files.length - 4}`}
                  </td>
                  <td>
                    <div className="stack" style={{ gap: 4 }}>
                      {c.deployments.length === 0 && <span className={`small ${c.kind === 'config' ? '' : 'muted'}`} style={c.kind === 'config' ? { color: 'var(--warn)' } : undefined}>{c.kind === 'config' ? 'no deploy record' : 'not deployed'}</span>}
                      {c.deployments.map((d) => (
                        <Link key={d.id} to={`/projects/${project.id}/deploys?open=${d.id}`} className="row small">
                          <span className="num">{depLabel(d.number)}</span> <span className="muted">{d.environment}</span> <DeployBadge status={d.status} />
                        </Link>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {recording && <RecordChange onClose={() => setRecording(false)} onDone={reload} />}
    </div>
  );
}

function RecordChange({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { project } = useProject();
  const toast = useToast();
  const key = useRef(newKey());
  const [form, setForm] = useState({ sha: '', kind: 'commit', message: '', author: '', branch: 'main', files: '', deployment_id: '', occurred_at: toLocalInput(new Date()) });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api(`/projects/${project.id}/changes`, {
        method: 'POST',
        idempotencyKey: key.current,
        body: { ...form, files: form.files.split(/[\s,]+/).filter(Boolean), deployment_id: form.deployment_id || undefined, occurred_at: fromLocalInput(form.occurred_at) },
      });
      toast(r.status === 'duplicate' ? 'This change was already recorded' : 'Change recorded');
      r.warnings?.forEach((w: string) => toast(w));
      onDone();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Record a change" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <label className="field">
            <span>SHA / change id</span>
            <input value={form.sha} onChange={set('sha')} required minLength={4} className="mono" autoFocus />
          </label>
          <label className="field">
            <span>Kind</span>
            <select value={form.kind} onChange={set('kind')}>
              <option value="commit">Commit</option>
              <option value="config">Config change (terraform, flags, env vars)</option>
            </select>
          </label>
          <label className="field">
            <span>Author</span>
            <input value={form.author} onChange={set('author')} />
          </label>
          <label className="field">
            <span>When</span>
            <input type="datetime-local" value={form.occurred_at} onChange={set('occurred_at')} />
          </label>
        </div>
        <label className="field">
          <span>Message</span>
          <textarea value={form.message} onChange={set('message')} rows={2} />
        </label>
        <label className="field">
          <span>Files changed (space or comma separated)</span>
          <input value={form.files} onChange={set('files')} className="mono" />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>Branch</span>
            <input value={form.branch} onChange={set('branch')} />
          </label>
          <label className="field">
            <span>Deploy id it shipped in (optional)</span>
            <input value={form.deployment_id} onChange={set('deployment_id')} placeholder="CI run id" />
          </label>
        </div>
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
