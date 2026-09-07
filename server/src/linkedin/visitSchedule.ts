import { getVisitSchedule, saveVisitSchedule, type VisitScheduleRow } from './db.js';
import { getZonedDateParts, type SafetySettings } from './safety.js';
import { hashString, mulberry32, triangularJitter, zonedMinuteOfDayToUtc, workHoursToMinutes } from './dailyPlan.js';

export interface VisitWindow {
  start: number;
  end: number;
}

export interface VisitPlan {
  date: string;
  windows: VisitWindow[];
}

// A window shorter than this (only possible right at the tail end of the
// work-hours span, when there isn't enough room left for a full-length
// visit) isn't worth opening a tab for at all — dropped rather than kept
// as a token few-minute window.
const MIN_WINDOW_MINUTES = 5;

/** Walks forward across [startMin, endMin) laying down jittered
 * {start, duration} visit windows separated by jittered gaps — mirrors
 * dailyPlan.ts's own "jittered, not evenly spaced" philosophy, just for
 * *when the tab is open at all* rather than *when a specific action
 * fires*. The first window starts with a small random offset from
 * startMin (so the very first visit of the day isn't always exactly at
 * work-hours start), and the walk simply stops once it runs past endMin —
 * there's no fixed target count the way dailyPlan.ts has one, since "how
 * many visits fit today" is itself a natural consequence of the
 * configured gap/duration against the work-hours span, not a separately
 * tuned number. */
function generateVisitWindowsMinutes(
  startMin: number,
  endMin: number,
  gapHours: number,
  durationMinutes: number,
  rand: () => number,
): Array<{ startMin: number; endMin: number }> {
  const windows: Array<{ startMin: number; endMin: number }> = [];
  const gapMin = Math.max(1, gapHours * 60);
  const duration = Math.max(1, durationMinutes);

  let cursorMin = startMin + triangularJitter(0, gapMin * 0.5, rand);
  while (cursorMin < endMin) {
    const winStartMin = Math.min(cursorMin, endMin);
    const winDuration = triangularJitter(duration * 0.5, duration * 1.5, rand);
    const winEndMin = Math.min(endMin, winStartMin + winDuration);
    if (winEndMin - winStartMin >= MIN_WINDOW_MINUTES) {
      windows.push({ startMin: winStartMin, endMin: winEndMin });
    }
    const gap = triangularJitter(gapMin * 0.7, gapMin * 1.3, rand);
    cursorMin = winEndMin + gap;
  }
  return windows;
}

/** Generates (once per local day) or returns the already-generated set of
 * "visit windows" for today, in the account's own `workHoursTimezone` —
 * same day-boundary rule as dailyPlan.ts's getOrCreateTodaysPlan, and
 * deliberately independent of it: dailyPlan.ts's own plan governs *when
 * within an open visit* a connect/message actually fires, this governs
 * *whether the tab is even open at all* right now. `companyId` seeds the
 * day's layout the same way dailyPlan.ts's own plan is seeded — a
 * different string ('visits:...' vs. dailyPlan's own key) so the two
 * plans don't happen to draw identical random sequences from the same
 * seed for no reason. */
export async function getOrCreateTodaysVisitPlan(settings: SafetySettings, companyId: string, now = Date.now()): Promise<VisitPlan> {
  const { dateStr } = getZonedDateParts(settings.workHoursTimezone, new Date(now));
  const existing = getVisitSchedule(dateStr);
  if (existing) return existing;

  const rand = mulberry32(hashString(`visits:${companyId}:${dateStr}`));
  const { startMin, endMin } = workHoursToMinutes(settings);

  const minuteWindows =
    endMin > startMin ? generateVisitWindowsMinutes(startMin, endMin, settings.visitGapHours, settings.visitDurationMinutes, rand) : [];

  const plan: VisitScheduleRow = {
    date: dateStr,
    windows: minuteWindows.map((w) => ({
      start: zonedMinuteOfDayToUtc(dateStr, w.startMin, settings.workHoursTimezone),
      end: zonedMinuteOfDayToUtc(dateStr, w.endMin, settings.workHoursTimezone),
    })),
    generatedAt: Date.now(),
  };
  saveVisitSchedule(plan);
  // saveVisitSchedule is INSERT ... ON CONFLICT DO NOTHING — re-read rather
  // than trust `plan` as final, in case a concurrent caller won the race
  // and inserted first (same caution as dailyPlan.ts's own
  // getOrCreateTodaysPlan).
  return getVisitSchedule(dateStr) ?? plan;
}

export function isWithinVisitWindow(plan: VisitPlan, now = Date.now()): boolean {
  return plan.windows.some((w) => now >= w.start && now < w.end);
}

/** The start of the earliest window that hasn't begun yet, or `null` if
 * today has no more windows left — used only for surfacing "next visit at
 * ~HH:MM" in the UI, never for any gating decision. */
export function nextVisitWindowStart(plan: VisitPlan, now = Date.now()): number | null {
  return plan.windows.find((w) => w.start > now)?.start ?? null;
}
