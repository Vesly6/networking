import { countWorkerActionsGrouped, type WorkerActionType } from '../tableData/db.js';
import { countSentGroupedByWorker } from '../linkedinPlanner/db.js';
import { getCompanyTimezone, listWorkers, getCompanySuperAdmin } from '../accounts/db.js';
import { upsertDailyMetrics, getMetricsForRange, listSyncStates, type DashboardMetric } from './db.js';

// Day-bucketing in an arbitrary IANA zone, using the native Intl API (Node
// ships full ICU — no date-fns-tz/luxon dependency needed). A small,
// self-contained duplicate of the equivalent helpers in
// server/src/linkedin/{safety,dailyPlan}.ts (getZonedDateParts/
// zonedMinuteOfDayToUtc) rather than importing them — that module belongs
// to the flag-disabled old LinkedIn automation feature, and this codebase's
// established convention is a fresh, undependent copy across feature
// boundaries (see linkedinPlanner/contactParsing.ts's own LINKEDIN_PATTERN
// duplicate) rather than coupling a new feature to a retired one's internals.

function getZonedDateStr(timeZone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** The instant (UTC epoch ms) that is local midnight of `dateStr` in
 * `timeZone` — same iterative-correction trick as
 * linkedin/dailyPlan.ts's zonedMinuteOfDayToUtc: guess assuming UTC, see
 * what wall-clock time that guess actually renders as in the target zone,
 * then shift by the difference. Correct across DST transitions since it
 * re-derives from the zone's own rendering rather than a fixed offset. */
function zonedMidnightUtc(dateStr: string, timeZone: string): number {
  const guessUtc = Date.parse(`${dateStr}T00:00:00Z`);
  const shownDateStr = getZonedDateStr(timeZone, new Date(guessUtc));
  if (shownDateStr === dateStr) return guessUtc;
  // Off by a day in one direction (guessUtc's UTC midnight lands on the
  // previous/next local day depending on the zone's offset sign) — binary-
  // search-free since the true answer is always within ±36h of the guess;
  // step by whole days until the shown date matches, then fall through to
  // the sub-day correction below.
  let corrected = guessUtc;
  let shown = shownDateStr;
  for (let i = 0; i < 3 && shown !== dateStr; i++) {
    corrected += shown < dateStr ? 24 * 60 * 60_000 : -24 * 60 * 60_000;
    shown = getZonedDateStr(timeZone, new Date(corrected));
  }
  return corrected;
}

export function addCalendarDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function todayDateStrForCompany(companyId: string): string {
  return getZonedDateStr(getCompanyTimezone(companyId), new Date());
}

/** Used by the periodic tick to finalize "yesterday" — a live-today read
 * only ever touches TODAY's bucket, so without this, a company whose
 * dashboard nobody happens to load right around midnight would have
 * yesterday's bucket sit at whatever partial value the last live read
 * left it at, forever. */
export function yesterdayDateStrForCompany(companyId: string): string {
  return addCalendarDays(todayDateStrForCompany(companyId), -1);
}

/** [start, end) UTC-ms range for one local calendar day in this company's
 * own timezone — what every internal-metrics query below bounds itself
 * to, so a range read never touches more than one day's worth of rows
 * regardless of how large worker_actions/planner_task_history have grown. */
function dayRangeUtc(companyId: string, dateStr: string): { since: number; until: number } {
  const tz = getCompanyTimezone(companyId);
  return { since: zonedMidnightUtc(dateStr, tz), until: zonedMidnightUtc(addCalendarDays(dateStr, 1), tz) };
}

const INTERNAL_ACTION_TO_METRIC: Partial<Record<WorkerActionType, DashboardMetric>> = {
  note_added: 'notes',
  contact_added: 'contacts',
  company_added: 'companies_added',
};

/** Computes (never writes) every internal metric for one company, one
 * local calendar day — the shared core behind both the periodic rollup
 * tick and the live-today read path, so both always agree on exactly the
 * same day-boundary/grouping logic. Returns one entry per (worker, metric)
 * that had at least one event that day, plus one company-wide (`workerId:
 * null`) entry per metric summing across every worker — a metric with
 * zero activity all day simply has no entry (the read side treats a
 * missing bucket as 0, same as every other "sparse counter" in this app). */
export function computeInternalMetricsForDay(
  companyId: string,
  dateStr: string,
): { companyId: string; workerId: string | null; metric: DashboardMetric; date: string; value: number }[] {
  const range = dayRangeUtc(companyId, dateStr);
  const perWorkerTotals = new Map<DashboardMetric, Map<string, number>>();
  const bump = (metric: DashboardMetric, workerId: string, count: number) => {
    if (!perWorkerTotals.has(metric)) perWorkerTotals.set(metric, new Map());
    const byWorker = perWorkerTotals.get(metric)!;
    byWorker.set(workerId, (byWorker.get(workerId) ?? 0) + count);
  };

  const actionRows = countWorkerActionsGrouped(companyId, range, Object.keys(INTERNAL_ACTION_TO_METRIC) as WorkerActionType[]);
  for (const row of actionRows) {
    const metric = INTERNAL_ACTION_TO_METRIC[row.actionType];
    if (metric) bump(metric, row.userId, row.count);
  }

  const linkedinRows = countSentGroupedByWorker(companyId, range);
  for (const row of linkedinRows) bump('linkedin_sent', row.workerId, row.count);

  const entries: { companyId: string; workerId: string | null; metric: DashboardMetric; date: string; value: number }[] = [];
  for (const [metric, byWorker] of perWorkerTotals) {
    let companyTotal = 0;
    for (const [workerId, value] of byWorker) {
      entries.push({ companyId, workerId, metric, date: dateStr, value });
      companyTotal += value;
    }
    entries.push({ companyId, workerId: null, metric, date: dateStr, value: companyTotal });
  }
  return entries;
}

/** Computes AND persists — the periodic tick's per-company, per-day unit
 * of work. Idempotent (upsertDailyMetric always replaces, never adds), so
 * calling this repeatedly for the same (company, day) — which the tick
 * does every cycle for "today" — is always safe. */
export function rollupInternalMetricsForCompany(companyId: string, dateStr: string): void {
  upsertDailyMetrics(computeInternalMetricsForDay(companyId, dateStr));
}

/** The live-today read path (index.ts's dashboard routes): computes fresh
 * rather than trusting whatever the last periodic tick happened to write
 * (today's bucket is still "in progress" until the day ends), and
 * opportunistically persists the result — so a page load right after
 * midnight (before the next ~10-minute tick runs) still shows accurate
 * numbers immediately, not a stale/empty bucket. Bounded to one day's
 * worth of rows regardless of table size (see dayRangeUtc above), so this
 * is safe to call on every dashboard page load, unlike an external-API
 * fetch would be. */
export function getLiveTodayInternalMetrics(companyId: string): { workerId: string | null; metric: DashboardMetric; value: number }[] {
  const dateStr = todayDateStrForCompany(companyId);
  const entries = computeInternalMetricsForDay(companyId, dateStr);
  upsertDailyMetrics(entries);
  return entries.map(({ workerId, metric, value }) => ({ workerId, metric, value }));
}

// --- Read path for the dashboard's own routes -----------------------------

export type DashboardPeriod = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';

/** Every metric the MVP dashboard shows, in the order the UI lists them —
 * a single source of truth so the summary/per-worker routes and the
 * frontend can't drift out of sync on "which metrics exist." Deliberately
 * excludes 'companies_added' (still a real DashboardMetric/tracked
 * WorkerActionType, still rolled up into daily_metrics — see
 * computeInternalMetricsForDay below — just never surfaced here): the
 * account owner pointed out it doesn't fit how this CRM is actually used
 * — a table's rows (companies) are an exact, pre-built list worked from
 * the start, not something that grows incrementally the way contacts
 * genuinely do, so "companies added" isn't a meaningful ongoing activity
 * metric here. */
export const DASHBOARD_METRICS: DashboardMetric[] = ['notes', 'contacts', 'calls', 'linkedin_sent'];

export interface DateRange {
  from: string;
  to: string;
}

/** Resolves a period keyword (or an explicit custom range) into an
 * inclusive [from, to] date-string range, anchored to THIS company's own
 * "today" — never the server's UTC date or a client-supplied one, for the
 * same reason every other day-boundary computation in this module is
 * company-timezone-aware. `custom` is trusted as-is (already validated by
 * the route as YYYY-MM-DD strings) but still clamped so `to` never runs
 * past this company's own today. */
export function resolvePeriodRange(companyId: string, period: DashboardPeriod, custom?: DateRange): DateRange {
  const today = todayDateStrForCompany(companyId);
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = yesterdayDateStrForCompany(companyId);
      return { from: y, to: y };
    }
    case '7d':
      return { from: addCalendarDays(today, -6), to: today };
    case '30d':
      return { from: addCalendarDays(today, -29), to: today };
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'custom': {
      if (!custom) return { from: today, to: today };
      const to = custom.to > today ? today : custom.to;
      const from = custom.from > to ? to : custom.from;
      return { from, to };
    }
  }
}

