import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RANGES, Swimlanes, type RangeKey } from '../components/Swimlanes';
import { Timeline } from '../components/Timeline';
import { ErrorBox, Loading } from '../components/ui';
import { useApi, useDebounced } from '../hooks';
import { useLive, useShell } from '../shell';
import type { TimelineEvent } from '../types';
import { useProject } from './ProjectLayout';

const KINDS = ['deployment', 'change', 'incident'] as const;

export default function TimelinePage() {
  const { project } = useProject();
  const { overview } = useShell();
  const [params, setParams] = useSearchParams();
  const [range, setRange] = useState<RangeKey>('24h');
  const kinds = params.get('kinds')?.split(',') ?? [...KINDS];
  const flags = params.get('flags') ?? '';
  const qs = new URLSearchParams({ kinds: kinds.join(','), limit: '400', ...(flags ? { flags } : {}) });
  const { data, error, reload } = useApi<{ events: TimelineEvent[] }>(`/projects/${project.id}/timeline?${qs}`);
  const refresh = useDebounced(() => void reload(), 500);
  useLive((m) => m.type === 'event.recorded' && refresh());

  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const toggleKind = (k: string) => {
    const next = kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k];
    set('kinds', next.length === KINDS.length ? null : next.join(',') || 'none');
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <h1>Timeline</h1>
          <p>Everything that happened to {project.name}, in the order it happened — late and out-of-order reports are slotted into place and labelled.</p>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Swimlanes</h2>
          <div className="seg" role="tablist" aria-label="Range">
            {(Object.keys(RANGES) as RangeKey[]).map((r) => (
              <button key={r} className={r === range ? 'on' : ''} onClick={() => setRange(r)} role="tab" aria-selected={r === range}>
                {r}
              </button>
            ))}
          </div>
        </div>
        <div className="card-body">
          <Swimlanes
            projectId={project.id}
            anchor={null}
            anchorLabel="now"
            range={range}
            service={overview?.focus?.service}
            defaultEnvironment={project.default_environment}
          />
        </div>
      </div>
      <div className="card">
        <div className="card-head" style={{ flexWrap: 'wrap' }}>
          <div className="row">
            {KINDS.map((k) => (
              <label key={k} className="row small" style={{ gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={kinds.includes(k)} onChange={() => toggleKind(k)} />
                {k}s
              </label>
            ))}
          </div>
          <select value={flags} onChange={(e) => set('flags', e.target.value || null)} style={{ width: 'auto' }} aria-label="Filter">
            <option value="">All events</option>
            <option value="late">Reported late</option>
            <option value="out_of_order">Arrived out of order</option>
            <option value="duplicates">Had duplicates folded</option>
            <option value="warnings">Had conflicts / warnings</option>
          </select>
        </div>
        <div className="card-body">
          <ErrorBox error={error} />
          {!data ? <Loading /> : <Timeline events={data.events} projectId={project.id} />}
        </div>
      </div>
    </div>
  );
}
