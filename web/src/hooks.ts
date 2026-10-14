import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText, getToken } from './api';
import type { StreamMessage } from './types';

/** Fetch JSON; keeps showing the previous data while reloading so live refreshes don't flicker. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const id = ++seq.current;
    setLoading(true);
    try {
      const r = await api<T>(path);
      if (id === seq.current) {
        setData(r);
        setError(null);
      }
    } catch (e) {
      if (id === seq.current) setError(errorText(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void load();
  }, [load]);

  return { data, error, loading, reload: load, setData };
}

/**
 * Subscribe to the project's live event stream (SSE). The handler is kept in a ref so callers can
 * pass an inline function without reconnecting on every render.
 */
export function useStream(projectId: string | undefined, handler: (msg: StreamMessage) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  const [connected, setConnected] = useState(false);
  // A password change swaps the token and revokes the old one; reconnect with the new one.
  const [token, setTokenState] = useState(getToken);
  useEffect(() => {
    const onToken = () => setTokenState(getToken());
    window.addEventListener('bisect:token', onToken);
    return () => window.removeEventListener('bisect:token', onToken);
  }, []);

  useEffect(() => {
    if (!token) return;
    const qs = new URLSearchParams({ token, ...(projectId ? { project_id: projectId } : {}) });
    const es = new EventSource(`/api/stream?${qs}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        ref.current(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    // React cleanup does not run on a full page unload. Close explicitly, otherwise Chrome can keep
    // the stream socket alive across reloads and exhaust its 6-connections-per-host HTTP/1.1 pool.
    const close = () => es.close();
    window.addEventListener('pagehide', close);
    return () => {
      window.removeEventListener('pagehide', close);
      es.close();
      setConnected(false);
    };
  }, [projectId, token]);

  return connected;
}

/** Collapse bursts of live events into one reload. */
export function useDebounced(fn: () => void, ms = 400) {
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const f = useRef(fn);
  f.current = fn;
  return useCallback(() => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => f.current(), ms);
  }, [ms]);
}

/** Re-render every `ms` — for live "12s ago" counters. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Tell the server "I'm looking at this incident" while the page is open (powers the presence avatars). */
export function usePresenceHeartbeat(incidentId: string | null | undefined) {
  useEffect(() => {
    if (!incidentId) return;
    const beat = () => {
      if (document.visibilityState === 'visible') void api(`/incidents/${incidentId}/presence`, { method: 'POST' }).catch(() => {});
    };
    beat();
    const t = setInterval(beat, 20_000);
    const onVis = () => beat();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      void api(`/incidents/${incidentId}/presence`, { method: 'DELETE' }).catch(() => {});
    };
  }, [incidentId]);
}
