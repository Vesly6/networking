import { superAdminApiRequest } from './superAdminApi';

/** Mirrors server/src/accounts/db.ts's Company exactly. */
export interface AdminCompany {
  id: string;
  name: string;
  enabledFeatures: string[];
  createdAt: number;
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
