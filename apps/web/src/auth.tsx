import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api/client.js';

export interface Me { userId: string; username: string; tenantId: string | null; tenants: { id: string; code: string; name: string }[]; permissions: string[]; sensitive: string[] }
interface AuthCtx { me: Me | null; loading: boolean; refresh(): Promise<void>; logout(): Promise<void>; can(code: string): boolean }
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try { setMe(await api<Me>('/api/auth/me')); } catch { setMe(null); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const value = useMemo<AuthCtx>(() => ({
    me, loading, refresh,
    logout: async () => { await api('/api/auth/logout', { method: 'POST' }); setMe(null); },
    can: (code) => !!me?.permissions.includes(code),
  }), [me, loading, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export function useAuth(): AuthCtx { const v = useContext(Ctx); if (!v) throw new Error('Thiếu AuthProvider'); return v; }
