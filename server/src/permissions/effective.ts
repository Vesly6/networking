import { listGrantedKeys, type User } from '../accounts/db.js';
import type { PermissionKey } from './registry.js';

/** What the platform (Super Super Admin) has granted this company — this
 * directly IS that company's own super_admin's effective set (see
 * effectivePermissions below). Re-reads the DB on every call, same "never
 * cache/never bake into a token" reasoning as auth.ts's requirePermission
 * already uses for the ten legacy boolean flags — a platform admin
 * unchecking one box must take effect on this company's very next request,
 * with no session to invalidate and no affected user to walk. */
export function companyCeiling(companyId: string): Set<PermissionKey> {
  return new Set(listGrantedKeys('company', companyId));
}

/** The one live intersection this whole redesign is built around: a
 * worker's effective permissions are never their own grant alone, and
 * never their company's ceiling alone — always both, computed fresh. This
 * is what makes a platform-level or company-level revocation cascade to
 * every affected worker instantly and for free: nothing about a worker's
 * own permission_grants rows needs to change at all when their company's
 * ceiling shrinks, because the intersection recomputes on the very next
 * check. A super_admin's own effective set has no separate "grant" layer —
 * it simply IS the company's ceiling (a company's own admin can do
 * whatever the platform has allowed that company to do, in full). */
export function effectivePermissions(user: Pick<User, 'id' | 'role' | 'companyId'>): Set<PermissionKey> {
  const ceiling = companyCeiling(user.companyId);
  if (user.role === 'super_admin') return ceiling;
  const own = new Set(listGrantedKeys('user', user.id));
  const effective = new Set<PermissionKey>();
  for (const key of own) {
    if (ceiling.has(key)) effective.add(key);
  }
  return effective;
}

export function can(user: Pick<User, 'id' | 'role' | 'companyId'>, key: PermissionKey): boolean {
  return effectivePermissions(user).has(key);
}
