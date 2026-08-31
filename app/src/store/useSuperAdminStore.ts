import { create } from 'zustand';
import { superAdminApiRequest } from '../utils/superAdminApi';
import { getSuperAdminToken, setSuperAdminToken, setSuperAdminUnauthorizedHandler } from '../utils/superAdminToken';

// Mirrors useAuthStore.ts's shape, but for the independent super-admin
// login (server/src/auth.ts's requireSuperAdmin) — deliberately no `user`/
// `company` here at all, since this credential isn't tied to any company
// or `users` row (see App.tsx's /supersuperadmin route and auth.ts's own
// doc comment for the "why independent" reasoning). `token` alone is
// enough to know whether the super-admin session is active.
interface SuperAdminState {
  token: string | null;
  loggingIn: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}

export const useSuperAdminStore = create<SuperAdminState>((set) => ({
  token: getSuperAdminToken(),
  loggingIn: false,
  error: null,

  login: async (username, password) => {
    set({ loggingIn: true, error: null });
    try {
      const { token } = await superAdminApiRequest<{ token: string }>('/api/superadmin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      setSuperAdminToken(token);
      set({ token, loggingIn: false });
    } catch (err) {
      set({ loggingIn: false, error: err instanceof Error ? err.message : 'Nepavyko prisijungti' });
      throw err;
    }
  },

  logout: () => {
    setSuperAdminToken(null);
    set({ token: null });
  },
}));

setSuperAdminUnauthorizedHandler(() => useSuperAdminStore.getState().logout());
