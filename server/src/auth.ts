import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getCompany, getPasswordHash, getUserById, getUserByUsername, verifyPassword, type Role, type User } from './accounts/db.js';
import { can } from './permissions/effective.js';
import type { PermissionKey } from './permissions/registry.js';

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
  /** Set only while a company super_admin is impersonating one of their own
   * workers (see issueImpersonationToken below). userId/companyId/role above
   * still describe the REAL super_admin — every existing company-scoped
   * query and requirePermission/requireNotWorker check keeps treating this
   * as an ordinary super_admin request (full admin rights, by design). This
   * field only names which worker's *display identity* (visibleTabs, name)
   * GET /api/auth/me should resolve, and which worker the audit log
   * (worker_actions' real_user_id/real_user_name) attributes the write to. */
  actingAs?: { userId: string };
  /** Set only while the platform Super Super Admin is diagnosing inside a
   * company via POST /api/admin/companies/:id/impersonate (see
   * issuePlatformImpersonationToken below). userId/companyId/role above are
   * that company's OWN real super_admin — deliberately not a fake/sentinel
   * identity, so every existing `getUserById(req.auth!.userId)` call site
   * across this whole file keeps resolving a real row with zero changes
   * needed anywhere else. This flag exists purely so GET /api/auth/me can
   * tell the frontend to show the persistent "acting as Company X — Exit"
   * banner, and so the handful of NEW audit_log writes that care can
   * attribute themselves to the platform rather than the company's own
   * admin — see index.ts's own impersonate route for where that
   * distinction is actually applied at write time. Deliberately does NOT
   * attempt to re-attribute every possible action a platform session might
   * take while impersonating (e.g. tableData/db.ts's separate
   * worker_actions log still shows the company's own admin identity,
   * unchanged) — a disclosed scope limit for this diagnostic-only feature,
   * not a security gap: authorization during a platform-impersonation
   * session is identical to the company's own super_admin's real rights,
   * never more. */
  platformActing?: boolean;
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
  const auth = token ? (resolvePlatformImpersonationAuth(token) ?? resolveImpersonationAuth(token) ?? verifyToken(token)) : null;
  if (!auth) {
    res.status(401).json({ error: 'Neautentifikuota' });
    return;
  }
  // Platform-wide suspension (accounts/db.ts's blockCompany, only reachable
  // via the Super Super Admin dashboard) — checked fresh from the DB on
  // every single request, same "never trust a cached/token-baked copy"
  // reasoning as requirePermission below, so a block takes effect
  // immediately for a user already mid-session with a still-unexpired
  // token, not just after their next login.
  if (getCompany(auth.companyId)?.blockedAt) {
    res.status(403).json({ error: 'Ši įmonė yra užblokuota' });
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

/** Registry-driven counterpart to requirePermission above — parallel name
 * (not a rename) so both can coexist while call sites migrate one at a
 * time; requirePermission can be deleted once nothing references it. Two
 * real differences from requirePermission, both deliberate:
 *
 *   1. Keyed against the open-ended PermissionKey registry
 *      (permissions/registry.ts) instead of one of the ten fixed legacy
 *      UserPermissions booleans.
 *   2. super_admin does NOT automatically pass. Under the old boolean
 *      model a company's own admin could always do everything (there was
 *      no concept of restricting one), so requirePermission's "role !==
 *      'worker' → always next()" was correct. Under the new registry, a
 *      super_admin's effective set IS their company's platform-granted
 *      ceiling (see effective.ts's effectivePermissions) — the whole point
 *      of the Super Super Admin's per-company permission panel is that
 *      unchecking something there must immediately remove it from that
 *      company's own super_admin too, not just cascade to their workers.
 *      So this checks can() for every role alike; can() itself is what
 *      makes a super_admin's check reduce to "is this key in my company's
 *      ceiling," with no separate carve-out needed here.
 *
 * Always resolves the REAL authenticated session (auth.userId), never an
 * impersonated worker (auth.actingAs) — matches requireNotWorker/
 * requirePermission's existing "impersonating admin keeps full admin
 * rights throughout" rule, since an admin-shaped action like "manage
 * workers" is a question about the real admin's own standing, not
 * whichever worker's data view happens to be active right now. Contrast
 * with index.ts's requireXKey() helpers, which deliberately DO resolve
 * through effectiveUser() — those gate integration USE, a question about
 * whoever's data context is currently active, not an admin-only action. */
export function requirePermission2(key: PermissionKey) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) {
      res.status(401).json({ error: 'Neautentifikuota' });
      return;
    }
    const user = getUserById(auth.userId);
    if (!user || !can(user, key)) {
      res.status(403).json({ error: 'Neturite teisės atlikti šio veiksmo', permission: key });
      return;
    }
    next();
  };
}

