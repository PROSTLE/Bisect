import { Outlet, useOutletContext, useParams } from 'react-router-dom';
import { ErrorBox, Loading } from '../components/ui';
import { useApi } from '../hooks';
import type { Project } from '../types';

interface ProjectContext {
  project: Project;
  reloadProject: () => void;
}

export function useProject() {
  return useOutletContext<ProjectContext>();
}

/** Loads the project (including secrets for admins) for every page under /projects/:projectId. */
export default function ProjectLayout() {
  const { projectId } = useParams();
  const { data, error, reload } = useApi<{ project: Project }>(`/projects/${projectId}`);
  if (error) return <ErrorBox error={error} />;
  if (!data || data.project.id !== projectId) return <Loading />;
  return <Outlet context={{ project: data.project, reloadProject: () => void reload() } satisfies ProjectContext} />;
}
