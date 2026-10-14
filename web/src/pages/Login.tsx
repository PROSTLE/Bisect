import { useState, type FormEvent } from 'react';
import { errorText } from '../api';
import { useAuth } from '../auth';
import { Logo } from '../components/Icon';
import { ErrorBox, Loading } from '../components/ui';
import { useApi } from '../hooks';

/** Sign-in, or — on a brand-new install with no users — creation of the owner account. */
export default function Login() {
  const status = useApi<{ needed: boolean }>('/auth/setup');
  if (status.error) {
    return (
      <Shell>
        <ErrorBox error={`Cannot reach the server: ${status.error}`} />
      </Shell>
    );
  }
  if (!status.data) return <Loading />;
  return <Shell>{status.data.needed ? <SetupForm onRaceLost={() => void status.reload()} /> : <SignInForm />}</Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="login-wrap">
      <div className="card login-card">
        <div className="card-pad stack" style={{ gap: 18 }}>
          <div className="row" style={{ gap: 12 }}>
            <Logo size={38} />
            <div>
              <h1 style={{ fontSize: 26, letterSpacing: '-0.03em' }}>bisect</h1>
              <p className="muted small">Find the change that broke production.</p>
            </div>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

function SignInForm() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit} aria-label="Sign in">
      <label className="field">
        <span>Email</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </label>
      <ErrorBox error={error} />
      <button className="btn primary big" disabled={busy}>
        Sign in
      </button>
      <p className="muted small">No account? Ask an admin of this workspace to add you.</p>
    </form>
  );
}

function SetupForm({ onRaceLost }: { onRaceLost: () => void }) {
  const { setup } = useAuth();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (form.password !== form.confirm) {
      setError('The two passwords do not match');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await setup(form.name, form.email, form.password);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      if (/already has an owner/.test(errorText(err))) onRaceLost();
    }
  }

  return (
    <form className="stack" onSubmit={submit} aria-label="Create the owner account">
      <div className="notice small">
        <strong>Welcome.</strong> This workspace has no users yet. Create the owner account — it becomes the first admin, who adds everyone else.
      </div>
      <label className="field">
        <span>Your name</span>
        <input value={form.name} onChange={set('name')} autoComplete="name" required autoFocus />
      </label>
      <label className="field">
        <span>Work email</span>
        <input type="email" value={form.email} onChange={set('email')} autoComplete="username" required />
      </label>
      <label className="field">
        <span>Password (10+ characters)</span>
        <input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" minLength={10} required />
      </label>
      <label className="field">
        <span>Confirm password</span>
        <input type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" minLength={10} required />
      </label>
      <ErrorBox error={error} />
      <button className="btn primary big" disabled={busy}>
        Create owner account
      </button>
    </form>
  );
}
