import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorText } from '../api';
import { Icon } from '../components/Icon';
import { Confirm, ErrorBox, useToast } from '../components/ui';
import { useShell } from '../shell';
import { useProject } from './ProjectLayout';

function Secret({ label, value }: { label: string; value?: string }) {
  const [shown, setShown] = useState(false);
  const toast = useToast();
  if (!value) return null;
  return (
    <div className="field" style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span className="label">{label}</span>
      <div className="secret">
        <code>{shown ? value : '•'.repeat(Math.min(value.length, 32))}</code>
        <button type="button" className="btn sm" onClick={() => setShown(!shown)}>
          {shown ? 'Hide' : 'Show'}
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(
              () => toast(`${label} copied`),
              () => toast('Copy failed — select the value and copy it manually'),
            );
          }}
        >
          <Icon name="copy" size={13} /> Copy
        </button>
      </div>
    </div>
  );
}

export default function ProjectSettings() {
  const { project, reloadProject } = useProject();
  const { reloadProjects } = useShell();
  const toast = useToast();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'rotate' | 'archive' | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    name: project.name,
    description: project.description,
    repo_url: project.repo_url ?? '',
    default_environment: project.default_environment,
  });
  // The server builds webhook_url from PUBLIC_URL when set; use the same origin for the curl examples.
  const origin = project.webhook_url ? new URL(project.webhook_url).origin : window.location.origin;
  const dirty =
    form.name !== project.name || form.description !== project.description || form.repo_url !== (project.repo_url ?? '') || form.default_environment !== project.default_environment;

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${project.id}`, { method: 'PATCH', body: { ...form, repo_url: form.repo_url || null } });
      toast('Project saved');
      reloadProject();
      reloadProjects();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function act(kind: 'rotate' | 'archive') {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'rotate') {
        await api(`/projects/${project.id}/rotate-secrets`, { method: 'POST' });
        reloadProject();
        toast('Secrets rotated — update your CI and GitHub webhook');
      } else {
        await api(`/projects/${project.id}`, { method: 'DELETE' });
        reloadProjects();
        toast(`${project.name} archived`);
        navigate('/');
      }
      setConfirm(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const deployCurl = `curl -X POST ${origin}/api/projects/${project.id}/events \\
  -H "Content-Type: application/json" \\
  -H "X-Ingest-Token: $BISECT_TOKEN" \\
  -H "X-Event-Source: GitHub Actions" \\
  -d '{"events":[{
    "type": "deployment",
    "event_id": "'"$GITHUB_RUN_ID"'-done",
    "deployment_id": "'"$GITHUB_RUN_ID"'",
    "status": "succeeded",
    "version": "'"$GITHUB_REF_NAME"'",
    "commit_sha": "'"$GITHUB_SHA"'",
    "environment": "${project.default_environment}",
    "service": "api",
    "occurred_at": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"
  }]}'`;

  const metricsCurl = `curl -X POST ${origin}/api/projects/${project.id}/metrics \\
  -H "Content-Type: application/json" \\
  -H "X-Ingest-Token: $BISECT_TOKEN" \\
  -d '{"points":[{"name":"error_rate","service":"checkout",
                  "at":"2026-10-14T09:14:00Z","value":16.4}]}'`;

  const alert = `{
  "type": "incident",
  "alert_id": "pagerduty-12345",        // same id later = same incident
  "title": "Checkout API error rate > 5%",
  "error_signature": "pq: sorry, too many clients already",
  "severity": "sev2",
  "service": "checkout",
  "status": "open",                      // send "resolved" to close it
  "occurred_at": "2026-10-14T09:12:00Z"
}`;

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <h1>Integrations &amp; settings</h1>
          <p>Connect GitHub, CI, your alerting tool and metrics. Everything they send goes through the same dedup and ordering pipeline.</p>
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>GitHub webhook</h2>
          </div>
          <div className="card-body stack">
            <p className="muted small">
              Repository → <strong>Settings → Webhooks → Add webhook</strong>. Content type <code>application/json</code>. Events: <em>Pushes</em>, <em>Deployments</em>,{' '}
              <em>Deployment statuses</em>. Signatures are verified; redeliveries are deduplicated.
            </p>
            <Secret label="Payload URL" value={project.webhook_url} />
            <Secret label="Secret" value={project.webhook_secret} />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Ingest token</h2>
            <button className="btn sm" onClick={() => setConfirm('rotate')}>
              Rotate secrets
            </button>
          </div>
          <div className="card-body stack">
            <Secret label="X-Ingest-Token" value={project.ingest_token} />
            <p className="muted small">
              Used by CI, alerting tools and metric shippers. Add <code>X-Event-Source: Kubernetes</code> (or any name) so each integration shows up separately under “Event
              sources”.
            </p>
          </div>
        </div>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>Report a deploy from CI</h2>
          </div>
          <div className="card-body stack">
            <p className="muted small">
              Send <code>started</code> when the job begins and <code>succeeded</code>/<code>failed</code> at the end with the same <code>deployment_id</code>. Order and retries
              don't matter.
            </p>
            <pre className="code">{deployCurl}</pre>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Alerts &amp; metrics</h2>
          </div>
          <div className="card-body stack">
            <p className="muted small">Open (and later resolve) an incident from your alerting tool via the events endpoint:</p>
            <pre className="code">{alert}</pre>
            <p className="muted small">Push error-rate samples (percent) so suspects are ranked against the real onset and the overview can draw the error lane:</p>
            <pre className="code">{metricsCurl}</pre>
          </div>
        </div>
      </div>
      <form className="card" onSubmit={save}>
        <div className="card-head">
          <h2>Project</h2>
          <div className="row">
            <button type="button" className="btn sm" onClick={() => setConfirm('archive')}>
              Archive project
            </button>
            <button className="btn primary sm" disabled={!dirty || busy}>
              Save
            </button>
          </div>
        </div>
        <div className="card-body stack">
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} />
            </label>
            <label className="field">
              <span>Default environment</span>
              <input value={form.default_environment} onChange={(e) => setForm({ ...form, default_environment: e.target.value })} required />
            </label>
            <label className="field">
              <span>Repository URL</span>
              <input type="url" value={form.repo_url} onChange={(e) => setForm({ ...form, repo_url: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span>Description</span>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
          </label>
        </div>
      </form>
      {confirm === 'rotate' && (
        <Confirm title="Rotate secrets?" confirmLabel="Rotate" busy={busy} onConfirm={() => act('rotate')} onClose={() => setConfirm(null)}>
          <p>The ingest token and webhook secret are replaced immediately. CI jobs and the GitHub webhook stop working until you update them.</p>
        </Confirm>
      )}
      {confirm === 'archive' && (
        <Confirm title={`Archive ${project.name}?`} confirmLabel="Archive" busy={busy} onConfirm={() => act('archive')} onClose={() => setConfirm(null)}>
          <p>The project disappears from the sidebar and stops accepting events. Its history stays in the database and the audit log.</p>
        </Confirm>
      )}
    </div>
  );
}
