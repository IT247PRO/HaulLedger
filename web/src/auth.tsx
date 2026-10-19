import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Me } from './api';

interface AuthState {
  me: Me | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  signup(input: { company_name: string; name: string; email: string; password: string }): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ user: Me }>('/auth/me')
      .then((r) => setMe(r.user))
      .catch(() => setMe(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setMe((await api<{ user: Me }>('/auth/login', { method: 'POST', body: { email, password } })).user);
  }, []);
  const signup = useCallback(async (input: { company_name: string; name: string; email: string; password: string }) => {
    setMe((await api<{ user: Me }>('/auth/signup', { method: 'POST', body: input })).user);
  }, []);
  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' });
    setMe(null);
  }, []);

  return <AuthContext.Provider value={{ me, loading, login, signup, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
