import { Fragment, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorBox, Loading } from '../components/ui';
import { dateTime } from '../format';
import { useApi } from '../hooks';
import { useShell } from '../shell';

interface Entry {
  id: number;
  actor_label: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  project_name: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
}

const short = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 90 ? `${s.slice(0, 90)}…` : s;
};

export default function AuditPage() {
  const { projects } = useShell();
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project_id') ?? '';
  const entityType = params.get('entity_type') ?? '';
  const [open, setOpen] = useState<number | null>(null);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const qs = new URLSearchParams({ limit: '300', ...(projectId ? { project_id: projectId } : {}), ...(entityType ? { entity_type: entityType } : {}) });
  const { data, error } = useApi<{ entries: Entry[] }>(`/audit?${qs}`);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p>Every change, who made it, and exactly which fields changed. Click a row for the before/after diff.</p>
        </div>
      </div>
      <div className="filters">
        <select value={projectId} onChange={(e) => set('project_id', e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={entityType} onChange={(e) => set('entity_type', e.target.value)} aria-label="Entity type">
          <option value="">All entities</option>
          {['incident', 'deployment', 'change', 'project', 'user'].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </div>
      <ErrorBox error={error} />
      <div className="card table-wrap">
        {!data ? (
          <Loading />
        ) : data.entries.length === 0 ? (
          <div className="empty">No entries.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Action</th>
                <th className="hide-sm">Project</th>
                <th>Fields</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => {
                const keys = Object.keys(e.after ?? e.before ?? {});
                return (
                  <Fragment key={e.id}>
                    <tr className="clickable" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                      <td className="num small">{dateTime(e.created_at)}</td>
                      <td className="small">{e.actor_label}</td>
                      <td>
                        <span className="badge outline">{e.action}</span>
                      </td>
                      <td className="hide-sm small">{e.project_name ?? '—'}</td>
                      <td className="small muted">{keys.slice(0, 5).join(', ') || '—'}</td>
                    </tr>
                    {open === e.id && (
                      <tr>
                        <td colSpan={5} style={{ background: 'var(--surface-2)' }}>
                          {keys.length === 0 ? (
                            <span className="muted small">No field changes recorded for this action.</span>
                          ) : (
                            <table>
                              <thead>
                                <tr>
                                  <th>Field</th>
                                  <th>Before</th>
                                  <th>After</th>
                                </tr>
                              </thead>
                              <tbody>
                                {keys.map((k) => (
                                  <tr key={k}>
                                    <td className="small">{k}</td>
                                    <td className="small mono muted">{short(e.before?.[k]) ?? '—'}</td>
                                    <td className="small mono">{short(e.after?.[k]) ?? '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
