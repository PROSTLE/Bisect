import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, getToken, setToken } from './api';
import type { Role, User } from './types';

interface AuthState {
  user: User | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  setup: (name: string, email: string, password: string) => Promise<void>;
  /** Swap in a fresh token (after a password change revokes the old one). */
  adoptToken: (token: string) => void;
  logout: () => void;
  can: (role: Role) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);
const RANK: Record<Role, number> = { viewer: 0, engineer: 1, admin: 2 };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      setReady(true);
      return;
    }
    api<{ user: User }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    const onLogout = () => setUser(null);
    window.addEventListener('bisect:logout', onLogout);
    return () => window.removeEventListener('bisect:logout', onLogout);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const r = await api<{ token: string; user: User }>('/auth/login', { method: 'POST', body: { email, password } });
    setToken(r.token);
    setUser(r.user);
  }, []);

  const setup = useCallback(async (name: string, email: string, password: string) => {
    const r = await api<{ token: string; user: User }>('/auth/setup', { method: 'POST', body: { name, email, password } });
    setToken(r.token);
    setUser(r.user);
  }, []);

  const adoptToken = useCallback((token: string) => setToken(token), []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  const can = useCallback((role: Role) => !!user && RANK[user.role] >= RANK[role], [user]);

  return <AuthContext.Provider value={{ user, ready, login, setup, adoptToken, logout, can }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
