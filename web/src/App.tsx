import { useState } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useAuth } from './auth';
import { Logo } from './components/Icon';
import { NewProject } from './components/NewProject';
import { Loading } from './components/ui';
import AuditPage from './pages/AuditPage';
import ChangesPage from './pages/ChangesPage';
import DeploymentsPage from './pages/DeploymentsPage';
import IncidentDetail from './pages/IncidentDetail';
import IncidentsPage from './pages/IncidentsPage';
import Login from './pages/Login';
import Overview from './pages/Overview';
import ProjectLayout from './pages/ProjectLayout';
import ProjectSettings from './pages/ProjectSettings';
import RecurringPage from './pages/RecurringPage';
import TimelinePage from './pages/TimelinePage';
import UsersPage from './pages/UsersPage';
import { Shell, useShell } from './shell';

export default function App() {
  const { user, ready, can } = useAuth();
  if (!ready) return <Loading />;
  if (!user) return <Login />;

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/audit" element={can('admin') ? <AuditPage /> : <Navigate to="/" />} />
        <Route path="/users" element={can('admin') ? <UsersPage /> : <Navigate to="/" />} />
        <Route path="/projects/:projectId" element={<ProjectLayout />}>
          <Route index element={<Overview />} />
          <Route path="timeline" element={<TimelinePage />} />
          <Route path="incidents" element={<IncidentsPage />} />
          <Route path="incidents/:incidentId" element={<IncidentDetail />} />
          <Route path="deploys" element={<DeploymentsPage />} />
          <Route path="changes" element={<ChangesPage />} />
          <Route path="recurring" element={<RecurringPage />} />
          <Route path="integrations" element={can('admin') ? <ProjectSettings /> : <Navigate to=".." />} />
          {/* older links */}
          <Route path="deployments" element={<Redirect to="deploys" />} />
          <Route path="settings" element={<Redirect to="integrations" />} />
        </Route>
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Shell>
  );
}

function Redirect({ to }: { to: string }) {
  const { projectId } = useParams();
  return <Navigate to={`/projects/${projectId}/${to}${window.location.search}`} replace />;
}

/** "/" goes to the last (or first) project; with no projects, offer to create one. */
function Home() {
  const { projectId, projects, projectsLoaded } = useShell();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  if (projectId) return <Navigate to={`/projects/${projectId}`} replace />;
  if (!projectsLoaded) return <Loading />;
  if (projects.length === 0) {
    return (
      <div className="card card-pad" style={{ maxWidth: 560, margin: '60px auto', textAlign: 'center' }}>
        <Logo size={40} />
        <h1 style={{ marginTop: 12 }}>No projects yet</h1>
        <p className="muted" style={{ margin: '8px 0 18px' }}>
          A project groups the deploys, changes and incidents of one service or repository.
        </p>
        {can('admin') ? (
          <button className="btn primary" onClick={() => setCreating(true)}>
            Create the first project
          </button>
        ) : (
          <p className="muted small">Ask an admin to create one.</p>
        )}
        {creating && <NewProject onClose={() => setCreating(false)} />}
      </div>
    );
  }
  return <Loading />;
}
