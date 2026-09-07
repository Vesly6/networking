// Split out from useAuthStore.ts specifically so localApi.ts (a plain
// utility with no business-logic dependencies) can read the current token
// and react to a 401 without importing the Zustand store — importing it
// the other way (useAuthStore already imports localApiRequest for the
// login call) would be a circular import.
const TOKEN_KEY = 'cold-crm:auth-token';

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Holds the real super_admin's own token while they're impersonating a
// worker (see useAuthStore.ts's impersonateWorker/stopImpersonating) — a
// second slot alongside the "live" token above, not a replacement for it,
// so "Grįžti į Super Admin" can restore it without a server round trip
// (there's no server-side session store to ask — see auth.ts's own doc
// comment on why sessions are stateless).
const STASHED_ADMIN_TOKEN_KEY = 'cold-crm:stashed-admin-token';

export function getStashedAdminToken(): string | null {
  return localStorage.getItem(STASHED_ADMIN_TOKEN_KEY);
}

export function setStashedAdminToken(token: string | null): void {
  if (token) localStorage.setItem(STASHED_ADMIN_TOKEN_KEY, token);
  else localStorage.removeItem(STASHED_ADMIN_TOKEN_KEY);
}

let onUnauthorized: (() => void) | null = null;

/** Called once, by useAuthStore, so a 401 from any request (session token
 * expired, or just never had one) clears the store's in-memory state too —
 * without this, localApiRequest clearing localStorage alone would leave
 * the UI thinking it's still logged in until a full page reload. */
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export function notifyUnauthorized(): void {
  onUnauthorized?.();
}
