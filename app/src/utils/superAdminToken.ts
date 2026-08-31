// Mirrors utils/authToken.ts's exact split-out-to-avoid-circular-import
// shape, for the independent super-admin credential (see server/src/
// auth.ts's requireSuperAdmin doc comment for why this is a fully separate
// system, not a second factor on top of the normal per-user token).
//
// sessionStorage, not localStorage — deliberately cleared when the tab/
// browser closes, unlike the normal 30-day login. This credential reaches
// every company's API keys and worker roster, so "re-enter it each new
// browser session" is the intended behavior, not an oversight.
const SUPERADMIN_TOKEN_KEY = 'cold-crm:superadmin-token';

export function getSuperAdminToken(): string | null {
  return sessionStorage.getItem(SUPERADMIN_TOKEN_KEY);
}

export function setSuperAdminToken(token: string | null): void {
  if (token) sessionStorage.setItem(SUPERADMIN_TOKEN_KEY, token);
  else sessionStorage.removeItem(SUPERADMIN_TOKEN_KEY);
}

let onUnauthorized: (() => void) | null = null;

export function setSuperAdminUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export function notifySuperAdminUnauthorized(): void {
  onUnauthorized?.();
}
