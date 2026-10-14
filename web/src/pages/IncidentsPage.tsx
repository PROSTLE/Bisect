import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Avatar, ErrorBox, Loading, SeverityBadge, StatusBadge } from '../components/ui';
import { dateTime, incLabel, timeAgo } from '../format';
import { useApi, useDebounced } from '../hooks';
import { useLive } from '../shell';
import type { Incident, User } from '../types';
import { useProject } from './ProjectLayout';

export default function IncidentsPage() {
  const { project } = useProject();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'active';
  const severity = params.get('severity') ?? '';
  const assignee = params.get('assignee') ?? '';
  const q = params.get('q') ?? '';
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const qs = new URLSearchParams({ status, ...(severity ? { severity } : {}), ...(assignee ? { assignee_id: assignee } : {}), ...(q ? { q } : {}) });
  const { data, error, reload } = useApi<{ incidents: Incident[] }>(`/projects/${project.id}/incidents?${qs}`);
  const { data: users } = useApi<{ users: User[] }>('/users');
  const refresh = useDebounced(() => void reload(), 400);
  useLive((m) => m.type.startsWith('incident') && refresh());

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <p>Everything reported for {project.name}, from alerts and from people.</p>
        </div>
      </div>
      <div className="filters">
        <select value={status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="active">Active</option>
          <option value="all">All statuses</option>
          {['open', 'investigating', 'identified', 'mitigating', 'monitoring', 'resolved', 'closed'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select value={severity} onChange={(e) => set('severity', e.target.value)} aria-label="Severity">
          <option value="">All severities</option>
          {['sev1', 'sev2', 'sev3', 'sev4'].map((s) => (
            <option key={s} value={s}>
              {s.toUpperCase()}
            </option>
          ))}
        </select>
        <select value={assignee} onChange={(e) => set('assignee', e.target.value)} aria-label="Assignee">
          <option value="">Anyone</option>
          {users?.users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
        <input placeholder="Search title or description…" value={q} onChange={(e) => set('q', e.target.value)} aria-label="Search incidents" />
      </div>
      <ErrorBox error={error} />
      <div className="card table-wrap">
        {!data ? (
          <Loading />
        ) : data.incidents.length === 0 ? (
          <div className="empty">No incidents match.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Sev</th>
                <th>Incident</th>
                <th>Status</th>
                <th className="hide-sm">Owner</th>
                <th className="hide-sm">Detected</th>
              </tr>
            </thead>
            <tbody>
              {data.incidents.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => navigate(`/projects/${project.id}/incidents/${i.id}`)}>
                  <td>
                    <SeverityBadge severity={i.severity} />
                  </td>
                  <td>
                    <Link to={`/projects/${project.id}/incidents/${i.id}`} onClick={(e) => e.stopPropagation()}>
                      <span className="mono muted">{incLabel(i.number)}</span> <strong>{i.title}</strong>
                    </Link>
                    <div className="row small muted" style={{ marginTop: 2 }}>
                      {i.service && <span className="badge outline">{i.service}</span>}
                      {i.environment && <span>{i.environment}</span>}
                      {i.external_id && <span className="mono">{i.external_id}</span>}
                      {i.duplicate_of_number && <span className="badge outline">duplicate of {incLabel(i.duplicate_of_number)}</span>}
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={i.status} />
                  </td>
                  <td className="hide-sm">
                    {i.assignee_name ? (
                      <span className="row">
                        <Avatar name={i.assignee_name} size="sm" /> {i.assignee_name}
                      </span>
                    ) : (
                      <span className="muted">unassigned</span>
                    )}
                  </td>
                  <td className="hide-sm num" title={dateTime(i.detected_at)}>
                    {timeAgo(i.detected_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
