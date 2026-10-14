import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useMatch, useNavigate } from 'react-router-dom';
import { useAuth } from './auth';
import { AccountModal } from './components/Account';
import { CommandPalette } from './components/CommandPalette';
import { Icon, Logo } from './components/Icon';
import { NewProject } from './components/NewProject';
import { ReportIncident } from './components/ReportIncident';
import { Avatar, useToast } from './components/ui';
import { incLabel, shortAge } from './format';
import { useApi, useDebounced, useNow, useStream } from './hooks';
import type { Incident, Project, StreamMessage, Viewer } from './types';
import { useTheme } from './theme';

type Listener = (msg: StreamMessage) => void;

interface Overview {
  focus: Incident | null;
  active: { id: string; number: number; title: string; severity: string; status: string }[];
  data_fresh_at: string | null;
  presence: Record<string, Viewer[]>;
}

interface ShellState {
  projectId: string | null;
  projects: Project[];
  /** False until the project list has loaded once (so an empty list means empty, not loading). */
  projectsLoaded: boolean;
  overview: Overview | null;
  presence: Record<string, Viewer[]>;
  reloadProjects: () => void;
  reloadOverview: () => void;
  subscribe: (fn: Listener) => () => void;
  live: boolean;
  openReport: () => void;
}

const ShellContext = createContext<ShellState | null>(null);
export const useShell = () => {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useShell outside Shell');
  return ctx;
};

/** Run `fn` for every live message about the current project. */
export function useLive(fn: Listener) {
  const { subscribe } = useShell();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => subscribe((m) => ref.current(m)), [subscribe]);
}

const LAST_PROJECT = 'bisect.project';
export function rememberProject(id: string) {
  try {
    localStorage.setItem(LAST_PROJECT, id);
  } catch {
    /* ignore */
  }
}
export function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

export function health(p: Pick<Project, 'worst_open_severity'>): 'failing' | 'degraded' | null {
  if (!p.worst_open_severity) return null;
  return p.worst_open_severity === 'sev1' || p.worst_open_severity === 'sev2' ? 'failing' : 'degraded';
}

export function Shell({ children }: { children: ReactNode }) {
  const match = useMatch('/projects/:projectId/*');
  const routeProject = match?.params.projectId ?? null;
  const projects = useApi<{ projects: Project[] }>('/projects');
  const list = projects.data?.projects ?? [];
  const remembered = lastProject();
  // No route and nothing remembered: open the project that is most on fire.
  const worst = [...list].sort((a, b) => (a.worst_open_severity ?? 'z').localeCompare(b.worst_open_severity ?? 'z'))[0];
  const projectId = routeProject ?? list.find((p) => p.id === remembered)?.id ?? worst?.id ?? null;
  const overview = useApi<Overview>(projectId ? `/projects/${projectId}/overview` : null);
  const [presence, setPresence] = useState<Record<string, Viewer[]>>({});
  const [reporting, setReporting] = useState(false);
  const listeners = useRef(new Set<Listener>());
  const toast = useToast();
  const { user } = useAuth();

  useEffect(() => {
    if (routeProject) rememberProject(routeProject);
  }, [routeProject]);
  useEffect(() => {
    if (overview.data) setPresence(overview.data.presence);
  }, [overview.data]);
  useEffect(() => {
    const onChange = () => void projects.reload();
    window.addEventListener('bisect:projects-changed', onChange);
    return () => window.removeEventListener('bisect:projects-changed', onChange);
  }, [projects.reload]);

  const refreshOverview = useDebounced(() => void overview.reload(), 600);
  const refreshProjects = useDebounced(() => void projects.reload(), 1500);

  const live = useStream(projectId ?? undefined, (msg) => {
    if (msg.type === 'presence') {
      setPresence((p) => ({ ...p, [msg.data.incident_id]: msg.data.viewers }));
    } else {
      refreshOverview();
      if (msg.type.startsWith('incident')) refreshProjects();
    }
    listeners.current.forEach((l) => l(msg));
    const by = msg.data.by as string | undefined;
    if (!by || by === user?.name) return; // don't notify about my own actions
    const n = msg.data.number ? incLabel(msg.data.number) : 'an incident';
    if (msg.type === 'incident.suspect') toast(`New possible cause recorded for ${n}`);
    else if (msg.type === 'incident.comment') toast(`${by} posted an update on ${n}`);
    else if (msg.type === 'incident.updated' && msg.data.changed?.includes('conflict')) toast(`Edit conflict on ${n} — kept in the activity feed`);
    else if (msg.type === 'incident.updated' && msg.data.changed?.[0] === '*') toast(`New incident ${n}`);
    else if (msg.type === 'incident.updated') toast(`${by} updated ${n}`);
  });

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  const state: ShellState = {
    projectId,
    projects: projects.data?.projects ?? [],
    projectsLoaded: !!projects.data,
    overview: overview.data,
    presence,
    reloadProjects: () => void projects.reload(),
    reloadOverview: () => void overview.reload(),
    subscribe,
    live,
    openReport: () => setReporting(true),
  };

  return (
    <ShellContext.Provider value={state}>
      <div className="shell">
        <Sidebar />
        <div className="main">
          <Topbar />
          <main className="page">{children}</main>
        </div>
      </div>
      {reporting && projectId && <ReportIncident projectId={projectId} onClose={() => setReporting(false)} />}
    </ShellContext.Provider>
  );
}

