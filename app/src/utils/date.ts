import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isSameMonth,
  startOfMonth,
  startOfWeek,
  subMonths,
} from 'date-fns';
import { lt } from 'date-fns/locale';

/** ISO yyyy-MM-dd strings sort lexically the same as chronologically,
 * so date comparisons can stay plain string comparisons — no timezone
 * parsing bugs. A next-action value is either a bare date ("2026-08-15")
 * or a date with an optional time ("2026-08-15T14:00") — these helpers
 * always compare/format on the date part alone. */
export function todayISO(): string {
  return format(new Date(), 'yyyy-MM-dd');
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

export function isFuture(value: string): boolean {
  return !!value && getDatePart(value) > todayISO();
}

/** Date part only — callers that also want the time should read
 * getTimePart() separately and render it as its own element. (This used to
 * append ", HH:mm" itself, which duplicated the time once TaskListView
 * started rendering a dedicated time badge next to it.) */
export function formatDisplayDate(value: string): string {
  if (!value) return '';
  const [y, m, d] = getDatePart(value).split('-').map(Number);
  // Lithuanian long-date order is year-month-day ("2026 m. rugpjūčio 15
  // d."), not English's month-day-year — bolting {locale: lt} onto an
  // English-ordered token string would produce a Lithuanian month name in
  // the wrong word order, so the token string itself changes too.
  return format(new Date(y, m - 1, d), "yyyy 'm'. MMMM d 'd'.", { locale: lt });
}

export function nextMonth(date: Date): Date {
  return addMonths(date, 1);
}

export function prevMonth(date: Date): Date {
  return subMonths(date, 1);
}

export function monthLabel(date: Date): string {
  return format(date, 'LLLL yyyy', { locale: lt });
}

/** For note-history entries: a real epoch-ms timestamp (not a date-only
 * cell value), formatted as e.g. "2026 m. rugp. 15 d. 14:32" — 24-hour
 * time, not English's 12-hour+am/pm, which has no natural LT equivalent. */
export function formatHistoryTimestamp(ms: number): string {
  if (!ms) return '';
  return format(new Date(ms), "yyyy 'm'. MMM d 'd'. HH:mm", { locale: lt });
}

export interface MonthDay {
  date: Date;
  iso: string;
  inCurrentMonth: boolean;
}

export function getMonthGrid(monthDate: Date): MonthDay[] {
  const start = startOfWeek(startOfMonth(monthDate), { weekStartsOn: 1 });
  const end = endOfWeek(endOfMonth(monthDate), { weekStartsOn: 1 });
  return eachDayOfInterval({ start, end }).map((date) => ({
    date,
    iso: format(date, 'yyyy-MM-dd'),
    inCurrentMonth: isSameMonth(date, monthDate),
  }));
}
