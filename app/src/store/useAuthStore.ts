import { create } from 'zustand';
import { localApiRequest } from '../utils/localApi';
import { getAuthToken, setAuthToken, setUnauthorizedHandler } from '../utils/authToken';

export type Role = 'super_admin' | 'worker';

export interface UserPermissions {
  canDeleteRows: boolean;
  canDeleteColumns: boolean;
  canDeleteNotes: boolean;
  canEditContacts: boolean;
  canDeleteContacts: boolean;
  canExportImport: boolean;
  /** Right-click "Įterpti eilutę virš/žemiau" — see server/src/accounts/
   * db.ts's UserPermissions for why this (and canInsertColumns) is a UI-
   * only gate rather than something the server can independently enforce. */
  canInsertRows: boolean;
  /** Right-click "Įterpti stulpelį kairėje/dešinėje" — UI-only, see above. */
  canInsertColumns: boolean;
  /** Hiding a row or column — unlike insert, this IS server-enforced too
   * (see server/src/index.ts's PATCH /api/tables/:id/columns and
   * tableData/db.ts's sanitizeRowForWorker). */
  canHideRowsColumns: boolean;
  /** "Išvalyti turinį" context-menu item — text/phone/company/link and
   * note/contact clearing are already blocked server-side regardless of
   * this flag (see sanitizeRowForWorker); it mainly still controls date/
   * dropdown cells, which stay freely editable for the calendar/status
   * workflow either way. */
  canClearContent: boolean;
}

export interface AuthUser {
  id: string;
  companyId: string;
  username: string;
  firstName: string;
  lastName: string;
  role: Role;
  /** null for super_admin — they always see every tab their company's
   * enabledFeatures has; only a worker's tab set is ever restricted
   * further. See App.tsx's tab-bar filtering. */
  visibleTabs: string[] | null;
  permissions: UserPermissions;
  company: { id: string; name: string; enabledFeatures: string[] } | null;
}

interface AuthState {
  token: string | null;
  /** Hydrated from /api/auth/me (not decoded from the token itself, which
   * only carries userId/companyId/role) — fetched once on app mount
   * whenever a token exists, so a super-admin's live permission change
   * takes effect for a worker without forcing re-login. Null while
   * loading or logged out. */
  user: AuthUser | null;
  loggingIn: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  /** Used by RegistrationView — same shape as login (returns a session
   * token + user, logs the caller straight in), but creates a brand-new
   * company + its first super-admin instead of matching an existing one.
   * secret is whatever followed "/reg" in the URL. */
  register: (input: { secret: string; companyName: string; username: string; password: string; firstName: string; lastName: string }) => Promise<void>;
  fetchMe: () => Promise<void>;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  token: getAuthToken(),
  user: null,
  loggingIn: false,
  error: null,

  login: async (username, password) => {
    set({ loggingIn: true, error: null });
    try {
      const { token, user } = await localApiRequest<{ token: string; user: AuthUser }>('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      setAuthToken(token);
      set({ token, user, loggingIn: false });
    } catch (err) {
      set({ loggingIn: false, error: err instanceof Error ? err.message : 'Nepavyko prisijungti' });
      throw err;
    }
  },

  register: async (input) => {
    set({ loggingIn: true, error: null });
    try {
      const { token, user } = await localApiRequest<{ token: string; user: AuthUser }>('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      setAuthToken(token);
      set({ token, user, loggingIn: false });
    } catch (err) {
      set({ loggingIn: false, error: err instanceof Error ? err.message : 'Nepavyko užsiregistruoti' });
      throw err;
    }
  },

  fetchMe: async () => {
    try {
      const user = await localApiRequest<AuthUser>('/api/auth/me');
      set({ user });
    } catch {
      // A 401 here already triggers notifyUnauthorized()'s logout via
      // localApi.ts, which clears `token` — nothing further to do.
    }
  },

  logout: () => {
    setAuthToken(null);
    set({ token: null, user: null });
  },
}));

setUnauthorizedHandler(() => useAuthStore.getState().logout());