// --- Super-admin (platform-wide, cross-company admin dashboard) ---
//
// Deliberately NOT layered on top of the normal per-user token system
// above — on explicit request, the super-admin identity is fully
// independent of any regular company login (no `users` row, no
// companyId), not "a second password on top of an already-logged-in
// owner account". A single fixed credential pair in server/.env, same
// "one shared secret, not a DB row" shape as REGISTRATION_SECRET, checked
// the same constant-time way for the same reason (a plain === would leak
// how many leading characters matched through response timing).
function getSuperAdminCredentials(): { username: string; password: string } {
  const username = process.env.SUPERADMIN_USERNAME;
  const password = process.env.SUPERADMIN_PASSWORD;
  if (!username || !password) {
    throw new AuthError('SUPERADMIN_USERNAME/SUPERADMIN_PASSWORD are not set — check server/.env');
  }
  return { username, password };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

export function checkSuperAdminPassword(username: string, password: string): boolean {
  const expected = getSuperAdminCredentials();
  return timingSafeStringEqual(username, expected.username) && timingSafeStringEqual(password, expected.password);
}

// 12 hours, not the normal login's 30 days — this credential reaches
// every company's API keys and worker roster, so it's deliberately
// shorter-lived, matching the frontend's own choice to store it in
// sessionStorage (cleared on tab close) rather than localStorage.
const SUPERADMIN_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// A distinct payload shape ("superadmin.<expiry>...", never
// "<userId>.<companyId>.<role>.<expiry>...") means a normal per-user
// token and a super-admin token can never be mistaken for each other by
// either verifier, even though both reuse the same sign() HMAC helper.
export function issueSuperAdminToken(): string {
  const expiry = Date.now() + SUPERADMIN_TOKEN_TTL_MS;
  const payload = `superadmin.${expiry}`;
  const signature = sign(payload);
  return Buffer.from(`${payload}.${signature}`).toString('base64url');
}

function verifySuperAdminToken(token: string): boolean {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return false;
  }
  const parts = decoded.split('.');
  if (parts.length !== 3 || parts[0] !== 'superadmin') return false;
  const [, expiryStr, signature] = parts;
  const payload = `superadmin.${expiryStr}`;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const expiry = Number(expiryStr);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

/** Express middleware for every /api/admin/* route — a fully separate
 * check from requireAuth above, not stacked on top of it: these routes
 * sit *above* app.use(requireAuth) in index.ts's route order, so a
 * regular company login's Bearer token is never even looked at here. */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !verifySuperAdminToken(token)) {
    res.status(401).json({ error: 'Neautentifikuota' });
    return;
  }
  next();
}

// --- Impersonation ("log in as worker") ---
//
// A company's own super_admin can temporarily act inside one of their own
// workers' sessions without knowing that worker's password. This is
// deliberately NOT a real logout/login into the worker's account — the
// super_admin's own session stays authoritative throughout (see AuthContext
// .actingAs above); this token is just a second, independent identity
// carrier layered on top, the same "distinct sentinel-prefixed shape"
// pattern already used for the platform super-admin token below, so it can
// never be confused with either a normal 5-part token or a superadmin
// 3-part token by any verifier. companyId is included and re-checked fresh
// on every request specifically so a worker who gets moved to a different
// company mid-impersonation (or deleted) invalidates the token immediately,
// same reasoning as requirePermission's own fresh-DB-read comment above.
const IMPERSONATION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h — a deliberate,
// elevated "acting as" mode, not a standing alternate identity; cheap to
// re-issue (one click), so a short TTL costs little and bounds how long an
// abandoned impersonation session could matter.

export interface ImpersonationContext {
  adminUserId: string;
  workerUserId: string;
  companyId: string;
}

export function issueImpersonationToken(admin: User, worker: User): string {
  const expiry = Date.now() + IMPERSONATION_TOKEN_TTL_MS;
  const payload = `impersonate.${admin.id}.${worker.id}.${admin.companyId}.${expiry}`;
  const signature = sign(payload);
  return Buffer.from(`${payload}.${signature}`).toString('base64url');
}

