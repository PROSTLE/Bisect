import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, Modal, useToast } from './ui';

/** "Your account": change my password. Other sessions are signed out; this one gets a fresh token. */
export function AccountModal({ onClose }: { onClose: () => void }) {
  const { user, adoptToken, logout } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (form.next !== form.confirm) {
      setError('The new passwords do not match');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ token: string }>('/auth/password', { method: 'POST', body: { current_password: form.current, new_password: form.next } });
      adoptToken(r.token);
      toast('Password changed — other sessions were signed out');
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Your account" onClose={onClose}>
      <dl className="kv">
        <dt>Name</dt>
        <dd>{user?.name}</dd>
        <dt>Email</dt>
        <dd>{user?.email}</dd>
        <dt>Role</dt>
        <dd>{user?.role}</dd>
      </dl>
      <form className="stack" onSubmit={submit} aria-label="Change password">
        <div className="label">Change password</div>
        <label className="field">
          <span>Current password</span>
          <input type="password" value={form.current} onChange={set('current')} autoComplete="current-password" required />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>New password (10+ characters)</span>
            <input type="password" value={form.next} onChange={set('next')} autoComplete="new-password" minLength={10} required />
          </label>
          <label className="field">
            <span>Confirm new password</span>
            <input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" minLength={10} required />
          </label>
        </div>
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={logout} style={{ marginRight: 'auto' }}>
            Sign out
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" disabled={busy}>
            Change password
          </button>
        </div>
      </form>
    </Modal>
  );
}
