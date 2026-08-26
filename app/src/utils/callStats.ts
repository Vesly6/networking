import type { CallRecord } from './callsApi';

/** A trimmed-down, recording-free copy of CallRecord — this is what
 * survives in IndexedDB (db.ts's `callStats` store) after Zadarma's own
 * statistics eventually age out. Deliberately excludes clid/destination/
 * is_recorded/sip: recordings/transcripts aren't part of the stats picture
 * the user asked for ("no recordings, just the numbers"), and re-deriving
 * otherParty from raw destination/clid is already done once, upstream, by
 * the server (see extractOtherParty() in server/src/zadarma.ts) — storing
 * its already-resolved output means this module never needs that logic. */
export interface CallStatRecord {
  call_id: string;
  callstart: string;
  seconds: number;
  disposition: string;
  otherParty: string;
  /** Absent until CallsStatsView's "Rodyti išlaidas" has been run for the
   * period this record falls in — see that component's own doc comment
   * for how it's fetched (reusing the same /api/calls/costs nearest-
   * timestamp correlation the live Calls list uses) and persisted back
   * onto this same IndexedDB record via saveCallStats, so it survives
   * without needing to be re-fetched every time the Statistics view is
   * reopened. */
  billcost?: string;
  currency?: string;
}

export function toCallStatRecord(call: CallRecord): CallStatRecord {
  return {
    call_id: call.call_id,
    callstart: call.callstart,
    seconds: call.seconds,
    disposition: call.disposition,
    otherParty: call.otherParty,
  };
}

export interface CallStatsSummary {
  totalCalls: number;
  answered: number;
  answerRate: number;
  totalSeconds: number;
  avgAnsweredSeconds: number;
  /** null when not one single record in the period has cost data yet (the
   * period has never had "Rodyti išlaidas" run for it) — distinct from a
   * real 0, which is a legitimate total (e.g. a period with only free
   * internal calls). withCost/withoutCost let the UI say "known total, N
   * calls still missing cost data" rather than implying the total is
   * complete when it might not be — costs are fetched with a 60s
   * nearest-timestamp tolerance (see server/src/zadarma.ts's
   * getCallCosts), so even a period that's been "run" once can end up
   * with a few calls never matched. Assumes a single currency across the
   * period (true in practice — one Zadarma account, one billing
   * currency); currency is whichever the first cost-bearing record has. */
  totalCost: number | null;
  currency: string | null;
  callsWithCost: number;
  callsWithoutCost: number;
}

export function summarize(records: CallStatRecord[]): CallStatsSummary {
  const totalCalls = records.length;
  const answeredRecords = records.filter((r) => r.disposition === 'answered');
  const answered = answeredRecords.length;
  const totalSeconds = records.reduce((sum, r) => sum + r.seconds, 0);
  const costRecords = records.filter((r) => r.billcost !== undefined);
  const totalCost = costRecords.length > 0 ? costRecords.reduce((sum, r) => sum + Number(r.billcost), 0) : null;
  const currency = costRecords[0]?.currency ?? null;
  return {
    totalCalls,
    answered,
    answerRate: totalCalls > 0 ? answered / totalCalls : 0,
    totalSeconds,
    avgAnsweredSeconds: answered > 0 ? totalSeconds / answered : 0,
    totalCost,
    currency,
    callsWithCost: costRecords.length,
    callsWithoutCost: totalCalls - costRecords.length,
  };
}

export interface DayBucket {
  /** yyyy-MM-dd */
  date: string;
  total: number;
  answered: number;
  seconds: number;
}

/** One bucket per calendar day in [startDate, endDate] (inclusive, both
 * yyyy-MM-dd), even for days with zero calls — a bar chart needs the gaps
 * to be real bars at height 0, not missing days that silently compress the
 * x-axis. */
export function bucketByDay(records: CallStatRecord[], startDate: string, endDate: string): DayBucket[] {
  const buckets = new Map<string, DayBucket>();
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
    buckets.set(d, { date: d, total: 0, answered: 0, seconds: 0 });
  }
  for (const r of records) {
    const date = r.callstart.slice(0, 10);
    const bucket = buckets.get(date);
    if (!bucket) continue; // outside the requested range
    bucket.total++;
    bucket.seconds += r.seconds;
    if (r.disposition === 'answered') bucket.answered++;
  }
  return Array.from(buckets.values());
}

// All date-string math below is anchored to UTC throughout — construction
// (Date.UTC), arithmetic (setUTCDate), and extraction (toISOString, which
// is always UTC) all agree with each other. This isn't just tidiness: the
// original version constructed via `new Date(dateString + 'T00:00:00')`
// (parsed as *local* midnight) but read the result back out through
// `toISOString()` (always UTC) — mixing the two meant that in any
// positive-UTC-offset timezone (e.g. UTC+7), advancing by a day and
// re-extracting the date could land back on the *same* calendar date
// instead of the next one. That's not just an off-by-one: every loop in
// this file and in useCallsStore's buildBackfillChunks() advances a date
// with exactly this function, so a version that can return its own input
// unchanged for `+1 day` doesn't just miscount — it never terminates,
// which is exactly what happened (reproduced live: the whole tab froze
// solid, unresponsive even to a screenshot request, the moment the Calls
// tab tried to mount and call this during the background history sync).
function toUtcDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(date: string, days: number): string {
  const d = toUtcDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Same day-of-month in a different month, clamped to that month's last
 * day if it's shorter (e.g. Jan 31 + 1 month -> Feb 28/29, not "March 3"
 * via JS Date's own default overflow behavior). Used for the Statistics
 * view's month prev/next navigation. */
export function addMonths(date: string, months: number): string {
  const d = toUtcDate(date);
  const targetMonth = d.getUTCMonth() + months;
  const lastDayOfTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
  d.setUTCMonth(targetMonth, Math.min(d.getUTCDate(), lastDayOfTargetMonth));
  return d.toISOString().slice(0, 10);
}

export function todayDateString(): string {
  // Local calendar date, not UTC — "today" should match what the clock on
  // the wall says, not flip over at UTC midnight while it's still evening
  // locally in a positive-offset timezone.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 0 = Monday .. 6 = Sunday, computed the same UTC-anchored way as
 * everything else in this file. */
export function dayOfWeek(date: string): number {
  return (toUtcDate(date).getUTCDay() + 6) % 7;
}

/** Monday-start week containing `date`, as [start, end] yyyy-MM-dd. */
export function weekRange(date: string): { start: string; end: string } {
  const dow = dayOfWeek(date);
  const start = addDays(date, -dow);
  const end = addDays(start, 6);
  return { start, end };
}

/** Calendar month containing `date`, as [start, end] yyyy-MM-dd. */
export function monthRange(date: string): { start: string; end: string } {
  const d = toUtcDate(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const end = `${y}-${String(m + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h} val. ${m} min.`;
  const s = totalSeconds % 60;
  return m > 0 ? `${m} min. ${s} s.` : `${s} s.`;
}
