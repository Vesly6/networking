import { getDailySchedule, saveDailySchedule, getActionsSince, type DailyScheduleRow } from './db.js';
import { getZonedDateParts, type SafetySettings } from './safety.js';
import { suggestDailyScheduleMinutes } from '../openai.js';

export interface DailyPlan {
  date: string;
  plannedSlots: number[];
  targetCount: number;
  isWeekend: boolean;
}

const WEEKEND_DAYS = new Set(['Saturday', 'Sunday']);
const DAY_MS = 86_400_000;

// --- Seeded randomness ------------------------------------------------
// Deliberately not Math.random() for the parts that need to be *stable*
// per (account, day) — a plan, once generated, must read back identically
// on every later call the same day (getOrCreateTodaysPlan below only
// generates once, but the persona bias specifically needs to be the same
// account-to-account comparison every day, not re-rolled). A small
// deterministic hash + mulberry32 PRNG gives that without storing
// anything beyond companyId itself.
function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same triangular-ish "cluster around the middle, not a flat draw" shape
 * as browser.ts's humanDelay() — mirrored here as a pure value generator
 * (not a sleeping Promise) since dailyPlan.ts needs actual clock times to
 * persist, not delays to await. Kept local rather than importing
 * humanDelay itself, which always sleeps as a side effect. */
function triangularJitter(min: number, max: number, rand: () => number): number {
  const u = (rand() + rand() + rand()) / 3;
  return min + (max - min) * u;
}

// --- Local-wall-clock <-> epoch conversion -----------------------------

/** Inverse of safety.ts's getZonedDateParts: given a local calendar date +
 * minute-of-day in `timeZone`, returns the corresponding UTC epoch ms.
 * Intl only *formats* a Date into a zone, it has no built-in "parse this
 * wall-clock time in zone X" — this does it in one correction pass (guess
 * the offset by treating the wall time as UTC, see how that guess actually
 * reads in the target zone, shift by the difference). One pass is
 * deliberately enough for this feature: slot times only need to land
 * within a minute or two of intended, this isn't a billing system where a
 * DST-transition edge case needs perfect precision. */
function zonedMinuteOfDayToUtc(dateStr: string, minuteOfDay: number, timeZone: string): number {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(minuteOfDay)));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;
  const guessUtc = Date.parse(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const shown = getZonedDateParts(timeZone, new Date(guessUtc));
  const [shownH, shownM] = shown.hhmm.split(':').map(Number);
  const diffMinutes = clamped - (shownH * 60 + shownM);
  return guessUtc + diffMinutes * 60_000;
}

function workHoursToMinutes(settings: SafetySettings): { startMin: number; endMin: number } {
  const [sh, sm] = settings.workHoursStart.split(':').map(Number);
  const [eh, em] = settings.workHoursEnd.split(':').map(Number);
  return { startMin: sh * 60 + sm, endMin: eh * 60 + em };
}

// --- Slot generation -----------------------------------------------------

/** Weekday pattern: 2-3 loose "sessions" (late morning, lunch, after-work)
 * rather than an even spread — each day's exact session centers/shares are
 * re-jittered, and `personaBiasFrac` (0-1, stable per account, see
 * getOrCreateTodaysPlan) shifts all of them slightly earlier or later so
 * two accounts with identical settings still keep visibly different
 * rhythms day after day. */
function generateWeekdayMinutes(startMin: number, endMin: number, targetCount: number, rand: () => number, personaBiasFrac: number): number[] {
  if (targetCount <= 0) return [];
  const span = endMin - startMin;
  const baseCenters = [0.15, 0.45, 0.82];
  const centers = baseCenters.map((frac) => {
    const biased = frac + (personaBiasFrac - 0.5) * 0.12;
    const jittered = biased + (rand() - 0.5) * 0.08;
    return Math.min(0.96, Math.max(0.04, jittered));
  });
  // Uneven split of targetCount across sessions — weighted random shares,
  // re-normalized so the counts still sum exactly to targetCount (plain
  // rounding drift corrected by nudging the first few sessions).
  const weights = centers.map(() => 0.4 + rand() * 1.2);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map((w) => Math.round((w / weightSum) * targetCount));
  let drift = targetCount - counts.reduce((a, b) => a + b, 0);
  for (let i = 0; drift !== 0; i = (i + 1) % counts.length) {
    counts[i] += drift > 0 ? 1 : -1;
    drift += drift > 0 ? -1 : 1;
  }

  const slots: number[] = [];
  centers.forEach((centerFrac, i) => {
    const centerMin = startMin + span * centerFrac;
    for (let j = 0; j < counts[i]; j++) {
      const spread = span * 0.12;
      const minute = centerMin + (triangularJitter(-spread, spread, rand));
      slots.push(Math.min(endMin, Math.max(startMin, minute)));
    }
  });
  return slots.sort((a, b) => a - b);
}

