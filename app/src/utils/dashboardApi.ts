import { localApiRequest } from './localApi';

/** Thin wrappers around /api/dashboard/* — mirrors server/src/dashboard/
 * aggregate.ts's own DashboardMetric/DashboardPeriod shapes exactly (hand-
 * kept in sync, same convention as every other server/client boundary in
 * this app). */

export type DashboardMetric = 'notes' | 'contacts' | 'companies_added' | 'linkedin_sent' | 'calls';

export type DashboardPeriod = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';

export const DASHBOARD_METRICS: DashboardMetric[] = ['notes', 'contacts', 'companies_added', 'calls', 'linkedin_sent'];

export type MetricTotals = Record<DashboardMetric, number>;

export interface DashboardSummary {
  period: { from: string; to: string };
  previousPeriod: { from: string; to: string };
  own: MetricTotals;
  ownPrevious: MetricTotals;
  team: MetricTotals | null;
  teamPrevious: MetricTotals | null;
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
