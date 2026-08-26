import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getPasswordHash, getUserById, getUserByUsername, verifyPassword, type Role, type User } from './accounts/db.js';

// Real multi-tenant accounts now (see accounts/db.ts) — this used to be a
// single hardcoded AUTH_USERNAME/AUTH_PASSWORD pair with no users table at
// all, which is why sessions still don't bother with a server-side store:
// a signed, stateless token (HMAC over "userId.companyId.role.expiry",
// verified without the server remembering anything) is still the right
// shape even with real accounts behind it, and still mirrors the
// hand-rolled HMAC signing already used for Zadarma elsewhere in this
// codebase rather than pulling in a JWT library for four fields.
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — "log in once per device"

export class AuthError extends Error {}

function getTokenSecret(): string {
  const secret = process.env.AUTH_TOKEN_SECRET;
  if (!secret) throw new AuthError('AUTH_TOKEN_SECRET is not set — check server/.env');
  return secret;
}

function sign(payload: string): string {
  return createHmac('sha256', getTokenSecret()).update(payload).digest('hex');
}

export function issueToken(user: User): string {
  const expiry = Date.now() + TOKEN_TTL_MS;
  const payload = `${user.id}.${user.companyId}.${user.role}.${expiry}`;
  const signature = sign(payload);
  return Buffer.from(`${payload}.${signature}`).toString('base64url');
}

export interface AuthContext {
  userId: string;
  companyId: string;
  role: Role;
}

function verifyToken(token: string): AuthContext | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('.');
  if (parts.length !== 5) return null;
  const [userId, companyId, role, expiryStr, signature] = parts;
  const payload = `${userId}.${companyId}.${role}.${expiryStr}`;
  const expected = sign(payload);
  // Constant-time comparison — a plain === here would let a timing attack
  // narrow down the signature byte by byte, the same reasoning every
  // credential-comparison in this file already follows.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() >= expiry) return null;
  return { userId, companyId, role: role as Role };
}

/** Real DB lookup + constant-time hash compare against `users` — returns
 * the full user row on success (the route issues a token from it and also
 * returns it directly so the frontend can hydrate without a second round
 * trip), null on any mismatch. No more separate main/recovery password —
 * that existed because there was exactly one account; with real per-user
 * accounts, a forgotten password is a normal "an owner/super-admin resets
 * it" admin action instead (see accounts/db.ts's updateWorker/createUser —
 * there's no in-app self-service reset, matching this app's existing
 * "no flow that could brick access with nothing to fall back on" caution,
 * just now solved by "someone above you in the hierarchy can reset it"
 * rather than a second secret only the single owner held). */
export function checkCredentials(username: string, password: string): User | null {
  const hash = getPasswordHash(username);
  if (!hash || !verifyPassword(password, hash)) return null;
  return getUserByUsername(username);
}

/** Express middleware — every route it wraps requires a valid
 * `Authorization: Bearer <token>` header, and attaches the decoded
 * {userId, companyId, role} onto req.auth for every downstream route to
 * scope its queries by. Applied to everything except /health,
 * /api/auth/login, and /api/register (see index.ts) so a visitor without
 * credentials can't reach any Zadarma/OpenAI/ElevenLabs/table-data route
 * directly, not just be blocked by the frontend's login screen — the
 * frontend gate alone wouldn't stop someone who found api.serteo.lt's
 * routes without ever loading the UI. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Local-testing-only escape hatch — set AUTH_DISABLED=true in server/.env
  // (gitignored, never in Render's env vars, so app.serteo.lt/api.serteo.lt
  // stay fully gated regardless). Mirrors the app's DEV-only frontend skip
  // (App.tsx) so a local run needs neither a login screen nor a bearer
  // token to reach any route. Attaches the bootstrapped owner's identity
  // (there's always exactly one once bootstrapOwnerIfNeeded has run) so
  // company-scoped routes still have a real req.auth to read.
  if (process.env.AUTH_DISABLED === 'true') {
    const owner = getUserByUsername(process.env.AUTH_USERNAME ?? '');
    if (owner) {
      req.auth = { userId: owner.id, companyId: owner.companyId, role: owner.role };
    }
    next();
    return;
  }
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  const auth = token ? verifyToken(token) : null;
  if (!auth) {
    res.status(401).json({ error: 'Neautentifikuota' });
    return;
  }
  req.auth = auth;
  next();
}

/** Route-level guard for a specific boolean worker permission (delete
 * rows/columns, export/import — see accounts/db.ts's UserPermissions).
 * owner/super_admin always pass (the permission flags only ever restrict
 * a worker); a worker missing the flag gets a 403 with a plain, specific
 * message rather than the generic 401 requireAuth uses, so the frontend
 * can tell "not logged in" apart from "logged in but not allowed to do
 * this." Reads the user fresh from the DB on every call (not from the
 * token) so a permission change by the super-admin takes effect on the
 * worker's very next request, not just after their next login. */
export function requirePermission(flag: keyof User['permissions']) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Neautentifikuota' });
      return;
    }
    if (auth.role !== 'worker') {
      next();
      return;
    }
    const user = getUserById(auth.userId);
    if (!user?.permissions[flag]) {
      res.status(403).json({ error: 'Neturite teisės atlikti šio veiksmo' });
      return;
    }
    next();
  };
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}