// ---- sidebar ------------------------------------------------------------------------------

function Sidebar() {
  const { projectId, projects, overview, live } = useShell();
  const { user, logout, can } = useAuth();
  const [creating, setCreating] = useState(false);
  const [account, setAccount] = useState(false);
  const sources = useApi<{ sources: { name: string; last_received_at: string; last_24h: number }[] }>(projectId ? `/projects/${projectId}/sources` : null);
  const reloadSources = useDebounced(() => void sources.reload(), 2000);
  useLive(reloadSources);
  const now = useNow(1000);
  const base = projectId ? `/projects/${projectId}` : null;
  const activeCount = overview?.active.length ?? 0;

  return (
    <aside className="sidebar">
      <NavLink to={base ?? '/'} className="brand" aria-label="bisect home">
        <Logo />
        bisect
      </NavLink>
      {base && (
        <nav className="nav" aria-label="Project">
          <NavLink to={base} end>
            <Icon name="overview" /> Overview
          </NavLink>
          <NavLink to={`${base}/timeline`}>
            <Icon name="timeline" /> Timeline
          </NavLink>
          <NavLink to={`${base}/incidents`}>
            <Icon name="incidents" /> Incidents {activeCount > 0 && <span className="count">{activeCount}</span>}
          </NavLink>
          <NavLink to={`${base}/deploys`}>
            <Icon name="deploys" /> Deploys
          </NavLink>
          <NavLink to={`${base}/changes`}>
            <Icon name="changes" /> Changes
          </NavLink>
          <NavLink to={`${base}/recurring`}>
            <Icon name="recurring" /> Recurring
          </NavLink>
          {can('admin') && (
            <NavLink to={`/audit?project_id=${projectId}`}>
              <Icon name="audit" /> Audit log
            </NavLink>
          )}
          {can('admin') && (
            <NavLink to={`${base}/integrations`}>
              <Icon name="settings" /> Integrations
            </NavLink>
          )}
          {can('admin') && (
            <NavLink to="/users">
              <Icon name="users" /> Users
            </NavLink>
          )}
        </nav>
      )}

      <div className="side-section">
        <div className="label">Projects</div>
        {projects.map((p) => {
          const h = health(p);
          return (
            <NavLink key={p.id} to={`/projects/${p.id}`} className={`project-link ${p.id === projectId ? 'active' : ''}`}>
              <span className={`status-dot ${h ?? ''}`} />
              {p.name}
              {h && <span className={`health ${h}`}>{h}</span>}
            </NavLink>
          );
        })}
        {can('admin') && (
          <button className="side-button" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} /> New project
          </button>
        )}
      </div>

      <div className="side-bottom">
        {sources.data && sources.data.sources.length > 0 && (
          <div className="sources">
            <div className="row between">
              <span className="label">Event sources</span>
              <span className={`dot ${live ? 'live' : 'off'}`} title={live ? 'Live updates connected' : 'Live updates disconnected'} />
            </div>
            {sources.data.sources.map((s) => (
              <div key={s.name} className="row between" title={`${s.last_24h} events in the last 24h`}>
                <span>{s.name}</span>
                <span className="mono muted">{shortAge(s.last_received_at, now)}</span>
              </div>
            ))}
          </div>
        )}
        {user && (
          <div className="me">
            <Avatar name={user.name} />
            <button className="who linkish" style={{ textAlign: 'left', color: 'inherit' }} onClick={() => setAccount(true)} title="Your account" aria-label="Your account">
              <div style={{ fontWeight: 600 }}>{user.name}</div>
              <div className="label" style={{ textTransform: 'none' }}>
                role · {user.role}
              </div>
            </button>
            <button className="icon-btn" onClick={logout} title="Sign out" aria-label="Sign out">
              <Icon name="logout" />
            </button>
          </div>
        )}
      </div>
      {creating && <NewProject onClose={() => setCreating(false)} />}
      {account && <AccountModal onClose={() => setAccount(false)} />}
    </aside>
  );
}