/** Weekend pattern: no session clustering at all — a wide, low-density
 * spread across the whole work-hours window, closer to "idly checking the
 * phone at random points in the day" than a work rhythm. */
function generateWeekendMinutes(startMin: number, endMin: number, targetCount: number, rand: () => number): number[] {
  if (targetCount <= 0) return [];
  const span = endMin - startMin;
  const slots: number[] = [];
  for (let i = 0; i < targetCount; i++) {
    slots.push(startMin + rand() * span);
  }
  return slots.sort((a, b) => a - b);
}

/** Successful connect-send times from the last `lookbackMs`, converted to
 * minutes-since-midnight in `timeZone` — pure style context for the
 * AI-assisted path below (suggestDailyScheduleMinutes's optional "recent
 * actual times" input), never used for anything that affects correctness.
 * Deliberately not scoped to exactly "yesterday" (which would need its own
 * add/subtract-a-day-in-zone helper this codebase doesn't have yet) — a
 * rolling lookback window is just as useful as reference material and
 * needs no new date arithmetic. */
function getRecentActualMinutes(timeZone: string, now: number, lookbackMs = 2 * DAY_MS): number[] {
  const actions = getActionsSince(now - lookbackMs);
  return actions
    .filter((a) => a.actionType === 'connect' && a.status === 'success')
    .map((a) => {
      const { hhmm } = getZonedDateParts(timeZone, new Date(a.executedAt));
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    });
}

/** Validates and clamps a raw AI-proposed minute list against the actual
 * work-hours window: keeps only in-range integers, dedupes (two proposed
 * times within the same minute collapse to one), sorts ascending, and caps
 * at `targetCount`. Returns `null` (never a partial/padded result) if what
 * survives is too sparse to trust — deliberately a wholesale accept-or-
 * reject rather than mixing AI and procedural slots for the same day,
 * which would need this module to reason about two different generation
 * strategies' output at once for no real benefit in what's meant to be a
 * simple opt-in comparison layer. "Too sparse" is under half the requested
 * count — a model that gets most of the count right but not quite all of
 * it is still usable context-following; one that returns far fewer than
 * asked isn't a suggestion worth trusting for the day. */
function validateAiMinutes(raw: number[], startMin: number, endMin: number, targetCount: number): number[] | null {
  if (targetCount <= 0) return [];
  const inRange = raw.filter((n) => Number.isInteger(n) && n >= startMin && n <= endMin);
  const deduped = Array.from(new Set(inRange)).sort((a, b) => a - b);
  if (deduped.length < Math.ceil(targetCount / 2)) return null;
  return deduped.slice(0, targetCount);
}

/** Generates (once per local day) or returns the already-generated plan
 * for "today" in the account's own `workHoursTimezone` — deliberately not
 * UTC and not the server's own local date, since this is specifically
 * about when the account owner's day actually starts. `effectiveDailyCap`
 * is passed in already warm-up-adjusted (safety.ts's own concern, not
 * duplicated here). `companyId` seeds both the day-to-day variation
 * (combined with the date, so no two days repeat) and the stable
 * per-account persona bias (combined with companyId alone, so it stays
 * consistent for that account across every day).
 *
 * When `settings.aiScheduleEnabled` is on AND an OpenAI key is configured,
 * this first tries asking the model for today's slot times
 * (suggestDailyScheduleMinutes) and, if what comes back survives
 * validateAiMinutes()'s validation, uses that instead of the procedural
 * generator for today. Any failure along that path — no key configured,
 * the request itself failing, a malformed/too-sparse response — silently
 * falls back to the procedural generator; this is an explicit live
 * experiment layered on top of the deterministic generator, never a
 * replacement for the guarantee that a plan gets generated correctly
 * regardless of AI availability. */
