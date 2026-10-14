import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorText } from '../api';
import { depLabel, incLabel, shortSha } from '../format';
import { useDebounced } from '../hooks';
import { useShell } from '../shell';
import { Icon } from './Icon';
import { SeverityBadge } from './ui';

interface Results {
  incidents: { id: string; project_id: string; number: number; title: string; severity: any; status: string; project_name: string }[];
  deployments: { id: string; project_id: string; number: number; version: string | null; environment: string | null; status: string; commit_sha: string | null; project_name: string }[];
  changes: { id: string; project_id: string; sha: string; kind: string; message: string; author: string | null; project_name: string }[];
  people: { id: string; name: string; email: string; role: string }[];
  projects: { id: string; name: string; slug: string }[];
}

interface Item {
  key: string;
  group: string;
  label: React.ReactNode;
  hint: string;
  go: () => void;
}

/** ⌘K / Ctrl+K search across incidents (INC-102), deploys (#2481), SHAs, people and projects. */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { projectId } = useShell();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Results | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);

  const run = useDebounced(async () => {
    try {
      setResults(await api<Results>(`/search?q=${encodeURIComponent(q)}`));
      setError(null);
      setCursor(0);
    } catch (e) {
      setError(errorText(e));
    }
  }, 180);
  useEffect(() => {
    if (q.trim()) run();
    else setResults(null);
  }, [q, run]);

  const items = useMemo<Item[]>(() => {
    if (!results) return [];
    const go = (to: string) => () => {
      navigate(to);
      onClose();
    };
    return [
      ...results.incidents.map((i) => ({
        key: `i${i.id}`,
        group: 'Incidents',
        label: (
          <>
            <SeverityBadge severity={i.severity} /> <span className="mono">{incLabel(i.number)}</span> <span className="grow">{i.title}</span>
          </>
        ),
        hint: `${i.project_name} · ${i.status}`,
        go: go(`/projects/${i.project_id}/incidents/${i.id}`),
      })),
      ...results.deployments.map((d) => ({
        key: `d${d.id}`,
        group: 'Deploys',
        label: (
          <>
            <span className="mono">{depLabel(d.number)}</span> <span className="grow">{d.version ?? ''} {d.environment ? `→ ${d.environment}` : ''}</span>
          </>
        ),
        hint: `${d.project_name} · ${d.status.replace('_', ' ')}${d.commit_sha ? ` · ${shortSha(d.commit_sha)}` : ''}`,
        go: go(`/projects/${d.project_id}/deploys?open=${d.id}`),
      })),
      ...results.changes.map((c) => ({
        key: `c${c.id}`,
        group: 'Changes',
        label: (
          <>
            <span className="mono">{shortSha(c.sha)}</span> <span className="grow">{c.message.split('\n')[0]}</span>
          </>
        ),
        hint: `${c.project_name}${c.author ? ` · ${c.author}` : ''}${c.kind === 'config' ? ' · config' : ''}`,
        go: go(`/projects/${c.project_id}/changes?q=${c.sha.slice(0, 10)}`),
      })),
      ...(projectId
        ? results.people.map((u) => ({
            key: `u${u.id}`,
            group: 'People — their incidents in this project',
            label: <span className="grow">{u.name}</span>,
            hint: `${u.email} · ${u.role}`,
            go: go(`/projects/${projectId}/incidents?assignee=${u.id}&status=all`),
          }))
        : []),
      ...results.projects.map((p) => ({
        key: `p${p.id}`,
        group: 'Projects',
        label: <span className="grow">{p.name}</span>,
        hint: p.slug,
        go: go(`/projects/${p.id}`),
      })),
    ];
  }, [results, navigate, onClose, projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(items.length - 1, c + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(0, c - 1));
      } else if (e.key === 'Enter' && items[cursor]) {
        e.preventDefault();
        items[cursor].go();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, cursor, onClose]);

  let lastGroup = '';
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card palette" role="dialog" aria-label="Search">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="INC-102, #2481, a1b2c3d, a person or a project…" aria-label="Search query" />
        <div className="palette-results">
          {error && <div className="error-box">{error}</div>}
          {!q.trim() && <div className="empty small">Search incidents by number or title, deploys by #number, version or SHA, commits, people and projects.</div>}
          {q.trim() && results && items.length === 0 && <div className="empty small">Nothing matches “{q}”.</div>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? (lastGroup = it.group) : null;
            return (
              <div key={it.key}>
                {header && <div className="palette-group label">{header}</div>}
                <button className={`palette-item ${i === cursor ? 'on' : ''}`} onMouseEnter={() => setCursor(i)} onClick={it.go}>
                  {it.label}
                  <span className="muted small hide-sm">{it.hint}</span>
                  <Icon name="arrow" size={14} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
