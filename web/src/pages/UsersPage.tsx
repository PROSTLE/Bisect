import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../components/Icon';
import { Avatar, ErrorBox, Loading, Modal, useToast } from '../components/ui';
import { useApi } from '../hooks';
import type { Role, User } from '../types';

const ROLES: { role: Role; desc: string }[] = [
  { role: 'viewer', desc: 'read-only' },
  { role: 'engineer', desc: 'record deploys, manage incidents' },
  { role: 'admin', desc: 'projects, users, secrets, audit log' },
];

export default function UsersPage() {
  const { user: me } = useAuth();
  const toast = useToast();
  const { data, error, reload } = useApi<{ users: User[] }>('/users');
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function changeRole(u: User, role: Role) {
    try {
      await api(`/users/${u.id}`, { method: 'PATCH', body: { role } });
      toast(`${u.name} is now ${role}`);
      setErr(null);
      void reload();
    } catch (e) {
      setErr(errorText(e));
    }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="page-head">
        <div>
          <h1>Users &amp; roles</h1>
          <p>{ROLES.map((r) => `${r.role}: ${r.desc}`).join(' · ')}</p>
        </div>
        <button className="btn dark" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> Add user
        </button>
      </div>
      <ErrorBox error={error ?? err} />
      <div className="card table-wrap">
        {!data ? (
          <Loading />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th className="right">Password</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td>
                    <span className="row">
                      <Avatar name={u.name} size="sm" /> {u.name}
                    </span>
                  </td>
                  <td className="muted">{u.email}</td>
                  <td>
                    <select
                      value={u.role}
                      onChange={(e) => changeRole(u, e.target.value as Role)}
                      disabled={u.id === me?.id}
                      title={u.id === me?.id ? "You can't change your own role" : undefined}
                      style={{ width: 'auto' }}
                      aria-label={`Role for ${u.name}`}
                    >
                      {ROLES.map((r) => (
                        <option key={r.role}>{r.role}</option>
                      ))}
                    </select>
                  </td>
                  <td className="right">
                    {u.id === me?.id ? (
                      <span className="muted small">change it under “Your account”</span>
                    ) : (
                      <button className="btn sm" onClick={() => setResetting(u)}>
                        Reset password
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {resetting && (
        <ResetPassword
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            toast(`${resetting.name}'s password was reset — they have been signed out`);
            setResetting(null);
          }}
        />
      )}
      {adding && (
        <AddUser
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            toast('User added');
            void reload();
          }}
        />
      )}
    </div>
  );
}

function AddUser({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', email: '', role: 'engineer', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/users', { method: 'POST', body: form });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add user" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <label className="field">
            <span>Name</span>
            <input value={form.name} onChange={set('name')} required autoFocus />
          </label>
          <label className="field">
            <span>Email</span>
            <input type="email" value={form.email} onChange={set('email')} required />
          </label>
          <label className="field">
            <span>Role</span>
            <select value={form.role} onChange={set('role')}>
              {ROLES.map((r) => (
                <option key={r.role}>{r.role}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Initial password (10+ characters)</span>
            <input type="password" value={form.password} onChange={set('password')} required minLength={10} autoComplete="new-password" />
          </label>
        </div>
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            Add user
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPassword({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/users/${user.id}`, { method: 'PATCH', body: { password } });
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={`Reset password · ${user.name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted small">Sets a new password and signs {user.name} out of every session. Share it with them over a secure channel.</p>
        <label className="field">
          <span>New password (10+ characters)</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required autoFocus autoComplete="new-password" />
        </label>
        <ErrorBox error={error} />
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            Reset password
          </button>
        </div>
      </form>
    </Modal>
  );
}