export async function getOrCreateTodaysPlan(settings: SafetySettings, effectiveDailyCap: number, companyId: string, now = Date.now()): Promise<DailyPlan> {
  const { dateStr, weekday } = getZonedDateParts(settings.workHoursTimezone, new Date(now));
  const existing = getDailySchedule(dateStr);
  if (existing) return existing;

  const isWeekend = WEEKEND_DAYS.has(weekday);
  const dayRand = mulberry32(hashString(`${companyId}:${dateStr}`));
  // Persona bias is derived from companyId ALONE (no date mixed in) so it
  // reads the same every day for this account — a stable "character," not
  // fresh randomness each time.
  const personaBiasFrac = mulberry32(hashString(`persona:${companyId}`))();

  // Proportional to the day's own effective cap, not a flat count — see
  // safety.ts's daily_target_jitter_pct doc comment for why. Floored at 1
  // (when the cap itself is > 0) rather than 0, so a low warm-up-era cap
  // still gets a real planned action most days instead of the jitter roll
  // regularly swallowing it whole.
  const jitterPct = Math.max(0, settings.dailyTargetJitterPct);
  const jitterAbs = Math.round((effectiveDailyCap * jitterPct) / 100);
  const targetCount = Math.max(effectiveDailyCap > 0 ? 1 : 0, effectiveDailyCap - Math.round(triangularJitter(0, jitterAbs, dayRand)));

  const { startMin, endMin } = workHoursToMinutes(settings);

  let minuteSlots: number[] | null = null;
  const apiKey = process.env.OPENAI_API_KEY;
  if (settings.aiScheduleEnabled && apiKey) {
    try {
      const raw = await suggestDailyScheduleMinutes(
        {
          targetCount,
          startMin,
          endMin,
          isWeekend,
          recentActualMinutes: getRecentActualMinutes(settings.workHoursTimezone, now),
        },
        apiKey,
      );
      minuteSlots = validateAiMinutes(raw, startMin, endMin, targetCount);
      if (minuteSlots) {
        console.log('[linkedin/dailyPlan] using AI-suggested schedule for', dateStr, '—', minuteSlots.length, 'slot(s).');
      } else {
        console.log('[linkedin/dailyPlan] AI schedule suggestion failed validation for', dateStr, '— falling back to procedural generator.');
      }
    } catch (err) {
      console.log('[linkedin/dailyPlan] AI schedule suggestion failed for', dateStr, '—', err instanceof Error ? err.message : err, '— falling back to procedural generator.');
    }
  }
  if (!minuteSlots) {
    minuteSlots = isWeekend
      ? generateWeekendMinutes(startMin, endMin, targetCount, dayRand)
      : generateWeekdayMinutes(startMin, endMin, targetCount, dayRand, personaBiasFrac);
  }

  const plan: DailyScheduleRow = {
    date: dateStr,
    plannedSlots: minuteSlots.map((m) => zonedMinuteOfDayToUtc(dateStr, m, settings.workHoursTimezone)),
    targetCount,
    isWeekend,
    generatedAt: Date.now(),
  };
  saveDailySchedule(plan);
  // saveDailySchedule is `INSERT ... ON CONFLICT DO NOTHING` — re-read
  // rather than trust `plan` as the final truth, in case a concurrent
  // caller won the race and inserted first (same "the DB is the source of
  // truth, not whatever this call happened to compute" caution as this
  // codebase's other idempotent-create functions).
  return getDailySchedule(dateStr) ?? plan;
}

/** The earliest still-unfired planned slot that's already due, or `null`
 * if either nothing's due yet or today's target has already been reached.
 * "Fired" is `firedCountToday` — the caller passes in today's actual
 * successful-connect count (safety.ts's own getSafetySnapshot/
 * getTodaySafetyState already tracks this) rather than this module
 * tracking a second, parallel cursor that could drift from it. Slots are
 * consumed in order: the Nth successful send today "uses" the Nth planned
 * slot. */
export function nextDueSlot(plan: DailyPlan, now: number, firedCountToday: number): number | null {
  if (firedCountToday >= plan.targetCount || firedCountToday >= plan.plannedSlots.length) return null;
  const slot = plan.plannedSlots[firedCountToday];
  return slot <= now ? slot : null;
}