// ---- top bar ------------------------------------------------------------------------------

function Topbar() {
  const { projectId, projects, overview, presence, openReport } = useShell();
  const { can } = useAuth();
  const { theme, toggle } = useTheme();
  const navigate = useNavigate();
  const [searching, setSearching] = useState(false);
  const [account, setAccount] = useState(false);
  const project = projects.find((p) => p.id === projectId);
  const focus = overview?.focus;
  const viewers = focus ? presence[focus.id] ?? [] : [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  return (
    <header className="topbar">
      {project && (
        <div className="crumbs hide-sm">
          <span>{project.name}</span>
          <span>/</span>
          <strong>{project.default_environment}</strong>
        </div>
      )}
      <button className="searchbox" onClick={() => setSearching(true)} aria-label="Search">
        <Icon name="search" />
        <span>Find a SHA, deploy, incident or person</span>
        <span className="kbd hide-sm">{mac ? '⌘K' : 'Ctrl K'}</span>
      </button>
      <div style={{ flex: 1 }} />
      {focus && viewers.length > 0 && (
        <button className="presence linkish" onClick={() => navigate(`/projects/${projectId}/incidents/${focus.id}`)} title={viewers.map((v) => v.name).join(', ')}>
          <span className="avatars">
            {viewers.slice(0, 4).map((v) => (
              <Avatar key={v.id} name={v.name} size="sm" />
            ))}
          </span>
          <span className="small">
            {viewers.length} in {incLabel(focus.number)}
          </span>
        </button>
      )}
      {projects.length > 0 && (
        <select className="mobile-only" value={projectId ?? ''} onChange={(e) => navigate(`/projects/${e.target.value}`)} aria-label="Switch project">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {health(p) ? ` · ${health(p)}` : ''}
            </option>
          ))}
        </select>
      )}
      <button className="icon-btn mobile-only" onClick={() => setAccount(true)} aria-label="Account menu" title="Your account">
        <Icon name="users" />
      </button>
      <button className="icon-btn" onClick={toggle} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`} aria-label="Toggle theme">
        <Icon name={theme === 'light' ? 'moon' : 'sun'} />
      </button>
      {can('engineer') && projectId && (
        <button className="btn dark" onClick={openReport}>
          <Icon name="plus" size={14} /> Report incident
        </button>
      )}
      {searching && <CommandPalette onClose={() => setSearching(false)} />}
      {account && <AccountModal onClose={() => setAccount(false)} />}
    </header>
  );
}
