// Real (non-demo) export execution — a dedicated fetch() call rather than
// localApiRequest() (utils/localApi.ts), since that helper unconditionally
// calls res.json() and would throw/hang on this route's binary CSV/XLSX
// response body. Replicates just the auth-header attachment and 401
// handling localApiRequest already establishes, branching to res.blob() on
// success instead. A plain <a href> download can't be used here at all —
// this app's auth is a Bearer token, not a cookie, and only fetch() lets a
// custom header ride along with the request.
import { LOCAL_API_BASE } from './localApi';
import { getAuthToken, notifyUnauthorized } from './authToken';
import { downloadBlob } from './csv';
import type { ExportMode } from './exportFlatten';

export interface RunExportParams {
  tableId: string;
  mode: ExportMode;
  format: 'csv' | 'xlsx';
  rowIds: string[];
  columns: { id: string; name: string; type: string }[];
  includeCompaniesWithoutContacts: boolean;
  onlyContactsWithEmail: boolean;
  prettyNotes: boolean;
  filename: string;
}

export class ExportRowLimitError extends Error {
  rowCount: number;
  limit: number;
  constructor(message: string, rowCount: number, limit: number) {
    super(message);
    this.rowCount = rowCount;
    this.limit = limit;
  }
}

export async function runExport(params: RunExportParams): Promise<void> {
  const token = getAuthToken();
  let res: Response;
  try {
    res = await fetch(`${LOCAL_API_BASE}/api/tables/${encodeURIComponent(params.tableId)}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params),
    });
  } catch {
    throw new Error('Nepavyko pasiekti serverio — ar jis veikia?');
  }
  if (res.status === 401) {
    notifyUnauthorized();
    throw new Error('Neautentifikuota');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string; code?: string; rowCount?: number; limit?: number });
    if (body.code === 'row_limit_exceeded') {
      throw new ExportRowLimitError(body.error ?? 'Per daug eilučių', body.rowCount ?? 0, body.limit ?? 0);
    }
    throw new Error(body.error ?? `Eksportas nepavyko (${res.status})`);
  }
  downloadBlob(params.filename, await res.blob());
}
