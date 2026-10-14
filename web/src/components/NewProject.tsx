import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorText } from '../api';
import type { Project } from '../types';
import { ErrorBox, Modal } from './ui';

export function NewProject({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', description: '', repo_url: '', default_environment: 'production' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ project: Project }>('/projects', { method: 'POST', body: { ...form, repo_url: form.repo_url || null } });
      onClose();
      // full navigation so the sidebar project list refreshes
      navigate(`/projects/${r.project.id}/integrations`);
      window.dispatchEvent(new Event('bisect:projects-changed'));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="New project" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input value={form.name} onChange={set('name')} required minLength={2} autoFocus placeholder="storefront-api" />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea value={form.description} onChange={set('description')} />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>Repository URL</span>
            <input type="url" value={form.repo_url} onChange={set('repo_url')} placeholder="https://github.com/org/repo" />
          </label>
          <label className="field">
            <span>Default environment</span>
            <input value={form.default_environment} onChange={set('default_environment')} required />
          </label>
        </div>
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            Create project
          </button>
        </div>
      </form>
    </Modal>
  );
}
