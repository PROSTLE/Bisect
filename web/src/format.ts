const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(iso).toLocaleDateString();
}

/** Compact age for live counters: "12s", "4m", "3h", "2d". */
export function shortAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 24h wall clock, "09:14". Shows the date too when it isn't today. */
export function clock(iso: string, withSeconds = false): string {
  const d = new Date(iso);
  const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: false });
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${t}`;
}

export function tzName(): string {
  const part = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
  return part?.value ?? '';
}

export function duration(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  const m = Math.round(minutes);
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.round(m / 1440)}d`;
}

export const minutesBetween = (a: string, b: string | number) => (new Date(b).getTime() - new Date(a).getTime()) / 60000;

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '—');
export const incLabel = (n: number) => `INC-${String(n).padStart(3, '0')}`;
export const depLabel = (n: number) => `#${n}`;

/** "2026-10-14T10:30" for <input type="datetime-local"> in local time. */
export function toLocalInput(iso: string | Date): string {
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : undefined);

export const humanize = (s: string) => s.replace(/_/g, ' ');

export const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

export const initials = (name: string | null | undefined) =>
  (name ?? '?')
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

/** Stable hue per person so avatars keep their colour everywhere. */
export function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

export const isUrl = (s: string | null | undefined) => !!s && /^https?:\/\//i.test(s);
