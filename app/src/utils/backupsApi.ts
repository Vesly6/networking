import { localApiRequest } from './localApi';
import { superAdminApiRequest } from './superAdminApi';

/** Mirrors server/src/tableData/db.ts's BackupSummary exactly. */
export interface BackupSummary {
  id: string;
  companyId: string;
  tableId: string;
  tableName: string;
  rowCount: number;
  createdAt: number;
}

/** admin=true hits a requireSuperAdmin-gated /api/admin/* route (see
 * server/src/auth.ts) — needs the separate super-admin token, not the
 * caller's own normal session, which those routes never look at at all.
 * admin=false hits the caller's own company via the normal /api/backups
 * route, unchanged. */
function backupsRequest<T>(admin: boolean, path: string, init?: RequestInit): Promise<T> {
  return admin ? superAdminApiRequest<T>(path, init) : localApiRequest<T>(path, init);
}

/** The caller's own company's backups. */
export function fetchOwnBackups(): Promise<{ backups: BackupSummary[] }> {
  return localApiRequest('/api/backups');
}

/** Super-admin only — every company's backups, for the Admin dashboard's
 * oversight panel. */
export function fetchAllBackups(): Promise<{ backups: BackupSummary[] }> {
  return superAdminApiRequest('/api/admin/backups');
}

/** `admin` picks which route family to hit (see index.ts's own two route
 * sets — /api/backups/:id/* is company-scoped to the caller,
 * /api/admin/backups/:id/* is super-admin-only and reaches any company's
 * backup) — same "one function, a flag picks the path" shape as
 * useWorkersStore/useIntegrationsStore's companyId, just a boolean here
 * since there's no third "arbitrary company" case for backups (the admin
 * routes always resolve the target company from the backup record
 * itself). */
export function deleteBackup(id: string, admin: boolean): Promise<{ ok: true }> {
  const base = admin ? '/api/admin/backups' : '/api/backups';
  return backupsRequest(admin, `${base}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Returns the CSV as plain JSON text, not a file response — see
 * index.ts's own doc comment on why (a plain browser download link can't
 * carry the Authorization header this route needs). Caller triggers the
 * actual save via utils/csv.ts's downloadCsv(), same mechanism every
 * other CSV export in this app already uses. */
export function fetchBackupCsv(id: string, admin: boolean): Promise<{ filename: string; csv: string }> {
  const base = admin ? '/api/admin/backups' : '/api/backups';
  return backupsRequest(admin, `${base}/${encodeURIComponent(id)}/csv`);
}

/** Creates a brand-new table from this backup — current data is never
 * touched (see restoreBackupAsNewTable's own doc comment server-side).
 * The caller must have already shown a confirm dialog. */
export function restoreBackup(id: string, admin: boolean): Promise<{ id: string; name: string }> {
  const base = admin ? '/api/admin/backups' : '/api/backups';
  return backupsRequest(admin, `${base}/${encodeURIComponent(id)}/restore`, { method: 'POST' });
}
