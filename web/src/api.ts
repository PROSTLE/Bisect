export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: any,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'bisect.token';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let token: string | null = readToken();

export function getToken() {
  return token;
}

export function setToken(t: string | null) {
  const changed = t !== token;
  token = t;
  // Long-lived connections (the SSE stream) carry the token in their URL and must reconnect.
  if (changed) window.dispatchEvent(new Event('bisect:token'));
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable — session-only login */
  }
}

interface Options {
  method?: string;
  body?: unknown;
  /** Send an Idempotency-Key so a double-submit or network retry cannot create duplicates. */
  idempotencyKey?: string;
}

export async function api<T = any>(path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // e.g. the dev proxy's HTML/plain-text error page while the API is down
    throw new ApiError(res.status, 'bad_response', res.ok ? 'The server sent an unreadable response' : `Cannot reach the API (${res.status} ${res.statusText})`);
  }
  if (!res.ok) {
    if (res.status === 401 && token) {
      setToken(null);
      window.dispatchEvent(new Event('bisect:logout'));
    }
    throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? res.statusText, data?.error?.details);
  }
  return data as T;
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'validation_error' && Array.isArray(err.details)) {
      return err.details.map((d: any) => (d.path ? `${d.path}: ${d.message}` : d.message)).join('; ');
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
