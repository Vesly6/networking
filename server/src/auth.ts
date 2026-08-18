import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// This app has no user database and no persistent-disk requirement — one
// shared username/password for the whole app (it's a single-operator
// tool, not multi-tenant), stored as env vars, same as every other secret
// in this file. Sessions are a signed, stateless token (HMAC over
// "username.expiry", verified without the server remembering anything) —
// deliberately not a real JWT library, since the whole payload is two
// fields and this mirrors the hand-rolled HMAC signing already used for
// Zadarma elsewhere in this codebase.
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

export function issueToken(username: string): string {
  const expiry = Date.now() + TOKEN_TTL_MS;
  const payload = `${username}.${expiry}`;
  const signature = sign(payload);
  return Buffer.from(`${payload}.${signature}`).toString('base64url');
}

function verifyToken(token: string): boolean {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return false;
  }
  const parts = decoded.split('.');
  if (parts.length !== 3) return false;
  const [username, expiryStr, signature] = parts;
  const payload = `${username}.${expiryStr}`;
  const expected = sign(payload);
  // Constant-time comparison — a plain === here would let a timing attack
  // narrow down the signature byte by byte, the same reasoning every
  // credential-comparison in this file already follows.
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const expiry = Number(expiryStr);
  return Number.isFinite(expiry) && Date.now() < expiry;
}

/** Checks a plaintext password against either the main or the recovery
 * password (constant-time, so which one matched isn't observable from
 * timing). Returns 'main' | 'recovery' | null. There's no username check
 * here beyond exact match against AUTH_USERNAME — this app has exactly
 * one account. */
export function checkCredentials(username: string, password: string): 'main' | 'recovery' | null {
  const expectedUsername = process.env.AUTH_USERNAME;
  const mainPassword = process.env.AUTH_PASSWORD;
  const recoveryPassword = process.env.AUTH_RECOVERY_PASSWORD;
  if (!expectedUsername || !mainPassword) {
    throw new AuthError('AUTH_USERNAME/AUTH_PASSWORD are not set — check server/.env');
  }
  if (username !== expectedUsername) return null;
  if (constantTimeStringEqual(password, mainPassword)) return 'main';
  if (recoveryPassword && constantTimeStringEqual(password, recoveryPassword)) return 'recovery';
  return null;
}

function constantTimeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Express middleware — every route it wraps requires a valid
 * `Authorization: Bearer <token>` header. Applied to everything except
 * /health and /api/auth/login (see index.ts) so a visitor without
 * credentials can't reach any Zadarma/OpenAI/ElevenLabs-backed route
 * directly, not just be blocked by the frontend's login screen — the
 * frontend gate alone wouldn't stop someone who found api.serteo.lt's
 * routes without ever loading the UI. */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  // Local-testing-only escape hatch — set AUTH_DISABLED=true in server/.env
  // (gitignored, never in Render's env vars, so app.serteo.lt/api.serteo.lt
  // stay fully gated regardless). Mirrors the app's DEV-only frontend skip
  // (App.tsx) so a local run needs neither a login screen nor a bearer
  // token to reach the Zadarma/OpenAI/ElevenLabs routes.
  if (process.env.AUTH_DISABLED === 'true') {
    next();
    return;
  }
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || !verifyToken(token)) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  next();
}
