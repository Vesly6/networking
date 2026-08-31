import { getAuthToken, notifyUnauthorized } from './authToken';

// Shared by every feature that talks to the proxy server (calls, contacts
// AI-parsing, click-to-call) — one place for the base URL and the
// "can't reach it" error message, so every caller fails the same way.
//
// Defaults to the local dev server; set VITE_API_BASE_URL (app/.env, or the
// hosting platform's env var UI) to point at a deployed server/ instance
// instead — e.g. https://api.yourdomain.com — with no trailing slash. Vite
// only exposes env vars prefixed VITE_ to client code, and only bakes them
// in at build time, so this needs to be set before `npm run build`, not
// something the deployed app can read at runtime.
// Exported so any UI that needs to show the server's own public URL (e.g.
// IntegrationsView's per-company Instantly webhook URL) can build off the
// same base instead of re-deriving it.
export const LOCAL_API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000';
const IS_LOCAL_DEFAULT = !import.meta.env.VITE_API_BASE_URL;

export async function localApiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getAuthToken();
  const headers = { ...(init?.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let res: Response;
  try {
    res = await fetch(`${LOCAL_API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new Error(
      IS_LOCAL_DEFAULT
        ? 'Could not reach the local backend server — is it running? (npm run dev in server/)'
        : `Could not reach the server at ${LOCAL_API_BASE}`,
    );
  }
  if (res.status === 401) notifyUnauthorized();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return body as T;
}