/** The immediately preceding range of the SAME length — what each summary
 * card's vs-previous-period arrow/% compares against. A 7-day range
 * compares against the 7 days right before it, etc. */
export function previousPeriodRange(range: DateRange): DateRange {
  const days = (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 + 1;
  return { from: addCalendarDays(range.from, -days), to: addCalendarDays(range.from, -1) };
}

/** Sums daily_metrics rows in a range into one number per metric — the
 * summary cards' actual numbers. Ensures today's internal-metric bucket is
 * freshly computed first whenever the range's own `to` is today (so a
 * range that happens to include today never reads a stale in-progress
 * bucket for it); external metrics (calls) are never refreshed here, only
 * ever read as of the last background sync, per this feature's own
 * "external data is sync-based" rule. */
export function summarizeMetrics(companyId: string, range: DateRange, workerId: string | null): Record<DashboardMetric, number> {
  if (range.to >= todayDateStrForCompany(companyId)) getLiveTodayInternalMetrics(companyId);
  const rows = getMetricsForRange(companyId, { workerId, metrics: DASHBOARD_METRICS, from: range.from, to: range.to });
  const totals = Object.fromEntries(DASHBOARD_METRICS.map((m) => [m, 0])) as Record<DashboardMetric, number>;
  for (const row of rows) totals[row.metric] += row.value;
  return totals;
}

/** The single "Обновлено N minučių atgal" freshness label — the OLDEST
 * successful sync across every source this company has ever run (internal
 * rollup + Zadarma, later Apollo/Instantly), not just one of them. A
 * source that has never synced at all (e.g. Zadarma never configured) is
 * simply absent from dashboard_sync_state and doesn't drag this down —
 * only sources actually in play count toward "how fresh is what's shown." */
export function oldestSuccessfulSyncAt(companyId: string): number | null {
  const states = listSyncStates(companyId).filter((s) => s.lastSyncedAt !== null);
  if (states.length === 0) return null;
  return Math.min(...states.map((s) => s.lastSyncedAt!));
}

export interface DashboardWorkerRow {
  workerId: string;
  workerName: string;
  metrics: Record<DashboardMetric, number>;
}

/** The per-worker table's own rows — every real person in the company
 * (every worker, plus the super_admin themselves — see rowActionAttribution's
 * own fix elsewhere in this plan for why the admin's activity is now
 * tracked at all), listed regardless of whether they had any activity in
 * this range (a worker with all zeros is still a real row, per the
 * request's own mockup — not filtered out). */
export function getWorkerRows(companyId: string, range: DateRange): DashboardWorkerRow[] {
  if (range.to >= todayDateStrForCompany(companyId)) getLiveTodayInternalMetrics(companyId);
  const people = [...listWorkers(companyId).map((w) => ({ id: w.id, name: `${w.firstName} ${w.lastName}`.trim() || w.username }))];
  const admin = getCompanySuperAdmin(companyId);
  if (admin) people.push({ id: admin.id, name: `${admin.firstName} ${admin.lastName}`.trim() || admin.username });

  return people.map(({ id, name }) => {
    const rows = getMetricsForRange(companyId, { workerId: id, metrics: DASHBOARD_METRICS, from: range.from, to: range.to });
    const metrics = Object.fromEntries(DASHBOARD_METRICS.map((m) => [m, 0])) as Record<DashboardMetric, number>;
    for (const row of rows) metrics[row.metric] += row.value;
    return { workerId: id, workerName: name, metrics };
  });
}
