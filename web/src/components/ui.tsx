import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { hue, humanize, initials } from '../format';
import type { DeployStatus, IncidentStatus, Severity } from '../types';
import { Icon } from './Icon';

export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`badge ${severity}`}>{severity.toUpperCase()}</span>;
}

const STATUS_TONE: Record<IncidentStatus, string> = {
  open: 'danger',
  investigating: 'warn',
  identified: 'warn',
  mitigating: 'info',
  monitoring: 'info',
  resolved: 'ok',
  closed: 'outline',
};
export function StatusBadge({ status }: { status: IncidentStatus }) {
  return <span className={`badge ${STATUS_TONE[status]}`}>{status}</span>;
}

const DEPLOY_TONE: Record<DeployStatus, string> = {
  pending: 'outline',
  in_progress: 'info',
  succeeded: 'ok',
  failed: 'danger',
  rolled_back: 'warn',
  unknown: 'outline',
};
export function DeployBadge({ status }: { status: DeployStatus }) {
  return <span className={`badge ${DEPLOY_TONE[status]}`}>{humanize(status)}</span>;
}

export function Tone({ tone, children }: { tone: string; children: ReactNode }) {
  const cls = tone === 'danger' ? 'badge danger' : tone === 'warn' ? 'badge dashed' : tone === 'info' ? 'badge info' : 'badge muted';
  return <span className={cls}>{children}</span>;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="empty">{label}</div>;
}

export function ErrorBox({ error }: { error: string | null | undefined }) {
  return error ? (
    <div className="error-box" role="alert">
      {error}
    </div>
  ) : null;
}

export function Avatar({ name, size }: { name: string | null | undefined; size?: 'sm' }) {
  if (!name) {
    return (
      <span className={`avatar system ${size ?? ''}`} title="System">
        ⚙
      </span>
    );
  }
  return (
    <span className={`avatar tinted ${size ?? ''}`} style={{ ['--h' as string]: hue(name) }} title={name}>
      {initials(name)}
    </span>
  );
}

export function Meter({ value, color, thin }: { value: number; color?: string; thin?: boolean }) {
  return (
    <div className={`meter ${thin ? 'thin' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <span style={{ width: `${Math.max(2, Math.min(100, value * 100))}%`, ...(color ? { background: color } : {}) }} />
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal" role="dialog" aria-modal="true" aria-label={title} style={wide ? { maxWidth: 820 } : undefined}>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <div className="card-body">{children}</div>
      </div>
    </div>
  );
}

/** Confirmation dialog for consequential actions (rollback requests, secret rotation). */
export function Confirm({
  title,
  children,
  confirmLabel,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="stack" style={{ color: 'var(--text-2)' }}>
        {children}
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function Stat({ value, label, tone }: { value: ReactNode; label: ReactNode; tone?: 'warn' | 'accent' }) {
  return (
    <div className="stat">
      <div className={`value ${tone ?? ''}`}>{value}</div>
      <div className="hint">{label}</div>
    </div>
  );
}

// ---- toasts --------------------------------------------------------------------------------

const ToastContext = createContext<(msg: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const push = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            {t.msg}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
