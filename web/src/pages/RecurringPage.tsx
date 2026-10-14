import { useState } from 'react';
import { RecurringList } from '../components/Recurring';
import { ErrorBox, Loading } from '../components/ui';
import { duration } from '../format';
import { useApi, useDebounced } from '../hooks';
import { useLive } from '../shell';
import type { RecurringGroup } from '../types';
import { useProject } from './ProjectLayout';

export default function RecurringPage() {
  const { project } = useProject();
  const [days, setDays] = useState(90);
  const { data, error, reload } = useApi<{ days: number; groups: RecurringGroup[] }>(`/projects/${project.id}/recurring?days=${days}`);
  const refresh = useDebounced(() => void reload(), 1000);
  useLive((m) => m.type.startsWith('incident') && refresh());

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <h1>Recurring issues</h1>
          <p>Incidents with the same error fingerprint, or the same service and similar wording, grouped together.</p>
        </div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 'auto' }} aria-label="Window">
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={180}>Last 180 days</option>
          <option value={365}>Last year</option>
        </select>
      </div>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : (
        <div className="grid cols-2">
          <div className="card">
            <div className="card-head">
              <h2>{data.groups.length} recurring group{data.groups.length === 1 ? '' : 's'}</h2>
            </div>
            <div className="card-body">
              <RecurringList groups={data.groups} days={data.days} projectId={project.id} showIncidents />
            </div>
          </div>
          <div className="card">
            <div className="card-head">
              <h2>What fixed them</h2>
            </div>
            <div className="card-body">
              {data.groups.length === 0 ? (
                <div className="empty small">Nothing to compare yet.</div>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Issue</th>
                      <th className="right">Resolved</th>
                      <th className="right">Median fix</th>
                      <th className="right">Confirmed causes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.groups.map((g) => (
                      <tr key={g.incidents[0].id}>
                        <td>{g.title}</td>
                        <td className="right num">
                          {g.resolved}/{g.count}
                        </td>
                        <td className="right num">{duration(g.median_resolve_minutes)}</td>
                        <td className="right small">
                          {[
                            g.confirmed_causes.deployment && `${g.confirmed_causes.deployment} deploy`,
                            g.confirmed_causes.config && `${g.confirmed_causes.config} config`,
                            g.confirmed_causes.commit && `${g.confirmed_causes.commit} commit`,
                          ]
                            .filter(Boolean)
                            .join(' · ') || <span className="muted">none confirmed</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
