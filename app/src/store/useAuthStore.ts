import { create } from 'zustand';
import { localApiRequest } from '../utils/localApi';
import {
  getAuthToken,
  setAuthToken,
  setUnauthorizedHandler,
  getStashedAdminToken,
  setStashedAdminToken,
} from '../utils/authToken';
import { DEMO_MODE } from '../utils/demoMode';
import { ALL_PERMISSION_KEYS, type PermissionKey } from '../utils/permissions';

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
  /** Legacy fixed boolean flags — kept alongside permissionKeys below for
   * one release while every call site migrates (see server/src/index.ts's
   * userToPublic doc comment); not read by any new permission check. */
  permissions: UserPermissions;
  /** The live, registry-driven effective permission set (server/src/
   * permissions/effective.ts) — for a worker, already the intersection
   * with their company's own platform-granted ceiling; for a super_admin,
   * the ceiling itself. Recomputed by the server on every /api/auth/login
   * or /api/auth/me call, never cached beyond that — see utils/
   * permissions.ts's can() for how components should read this. */
  permissionKeys: PermissionKey[];
  company: { id: string; name: string; enabledFeatures: string[]; blockedAt?: number | null } | null;
  /** Per-worker Zadarma overrides (see server/src/accounts/db.ts's
   * migration) — null/undefined means "fall back to the company/deployment
   * default." Only meaningful for a worker account; a super_admin's own
   * row doesn't use these directly (see GET /api/webrtc/key's
   * effectiveUser resolution). */
  zadarmaSip?: string | null;
  zadarmaWidgetSip?: string | null;
  zadarmaCallerNumber?: string | null;
  /** Whether this worker has their OWN override key set for each remaining
   * plain-API-key integration (see server/src/accounts/db.ts's migration)
   * — booleans only, same "never re-send a saved secret to the browser"
   * rule this app's own IntegrationsView.tsx already follows for the
   * company-wide keys (server/src/index.ts's workerToPublic() is what
   * redacts these before any /api/workers response reaches the client).
   * Unset/false falls back to the company-wide key. LinkedIn's CDP URL has
   * no per-worker equivalent (see that migration's own doc comment). */
  instantlyApiKeySet?: boolean;
  apolloApiKeySet?: boolean;
  serperApiKeySet?: boolean;
  openaiApiKeySet?: boolean;
  anthropicApiKeySet?: boolean;
  elevenlabsApiKeySet?: boolean;
  /** Non-null only while a super_admin is impersonating one of their own
   * workers (see server/src/auth.ts's AuthContext.actingAs) — drives
   * ImpersonationBanner.tsx and App.tsx's tab-visibility filtering. Only
   * GET /api/auth/me actually populates this (login/register responses
   * omit it, since a fresh login is never mid-impersonation) — treat a
   * missing field the same as null. */
  impersonating?: { workerId: string; workerName: string; adminUserId: string; adminName: string } | null;
  /** True only for a platform Super Super Admin diagnosing inside this
   * company (server/src/auth.ts's issuePlatformImpersonationToken) —
   * distinct from `impersonating` above (a company's own worker-
   * impersonation). Drives the persistent "acting as {company} — Exit"
   * banner. Only GET /api/auth/me populates this, same "missing means
   * false" convention as `impersonating`. */
  platformActing?: boolean;
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
  /** "Prisijungti kaip" — stashes the real admin's own token, swaps to a
   * short-lived impersonation token for `workerId` (server-verified to
   * belong to the admin's own company), and re-hydrates `user` from
   * /api/auth/me so the UI reflects the worker's display identity. Throws
   * on failure (e.g. a worker from another company, or nested
   * impersonation) — the caller (WorkersView) toasts it. */
  impersonateWorker: (workerId: string) => Promise<void>;
  /** "Grįžti į Super Admin" — pure client-side restore (no session to
   * invalidate server-side, see auth.ts's own doc comment on why sessions
   * are stateless); a no-op if there's no stashed admin token to restore. */
  stopImpersonating: () => Promise<void>;
}

// A synthetic, always-valid user for the /demo build — no login screen,
// full access (role: 'super_admin' short-circuits every `role !== 'worker'
// || permissions.X` gate throughout the app, so there's no need to fill in
// every UserPermissions field individually), and enabledFeatures: [] so
// the tab bar shows exactly Table + Calendar — the same state a real
// minimal-tier client's account would already be in, not a demo-specific
// special case. fetchMe() below still "runs" against this user but is a
// no-op in practice: localApiRequest throws immediately in demo mode
// (see localApi.ts), and fetchMe's own catch block swallows that without
// touching `user`.
const DEMO_USER: AuthUser = {
  id: 'demo-user',
  companyId: 'demo-company',
  username: 'demo',
  firstName: 'Demo',
  lastName: 'Account',
  role: 'super_admin',
  visibleTabs: null,
  permissions: {
    canDeleteRows: true,
    canDeleteColumns: true,
    canDeleteNotes: true,
    canEditContacts: true,
    canDeleteContacts: true,
    canExportImport: true,
    canInsertRows: true,
    canInsertColumns: true,
    canHideRowsColumns: true,
    canClearContent: true,
  },
  // Full ceiling, same reasoning as every legacy boolean above being true
  // — the demo visitor experiences a Super Admin with nothing withheld.
  permissionKeys: ALL_PERMISSION_KEYS,
  // 'table'/'calendar' are gated by enabledFeatures the same as every
  // other tab (App.tsx's allowedTabs) — they aren't a special, always-on
  // baseline the way the standalone demo project's own two-tab nav
  // assumed. Everything else (calls/search/linkedin/instantly/email) is
  // deliberately left out — see the plan's scope decision. 'workers' is
  // the one addition for the permission-registry demo: it's what makes
  // App.tsx show the "Darbuotojai" nav button at all (see its own
  // enabledFeatures.includes('workers') check), needed so a visitor can
  // reach the pre-seeded roster (db/demoWorkers.ts) and its working
  // grant/revoke UI.
  company: { id: 'demo-company', name: 'Demo', enabledFeatures: ['table', 'calendar', 'workers'], blockedAt: null },
};

export const useAuthStore = create<AuthState>((set) => ({
  token: DEMO_MODE ? 'demo-token' : getAuthToken(),
  user: DEMO_MODE ? DEMO_USER : null,
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
    // No real session to end in demo mode, and there's no login screen to
    // send the visitor back to (see App.tsx) — logging out would just
    // strand them. Reloading the page is the demo's own "start over."
    if (DEMO_MODE) return;
    setAuthToken(null);
    setStashedAdminToken(null); // defensive: a shared-machine logout mid-impersonation
    // shouldn't leave a stale admin token sitting in localStorage.
    set({ token: null, user: null });
  },

  impersonateWorker: async (workerId) => {
    const { token: impersonationToken } = await localApiRequest<{ token: string }>(
      `/api/workers/${encodeURIComponent(workerId)}/impersonate`,
      { method: 'POST' },
    );
    const realToken = getAuthToken();
    if (realToken) setStashedAdminToken(realToken); // stash BEFORE switching
    setAuthToken(impersonationToken);
    set({ token: impersonationToken });
    await useAuthStore.getState().fetchMe();
  },

  stopImpersonating: async () => {
    const realToken = getStashedAdminToken();
    if (!realToken) return;
    setStashedAdminToken(null);
    setAuthToken(realToken);
    set({ token: realToken });
    await useAuthStore.getState().fetchMe();
  },
}));

setUnauthorizedHandler(() => useAuthStore.getState().logout());
