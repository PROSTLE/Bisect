import { useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, errorText, newKey } from '../api';
import { fromLocalInput, toLocalInput } from '../format';
import { useApi } from '../hooks';
import type { Project, User } from '../types';
import { ErrorBox, Modal, useToast } from './ui';

export function ReportIncident({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: users } = useApi<{ users: User[] }>('/users');
  const { data: proj } = useApi<{ project: Project }>(`/projects/${projectId}`);
  const key = useRef(newKey()); // one key per form instance → a double submit is a no-op
  const [form, setForm] = useState({ title: '', severity: 'sev3', service: '', environment: '', detected_at: toLocalInput(new Date()), description: '', assignee_id: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api(`/projects/${projectId}/incidents`, {
        method: 'POST',
        idempotencyKey: key.current,
        body: {
          ...form,
          environment: form.environment || proj?.project.default_environment,
          detected_at: fromLocalInput(form.detected_at),
          assignee_id: form.assignee_id || null,
        },
      });
      r.warnings?.forEach((w: string) => toast(w));
      if (r.late) toast('Recorded as a late report — the timeline places it at when it started.');
      onClose();
      navigate(`/projects/${projectId}/incidents/${r.entity_id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Report an incident" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          <span>What is broken?</span>
          <input value={form.title} onChange={set('title')} required minLength={3} autoFocus placeholder="Checkout returns 500 for logged-in users" />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>Severity</span>
            <select value={form.severity} onChange={set('severity')}>
              <option value="sev1">SEV1 — critical outage</option>
              <option value="sev2">SEV2 — major degradation</option>
              <option value="sev3">SEV3 — minor / partial</option>
              <option value="sev4">SEV4 — cosmetic</option>
            </select>
          </label>
          <label className="field">
            <span>Service</span>
            <input value={form.service} onChange={set('service')} placeholder="checkout" />
          </label>
          <label className="field">
            <span>Environment</span>
            <input value={form.environment} onChange={set('environment')} placeholder={proj?.project.default_environment ?? ''} />
          </label>
          <label className="field">
            <span>First noticed at</span>
            <input type="datetime-local" value={form.detected_at} onChange={set('detected_at')} required />
          </label>
        </div>
        <label className="field">
          <span>Assignee</span>
          <select value={form.assignee_id} onChange={set('assignee_id')}>
            <option value="">Unassigned</option>
            {users?.users
              .filter((u) => u.role !== 'viewer')
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>Details</span>
          <textarea value={form.description} onChange={set('description')} placeholder="Symptoms, error messages, affected users…" />
        </label>
        <p className="muted small">Reporting late? Set “first noticed at” to when it actually started — suspects are ranked against that time.</p>
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            Report incident
          </button>
        </div>
      </form>
    </Modal>
  );
}
