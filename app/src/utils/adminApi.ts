import { superAdminApiRequest } from './superAdminApi';
import type { Worker } from '../store/useWorkersStore';
import type { PermissionKey } from './permissions';

/** Mirrors server/src/accounts/db.ts's Company exactly. */
export interface AdminCompany {
  id: string;
  name: string;
  enabledFeatures: string[];
  createdAt: number;
  /** null = active. Set only via blockCompany/unblockCompany below — see
   * server/src/auth.ts's requireAuth, which rejects every one of this
   * company's requests immediately once this is set, including an
   * already-issued token. */
  blockedAt: number | null;
}

/** Mirrors server/src/accounts/db.ts's AuditLogEntry exactly. */
export interface AuditLogEntry {
  id: string;
  at: number;
  actorUserId: string | null;
  actorRole: string | null;
  companyId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
}

export function blockCompany(companyId: string): Promise<{ ok: true }> {
  return superAdminApiRequest(`/api/admin/companies/${encodeURIComponent(companyId)}/block`, { method: 'POST' });
}

export function unblockCompany(companyId: string): Promise<{ ok: true }> {
  return superAdminApiRequest(`/api/admin/companies/${encodeURIComponent(companyId)}/unblock`, { method: 'POST' });
}

export function fetchCompanyPermissions(companyId: string): Promise<{ permissionKeys: PermissionKey[] }> {
  return superAdminApiRequest(`/api/admin/companies/${encodeURIComponent(companyId)}/permissions`);
}

export function saveCompanyPermissions(companyId: string, permissionKeys: PermissionKey[]): Promise<{ permissionKeys: PermissionKey[] }> {
  return superAdminApiRequest(`/api/admin/companies/${encodeURIComponent(companyId)}/permissions`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ permissionKeys }),
  });
}

/** Issues a platform-impersonation token for this company's own
 * super_admin (see server/src/auth.ts's issuePlatformImpersonationToken) —
 * useAdminImpersonationStore below is what actually swaps to it and back. */
export function platformImpersonate(companyId: string): Promise<{ token: string }> {
  return superAdminApiRequest(`/api/admin/companies/${encodeURIComponent(companyId)}/impersonate`, { method: 'POST' });
}

/** Pure logging hook — there's no server-side session to tear down (the
 * token is stateless and short-lived), see index.ts's own doc comment. */
export function platformStopImpersonate(companyId: string): Promise<{ ok: true }> {
  return superAdminApiRequest(`/api/admin/companies/${encodeURIComponent(companyId)}/impersonate/stop`, { method: 'POST' });
}

/** `companyId` omitted = every company's audit trail (the Admin
 * dashboard's default); passed = one company's own. */
export function fetchAuditLog(companyId?: string, limit = 300): Promise<{ entries: AuditLogEntry[] }> {
  const params = new URLSearchParams();
  if (companyId) params.set('companyId', companyId);
  params.set('limit', String(limit));
  return superAdminApiRequest(`/api/admin/audit-log?${params.toString()}`);
}

/** Mirrors server/src/accounts/db.ts's LoginLogEntry exactly. */
export interface LoginLogEntry {
  id: string;
  companyId: string;
  userId: string;
  username: string;
  role: 'super_admin' | 'worker';
  loggedInAt: number;
}

export function fetchCompanies(): Promise<{ companies: AdminCompany[] }> {
  return superAdminApiRequest('/api/admin/companies');
}

export function fetchCompanyFeatures(companyId: string): Promise<{ enabledFeatures: string[] }> {
  return superAdminApiRequest(`/api/admin/companies/${encodeURIComponent(companyId)}/features`);
}

export function saveCompanyFeatures(companyId: string, enabledFeatures: string[]): Promise<AdminCompany> {
  return superAdminApiRequest(`/api/admin/companies/${encodeURIComponent(companyId)}/features`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabledFeatures }),
  });
}

/** `companyId` omitted = every company's logins (the Admin dashboard's
 * default "Prisijungimų istorija" view); passed = one company's own. */
export function fetchLoginLog(companyId?: string, limit = 300): Promise<{ entries: LoginLogEntry[] }> {
  const params = new URLSearchParams();
  if (companyId) params.set('companyId', companyId);
  params.set('limit', String(limit));
  return superAdminApiRequest(`/api/admin/login-log?${params.toString()}`);
}

/** The one account WorkersView's own fetch/update never reaches — see
 * server/src/accounts/db.ts's getCompanySuperAdmin/updateCompanySuperAdmin
 * doc comments for why this needed its own pair of routes. */
export function fetchCompanySuperAdmin(companyId: string): Promise<Worker> {
  return superAdminApiRequest(`/api/admin/companies/${encodeURIComponent(companyId)}/super-admin`);
}

export interface UpdateSuperAdminInput {
  username?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
}

export function updateCompanySuperAdmin(companyId: string, input: UpdateSuperAdminInput): Promise<Worker> {
  return superAdminApiRequest(`/api/admin/companies/${encodeURIComponent(companyId)}/super-admin`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
