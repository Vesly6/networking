import { useAuthStore } from '../store/useAuthStore';
import { setAuthToken } from './authToken';
import { platformImpersonate, platformStopImpersonate } from './adminApi';

// Bridges the two otherwise-independent auth stores (useSuperAdminStore's
// own credential, useAuthStore's normal company session) for exactly one
// action: the platform Super Super Admin diagnosing inside a company via
// AdminView's "Peržiūrėti kaip administratorius" button. Deliberately not
// a method on either store — this doesn't belong to useSuperAdminStore
// (that store owns only the superadmin credential itself, never a company
// session) or to useAuthStore (a regular login never issues this token
// type). useSuperAdminStore's own token is never touched here — it lives
// in sessionStorage under a separate key (see superAdminToken.ts) and
// stays valid the whole time, which is what lets navigating back to
// /supersuperadmin after exiting land straight back on <AdminView/>
// with zero re-login.

/** Issues a platform-impersonation token for this company's own
 * super_admin (server/src/auth.ts's issuePlatformImpersonationToken),
 * loads it into the REGULAR session slot (same one a normal company login
 * uses), and navigates to the app root — from there App.tsx's normal
 * !token/!user rendering takes over exactly as it would for a real login,
 * except GET /api/auth/me's platformActing: true drives
 * PlatformImpersonationBanner.tsx's persistent "acting as {company} —
 * Exit" indicator instead of a normal session. */
export async function startPlatformImpersonation(companyId: string): Promise<void> {
  const { token } = await platformImpersonate(companyId);
  setAuthToken(token);
  useAuthStore.setState({ token });
  await useAuthStore.getState().fetchMe();
  window.location.href = '/';
}

/** The only way off PlatformImpersonationBanner. Logs the stop event
 * (best-effort — there's no server-side session to actually tear down,
 * the token is stateless and short-lived), then clears the regular
 * session entirely (so this browser doesn't stay silently logged into
 * that company if navigated back to `/` again later) and returns to the
 * platform dashboard. */
export async function exitPlatformImpersonation(companyId: string): Promise<void> {
  try {
    await platformStopImpersonate(companyId);
  } catch {
    // Best-effort logging only — never block the actual exit on it.
  }
  useAuthStore.getState().logout();
  window.location.href = '/supersuperadmin';
}
