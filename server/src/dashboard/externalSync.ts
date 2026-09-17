import { getCompanyIntegrations, getCompanyTimezone, listWorkers, getCompanySuperAdmin } from '../accounts/db.js';
import { getStatistics } from '../zadarma.js';
import { upsertDailyMetrics, setSyncState } from './db.js';
import { todayDateStrForCompany } from './aggregate.js';

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
function zonedDateTimeStr(timeZone: string, instant: Date): string {
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
