import { localApiRequest } from './localApi';

/** Thin wrappers around /api/dashboard/* — mirrors server/src/dashboard/
 * aggregate.ts's own DashboardMetric/DashboardPeriod shapes exactly (hand-
 * kept in sync, same convention as every other server/client boundary in
 * this app). */

export type DashboardPeriod = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';

// Server's own DashboardMetric type (server/src/dashboard/db.ts) is
// broader — it still includes 'companies_added' for the underlying
// daily_metrics rows, which are still tracked, just never surfaced on the
// dashboard itself (see server/src/dashboard/aggregate.ts's own doc
// comment on why: a table's rows are an exact, pre-built list worked from
// the start in this CRM, not something that grows incrementally the way
// contacts do). The client never needs to represent that excluded metric
// at all, so DashboardMetric here is derived straight from the displayed
// list instead of being a separately hand-kept superset.
export const DASHBOARD_METRICS = ['notes', 'contacts', 'calls', 'linkedin_sent'] as const;
export type DashboardMetric = (typeof DASHBOARD_METRICS)[number];

export type MetricTotals = Record<DashboardMetric, number>;

export interface EmailStats {
  sent: number;
  replies: number;
  /** Instantly's own "opportunities" count for the period — see
   * server/src/dashboard/aggregate.ts's own EmailStats.positiveReplies doc
   * comment for why this is a proxy, not an exact "positive reply" count. */
  positiveReplies: number;
}

export interface DashboardSummary {
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  own: MetricTotals;
  ownPrevious: MetricTotals;
  team: MetricTotals | null;
  teamPrevious: MetricTotals | null;
  /** Company-wide only — see server/src/dashboard/externalSync.ts's own
   * doc comment for why there's no per-worker split for email. Null
   * exactly when `team` is (same canViewTeam gate). */
  email: EmailStats | null;
  emailPrevious: EmailStats | null;
  canViewTeam: boolean;
  /** Epoch ms of the OLDEST successful sync across every data source this
   * company has ever run — what "Обновлено N minučių atgal" reads. Null
   * only when nothing has ever synced at all (a brand-new company). */
  updatedAt: number | null;
}

export interface DashboardWorkerRow {
  workerId: string;
  workerName: string;
  metrics: MetricTotals;
}

function periodQuery(period: DashboardPeriod, custom?: { from: string; to: string }): string {
  const q = new URLSearchParams({ period });
  if (period === 'custom' && custom) {
    q.set('from', custom.from);
    q.set('to', custom.to);
  }
  return q.toString();
}

export function fetchDashboardSummary(period: DashboardPeriod, custom?: { from: string; to: string }) {
  return localApiRequest<DashboardSummary>(`/api/dashboard/summary?${periodQuery(period, custom)}`);
}

export function fetchDashboardWorkers(period: DashboardPeriod, custom?: { from: string; to: string }) {
  return localApiRequest<{ period: { from: string; to: string }; workers: DashboardWorkerRow[] }>(`/api/dashboard/workers?${periodQuery(period, custom)}`);
}

export function refreshDashboard() {
  return localApiRequest<{ ok: true }>('/api/dashboard/refresh', { method: 'POST' });
}

export interface DashboardSyncLogEntry {
  companyId: string;
  source: string;
  requestedAt: number;
  requestParams: unknown;
  rawResponse: unknown;
}

/** The account owner's own explicit "let me see how this looks from the
 * real side" request — the exact params/raw response the last background
 * sync got back from the provider, for cross-checking a computed number
 * against the provider's own dashboard. `source` is an internal id
 * ('instantly'/'zadarma'), never shown to the user as such — see
 * ActivityDashboard.tsx's own generic button label. */
export function fetchDashboardSyncLog(source: 'instantly' | 'zadarma') {
  return localApiRequest<{ entry: DashboardSyncLogEntry | null; lastError: string | null }>(`/api/dashboard/sync-log/${source}`);
}

/** The "Atverti" drill-down — one worker's metric total (e.g. "4
 * comments") expanded into the exact underlying events, each carrying
 * enough to jump to it (tableId/rowId, optionally columnId+contactId for
 * a note/contact/LinkedIn entry). `kind` discriminates what `detail`
 * actually describes and which jump fields are populated — a call item
 * never has columnId/contactId (no CRM concept of "which cell"), and its
 * tableId/rowId are only present when the call's phone number matched a
 * row somewhere in the company (see server/src/index.ts's
 * buildCompanyPhoneIndex — best-effort, not guaranteed). */
export interface DashboardDrillDownItem {
  kind: 'action' | 'linkedin' | 'call';
  id: string;
  createdAt: number;
  detail: string;
  tableId?: string;
  tableName?: string;
  rowId?: string;
  columnId?: string;
  contactId?: string;
}

export function fetchDashboardWorkerDetail(workerId: string, metric: DashboardMetric, period: DashboardPeriod, custom?: { from: string; to: string }) {
  const q = new URLSearchParams({ workerId, metric, period });
  if (period === 'custom' && custom) {
    q.set('from', custom.from);
    q.set('to', custom.to);
  }
  return localApiRequest<{ metric: DashboardMetric; items: DashboardDrillDownItem[] }>(`/api/dashboard/worker-detail?${q.toString()}`);
}