function verifyImpersonationToken(token: string): ImpersonationContext | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('.');
  // 6 parts, sentinel-prefixed — never mistakable for a normal 5-part token
  // or a "superadmin."-prefixed 3-part one.
  if (parts.length !== 6 || parts[0] !== 'impersonate') return null;
  const [, adminUserId, workerUserId, companyId, expiryStr, signature] = parts;
  const payload = `impersonate.${adminUserId}.${workerUserId}.${companyId}.${expiryStr}`;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() >= expiry) return null;
  return { adminUserId, workerUserId, companyId };
}

/** Re-resolves BOTH identities fresh from the DB on every single request —
 * never trusts the token's own snapshot, same reasoning as
 * requirePermission above. This is what makes deleting the worker,
 * demoting/deleting the admin, or moving either to another company mid-
 * impersonation immediately invalidate the token, even though its
 * signature stays valid until its own stated expiry. Returns null (falls
 * through to the normal verifyToken() path below) for anything that isn't
 * a currently-valid impersonation token — a real worker's 5-part token
 * always fails the 6-part check above before ever reaching a DB read. */
function resolveImpersonationAuth(token: string): AuthContext | null {
  const ctx = verifyImpersonationToken(token);
  if (!ctx) return null;
  const admin = getUserById(ctx.adminUserId);
  const worker = getUserById(ctx.workerUserId);
  if (!admin || admin.role !== 'super_admin' || admin.companyId !== ctx.companyId) return null;
  if (!worker || worker.role !== 'worker' || worker.companyId !== admin.companyId) return null;
  return { userId: admin.id, companyId: admin.companyId, role: admin.role, actingAs: { userId: worker.id } };
}

// --- Platform impersonation ("Super Super Admin diagnoses inside a
// company") ---
//
// A distinct, one-level-up counterpart to the worker-impersonation above,
// issued only from index.ts's POST /api/admin/companies/:id/impersonate
// (requireSuperAdmin-gated — only the platform credential can ever obtain
// one). Deliberately NOT built on top of ImpersonationContext/
// issueImpersonationToken above: those require a real admin AND a real
// worker row, and semantically this is "the platform acting as this
// company's own super_admin," not "an admin acting as their own worker."
// Reusing the identical adminUserId=workerUserId=same row shape would work
// mechanically but would make a platform diagnostic session indistinguishable
// from that admin's own ordinary login in every downstream check — this
// separate token type exists so it can be told apart wherever that matters
// (see AuthContext.platformActing's own doc comment).
const PLATFORM_IMPERSONATION_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // Same 12h as worker impersonation — see its own doc comment for why.

export function issuePlatformImpersonationToken(admin: User): string {
  const expiry = Date.now() + PLATFORM_IMPERSONATION_TOKEN_TTL_MS;
  const payload = `platformimpersonate.${admin.id}.${admin.companyId}.${expiry}`;
  const signature = sign(payload);
  return Buffer.from(`${payload}.${signature}`).toString('base64url');
}

function verifyPlatformImpersonationToken(token: string): { adminUserId: string; companyId: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split('.');
  // 5 parts, sentinel-prefixed — never mistakable for a normal 5-part
  // token (different first segment), a superadmin 3-part one, or a
  // worker-impersonation 6-part one.
  if (parts.length !== 5 || parts[0] !== 'platformimpersonate') return null;
  const [, adminUserId, companyId, expiryStr, signature] = parts;
  const payload = `platformimpersonate.${adminUserId}.${companyId}.${expiryStr}`;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() >= expiry) return null;
  return { adminUserId, companyId };
}

/** Re-resolves the company's own super_admin fresh from the DB on every
 * request, same reasoning as resolveImpersonationAuth above — deleting or
 * moving that admin mid-session invalidates the token immediately. Unlike
 * resolveImpersonationAuth, req.auth!.userId here IS a real row (that
 * company's own actual super_admin) rather than a sentinel — see
 * AuthContext.platformActing's own doc comment for why that's deliberate:
 * every existing getUserById(req.auth!.userId) call site across this app
 * keeps working unchanged, and authorization during a platform-
 * impersonation session is exactly that company's own admin rights, never
 * more. */
function resolvePlatformImpersonationAuth(token: string): AuthContext | null {
  const ctx = verifyPlatformImpersonationToken(token);
  if (!ctx) return null;
  const admin = getUserById(ctx.adminUserId);
  if (!admin || admin.role !== 'super_admin' || admin.companyId !== ctx.companyId) return null;
  return { userId: admin.id, companyId: admin.companyId, role: admin.role, platformActing: true };
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}
