import { getCompanyIntegrations, getCompanyTimezone, listWorkers, getCompanySuperAdmin } from '../accounts/db.js';
import { getStatistics } from '../zadarma.js';
import { getCampaignAnalyticsDaily } from '../instantly.js';
import { upsertDailyMetrics, setSyncState, setSyncLog } from './db.js';
import { todayDateStrForCompany, addCalendarDays } from './aggregate.js';

/** "YYYY-MM-DD HH:MM:SS" in an arbitrary IANA zone — the exact literal
 * wall-clock string format getStatistics()/Zadarma's own API expects (see
 * index.ts's GET /api/calls, which passes through whatever string the
 * browser's local date/time inputs produced). There's no live browser
 * here (this runs from a background tick), so the company's own
 * `timezone` setting is what stands in for "whoever would be looking at
 * this company's calls" — the same imprecision the interactive route
 * already has today (a browser's own local date input isn't necessarily
 * the Zadarma ACCOUNT's own configured timezone either), not something
 * newly introduced by this sync job. */
export function zonedDateTimeStr(timeZone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`;
}

/** One company-wide (unfiltered, no `sip` param) statistics fetch covers
 * every worker's calls in a single request, grouped by the `sip` field
 * already present on every returned record — this is what keeps the sync
 * trivially inside Zadarma's documented 10-req/minute cap regardless of
 * how many workers a company has (1 request per company per tick, not 1
 * per worker). Sips that don't map to any known worker's own
 * `zadarmaSip` still count toward the company-wide total (a real call
 * genuinely happened on this account) but simply aren't attributed to a
 * specific tracked worker — same "company total is accurate, per-worker
 * is best-effort" principle used elsewhere in this feature. */
export async function syncZadarmaCallsForCompany(companyId: string): Promise<void> {
  const integrations = getCompanyIntegrations(companyId);
  if (!integrations?.zadarmaApiKey || !integrations?.zadarmaApiSecret) return; // not configured — nothing to sync, not an error
  const tz = getCompanyTimezone(companyId);
  const dateStr = todayDateStrForCompany(companyId);

  try {
    const sipToWorkerId = new Map<string, string>();
    for (const worker of listWorkers(companyId)) {
      if (worker.zadarmaSip) sipToWorkerId.set(worker.zadarmaSip, worker.id);
    }
    const admin = getCompanySuperAdmin(companyId);
    if (admin?.zadarmaSip) sipToWorkerId.set(admin.zadarmaSip, admin.id);

    const start = `${dateStr} 00:00:00`;
    const end = zonedDateTimeStr(tz, new Date());
    const { stats } = await getStatistics({ start, end }, { key: integrations.zadarmaApiKey, secret: integrations.zadarmaApiSecret });

    const perWorkerCounts = new Map<string, number>();
    for (const call of stats) {
      const workerId = sipToWorkerId.get(call.sip);
      if (workerId) perWorkerCounts.set(workerId, (perWorkerCounts.get(workerId) ?? 0) + 1);
    }

    const entries: { companyId: string; workerId: string | null; metric: 'calls'; date: string; value: number }[] = [...perWorkerCounts.entries()].map(
      ([workerId, value]) => ({ companyId, workerId, metric: 'calls', date: dateStr, value }),
    );
    entries.push({ companyId, workerId: null, metric: 'calls', date: dateStr, value: stats.length });
    upsertDailyMetrics(entries);
    setSyncState(companyId, 'zadarma', { ok: true });
  } catch (err) {
    setSyncState(companyId, 'zadarma', { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// How many trailing days get refreshed on every sync tick — one API call
// (Instantly's own /campaigns/analytics/daily, already broken down per day
// account-wide, no per-campaign fan-out needed) refills this whole window
// every time, so the dashboard's 7d/30d/month periods are always backed by
// real, already-bucketed daily numbers without needing 30 separate calls.
// Bounded, not "since account creation," for the same reason every other
// backfill window in this app is bounded (see useCallsStore.ts's own
// BACKFILL_DEFAULT_DAYS) — a custom range older than this simply won't
// have synced data yet, an accepted MVP scope cut.
const INSTANTLY_SYNC_WINDOW_DAYS = 30;

/** Company-wide only, no per-worker split — an explicit, deliberate scope
 * decision (see the account owner's own reasoning): Instantly campaign
 * sends fire automatically from Instantly's own sequence engine, never
 * from a button inside IRMS, so there is no real "which worker did this"
 * signal to attribute email activity to, unlike calls (SIP extension) or
 * LinkedIn (a real send button). Only synced in the company's default
 * Shared key mode — Individual mode would mean each worker's own separate
 * Instantly account/workspace, and summing those into one "company" total
 * is exactly the added complexity the account owner asked to skip for
 * now ("просто общую статистику того что происходит в инстантли
 * акаунте"). */
export async function syncInstantlyEmailStatsForCompany(companyId: string): Promise<void> {
  const integrations = getCompanyIntegrations(companyId);
  if (!integrations?.instantlyApiKey) return; // not configured — nothing to sync, not an error
  if ((integrations.instantlyMode ?? 'shared') !== 'shared') return; // Individual mode — see doc comment above

  const today = todayDateStrForCompany(companyId);
  const from = addCalendarDays(today, -(INSTANTLY_SYNC_WINDOW_DAYS - 1));
  const params = { start_date: from, end_date: today };

  try {
    const days = await getCampaignAnalyticsDaily(params, integrations.instantlyApiKey);
    // The account owner's own explicit request — a way to cross-check a
    // computed dashboard number against exactly what Instantly's API
    // returned for the identical request, not just trust it blind.
    setSyncLog(companyId, 'instantly', params, days);

    const entries: { companyId: string; workerId: null; metric: 'emails_sent' | 'email_replies' | 'positive_replies'; date: string; value: number }[] = [];
    for (const day of days) {
      entries.push({ companyId, workerId: null, metric: 'emails_sent', date: day.date, value: day.sent });
      // unique_replies (distinct leads who replied), not the raw `replies`
      // count — a reply rate should read as "what fraction of the people
      // I emailed wrote back," not be inflated by one lead replying twice
      // in the same thread.
      entries.push({ companyId, workerId: null, metric: 'email_replies', date: day.date, value: day.unique_replies });
      // The account owner's own explicit "positive reply rate" request —
      // Instantly's daily analytics has no dedicated "positive reply"
      // count, so `opportunities` (a lead whose interest crossed into
      // Interested/Meeting-booked/Won territory in this workspace's own
      // CRM) is the closest per-day-bucketed proxy this API exposes,
      // reusing the SAME call as sent/replies above rather than a second,
      // heavier per-lead scan. Surfaced honestly, not as an exact count —
      // see EmailStats.positiveReplies' own doc comment.
      entries.push({ companyId, workerId: null, metric: 'positive_replies', date: day.date, value: day.opportunities ?? 0 });
    }
    upsertDailyMetrics(entries);
    setSyncState(companyId, 'instantly', { ok: true });
  } catch (err) {
    setSyncState(companyId, 'instantly', { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
