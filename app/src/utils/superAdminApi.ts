import { getSuperAdminToken, notifySuperAdminUnauthorized } from './superAdminToken';
import { LOCAL_API_BASE } from './localApi';

// Mirrors localApi.ts's localApiRequest exactly, but for the independent
// super-admin credential — every /api/admin/* call goes through this
// instead, since those routes are requireSuperAdmin-gated (server/src/
// auth.ts), not requireAuth+requireOwner, and never accept a normal
// per-user Bearer token at all (see index.ts's own doc comment on why
// these routes sit above app.use(requireAuth)).
export async function superAdminApiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getSuperAdminToken();
  const headers = { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let res: Response;
  try {
    res = await fetch(`${LOCAL_API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new Error(`Could not reach the server at ${LOCAL_API_BASE}`);
  }
  if (res.status === 401) notifySuperAdminUnauthorized();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}
