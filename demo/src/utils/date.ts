// A native-Date reimplementation of the subset of app/src/utils/date.ts
// the Calendar tab needs — no date-fns dependency added for this one
// feature, matching this demo's existing "no heavy dependencies for an
// isolated need" convention (see utils/noteHistory.ts's own
// formatHistoryTimestamp). English month/weekday names throughout,
// matching the demo's own English-UI convention.

/** ISO yyyy-MM-dd strings sort lexically the same as chronologically, so
 * date comparisons can stay plain string comparisons. A next-action value
 * is either a bare date ("2026-08-15") or a date with an optional time
 * ("2026-08-15T14:00") — these helpers always compare/format on the date
 * part alone. */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayISO(): string {
  return toIsoDate(new Date());
}

export function getDatePart(value: string): string {
  return value.slice(0, 10);
}

export function hasTime(value: string): boolean {
  return value.length > 10;
}

export function getTimePart(value: string): string {
  return hasTime(value) ? value.slice(11, 16) : '';
}

export function combineDateTime(date: string, time: string): string {
  return time ? `${date}T${time}` : date;
}

export function isOverdue(value: string): boolean {
  return !!value && getDatePart(value) < todayISO();
}

export function isDueToday(value: string): boolean {
  return !!value && getDatePart(value) === todayISO();
}

/** Same "fall back to the raw value on an unparseable date" fix as
 * production's own formatDisplayDate — a date-type cell is still just a
 * plain string, so a paste/CSV-import mismatch reaching here as NaN
 * y/m/d must not throw and take down every row's render with it. */
export function formatDisplayDate(value: string): string {
  if (!value) return '';
  const [y, m, d] = getDatePart(value).split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function nextMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 1);
}

export function prevMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() - 1, 1);
}

export function monthLabel(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export interface MonthDay {
  date: Date;
  iso: string;
  inCurrentMonth: boolean;
}

/** Monday-first week grid spanning the full weeks touching this month —
 * same shape as production's getMonthGrid (date-fns' startOfWeek/endOfWeek
 * with weekStartsOn: 1), built from native Date arithmetic instead. */
export function getMonthGrid(monthDate: Date): MonthDay[] {
  const firstOfMonth = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const lastOfMonth = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);

  // getDay(): 0=Sunday..6=Saturday — convert to a Monday-first offset.
  const startOffset = (firstOfMonth.getDay() + 6) % 7;
  const endOffset = (7 - ((lastOfMonth.getDay() + 6) % 7) - 1) % 7;

  const start = new Date(firstOfMonth);
  start.setDate(start.getDate() - startOffset);
  const end = new Date(lastOfMonth);
  end.setDate(end.getDate() + endOffset);

  const days: MonthDay[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    const date = new Date(cursor);
    days.push({ date, iso: toIsoDate(date), inCurrentMonth: date.getMonth() === monthDate.getMonth() });
  }
  return days;
}
