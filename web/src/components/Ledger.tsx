import { useNavigate } from 'react-router-dom';
import { clock, depLabel, shortSha } from '../format';
import type { LedgerRow } from '../types';
import { Tone } from './ui';

/** Deploys and out-of-band changes in one list, with what happened after each. */
export function Ledger({ rows, projectId, defaultEnvironment }: { rows: LedgerRow[]; projectId: string; defaultEnvironment: string }) {
  const navigate = useNavigate();
  if (rows.length === 0) return <div className="empty small">No deploys recorded yet.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Deploy</th>
            <th>Env</th>
            <th>What shipped</th>
            <th className="hide-sm">By</th>
            <th>Live at</th>
            <th className="right">After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const tone = r.after.tone === 'danger' || r.after.label.startsWith('suspect') ? 'tone-danger' : r.type === 'change' ? 'tone-warn' : '';
            const open = () => navigate(r.type === 'deployment' ? `/projects/${projectId}/deploys?open=${r.id}` : `/projects/${projectId}/changes?q=${r.sha?.slice(0, 10)}`);
            return (
              <tr key={`${r.type}-${r.id}`} className={`clickable ${tone}`} onClick={open}>
                <td className="num">{r.type === 'deployment' ? depLabel(r.number!) : '—'}</td>
                <td>{r.type === 'deployment' ? (r.environment ?? defaultEnvironment) : r.kind === 'config' ? 'config' : '—'}</td>
                <td>
                  {r.type === 'deployment' ? (
                    <>
                      {r.head?.message.split('\n')[0] ?? r.version ?? r.external_id}{' '}
                      {r.head && <span className="mono muted">{shortSha(r.head.sha)}</span>}
                      {(r.commit_count ?? 0) > 1 && <span className="mono muted"> +{(r.commit_count ?? 1) - 1}</span>}
                    </>
                  ) : (
                    <>
                      {r.message?.split('\n')[0]} <span className="mono muted">{shortSha(r.sha)}</span>
                    </>
                  )}
                </td>
                <td className="hide-sm">{r.type === 'deployment' ? r.deployed_by ?? r.head?.author ?? '—' : r.author ?? '—'}</td>
                <td className="num">{clock(r.at)}</td>
                <td className="right">
                  <Tone tone={r.after.tone}>{r.after.label}</Tone>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
