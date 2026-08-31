import { localApiRequest } from './localApi';

export type LinkedInSessionStatus = 'connected' | 'not_connected' | 'logged_out' | 'checkpoint';

export interface LinkedInStatus {
  status: LinkedInSessionStatus;
  message: string;
}

/** Whether Chrome is reachable over CDP and a LinkedIn session is live —
 * see server/src/linkedin/page.ts's getLinkedInStatus() for what each
 * status value means. */
export function fetchLinkedInStatus(): Promise<LinkedInStatus> {
  return localApiRequest('/api/linkedin/status');
}

export interface LinkedInActionLogEntry {
  id: string;
  leadId: string | null;
  stepId: string | null;
  actionType: string;
  status: 'success' | 'error';
  targetUrl: string | null;
  detail: string | null;
  executedAt: number;
  responseTimeMs: number | null;
  /** JSON-serialized ConnectTiming (server/src/linkedin/page.ts) for a
   * 'connect' action — parse with parseConnectTiming() below. Null for
   * every other action type, and for rows logged before this existed. */
  timingJson: string | null;
}

/** A 'connect' action's per-phase timing breakdown — mirrors
 * server/src/linkedin/page.ts's ConnectTiming exactly (kept as a plain
 * parallel type rather than a shared import, since the server and app
 * packages don't share a types module). Returns null on anything that
 * isn't valid JSON or doesn't look like this shape, so a malformed/legacy
 * row just renders as "no breakdown available" rather than crashing the
 * log panel. */
export interface LinkedInConnectTiming {
  startedAt: number;
  navigatedViaSearch: boolean;
  navigatedAt: number;
  loginConfirmedAt: number;
  visitedRecentActivity: boolean;
  recentActivityDwellMs: number | null;
  connectClickedAt: number;
  noteAdded: boolean;
  sentAt: number;
  totalMs: number;
}

export function parseConnectTiming(timingJson: string | null): LinkedInConnectTiming | null {
  if (!timingJson) return null;
  try {
    const parsed = JSON.parse(timingJson);
    if (parsed && typeof parsed === 'object' && typeof parsed.startedAt === 'number' && typeof parsed.sentAt === 'number') {
      return parsed as LinkedInConnectTiming;
    }
    return null;
  } catch {
    return null;
  }
}

export function fetchLinkedInActions(limit = 20): Promise<{ actions: LinkedInActionLogEntry[] }> {
  return localApiRequest(`/api/linkedin/actions?limit=${limit}`);
}

/** Sends one real connection request — a real, unrecoverable side effect
 * against an actual person's LinkedIn account the instant it succeeds,
 * same category as requestCallback/sendSms elsewhere in this app. Only
 * ever call this from an explicit, already-confirmed user action. The
 * server also runs this through the Safety Engine first (caps/work-hours/
 * warm-up/pause) — a 429 here means the Safety Engine blocked it, not a
 * real failure. */
export function sendTestConnectionRequest(profileUrl: string, note?: string): Promise<{ ok: true }> {
  return localApiRequest('/api/linkedin/test-connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileUrl, note }),
  });
}

export interface LinkedInSafetySettings {
  dailyConnectCap: number;
  weeklyConnectCap: number;
  dailyMessageCap: number;
  weeklyMessageCap: number;
  workHoursStart: string;
  workHoursEnd: string;
  workHoursTimezone: string;
  warmUpEnabled: boolean;
  warmUpDurationDays: number;
  warmUpStartPct: number;
  warmUpStartDate: string | null;
  paused: boolean;
  dailyTargetJitterPct: number;
  browseActivityProbability: number;
  searchNavigationProbability: number;
  dailySearchCap: number;
  /** Epoch ms, or null when not currently locked out — set once LinkedIn's
   * own search looks genuinely exhausted (the exact "monthly limit" text,
   * or two consecutive zero-result searches). See safety.ts's
   * recordSearchLockout(). */
  searchBlockedUntil: number | null;
  searchLockoutDays: number;
  likesProbability: number;
  likesMinGapMinutes: number;
  aiScheduleEnabled: boolean;
  autoPersonalizeEnabled: boolean;
}

// Message caps/counters were missing here even though the server has
// always tracked and enforced them (safety.ts's canSendMessage) — a real,
// found-on-review gap: this type just didn't carry the fields the server
// already sends, so nothing in the UI could show or edit them, and the
// message caps were permanently stuck at their DEFAULTS with no way to
// change them short of editing the SQLite settings table by hand.
export interface LinkedInSafetySnapshot {
  settings: LinkedInSafetySettings;
  warmUpMultiplier: number;
  effectiveDailyCap: number;
  effectiveWeeklyCap: number;
  effectiveDailyMessageCap: number;
  effectiveWeeklyMessageCap: number;
  connectsToday: number;
  connectsThisWeek: number;
  messagesToday: number;
  messagesThisWeek: number;
  /** Total connect *attempts* today (success or fail) vs. the ceiling that
   * actually stops a dud-heavy lead list (mostly-already-connected people)
   * from being fully worked through in one sitting — a real, live-
   * reproduced gap where the success-only caps above let 41 failed
   * attempts fire in one automatic tick, since none of them counted
   * against connectsToday. See server/src/linkedin/safety.ts's
   * canSendConnect() for the enforcement side of this. */
  attemptsToday: number;
  dailyAttemptCap: number;
  withinWorkHours: boolean;
}

export function fetchLinkedInSafety(): Promise<LinkedInSafetySnapshot> {
  return localApiRequest('/api/linkedin/safety');
}

/** Partial update — only the keys actually included are changed server-
 * side (see server/src/linkedin/safety.ts's updateSafetySettings). Keys
 * match the DB's snake_case setting names, not the camelCase response
 * shape above — e.g. `daily_connect_cap`, `warm_up_enabled`. */
export function updateLinkedInSafetySettings(
  patch: Record<string, string | number | boolean>,
): Promise<LinkedInSafetySnapshot> {
  return localApiRequest('/api/linkedin/safety/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/** The always-visible "⏸ Stop everything" control's backend call — once
 * paused, the Safety Engine blocks every connect attempt (manual test
 * sends included) until explicitly resumed. */
export function setLinkedInPaused(paused: boolean): Promise<LinkedInSafetySnapshot> {
  return localApiRequest('/api/linkedin/pause', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused }),
  });
}

export interface SchedulerRunResult {
  due: number;
  autoExecuted: number;
  errors: number;
  circuitBreakerTripped: boolean;
  skippedConcurrent?: boolean;
  waitingForNextSlot?: boolean;
  noTabOpen?: boolean;
}

/** LinkedInView.tsx's "▶ Vykdyti dabar" button — a manual, human-supervised
 * "run right now" burst (server/src/linkedin/scheduler.ts's
 * MAX_ATTEMPTS_PER_TICK). The real, unattended path is the server's own
 * background 5-minute interval; manual review was removed entirely, so
 * there is no approval queue anymore — a due action just executes,
 * gated only by the Safety Engine. */
export function runLinkedInScheduler(): Promise<SchedulerRunResult> {
  return localApiRequest('/api/linkedin/scheduler/run', { method: 'POST' });
}

export interface LinkedInTodaysPlan {
  date: string;
  targetCount: number;
  plannedSlots: number[];
  firedCount: number;
  nextSlotDueNowAt: number | null;
}

/** The Apžvalga dashboard section's "today's plan progress" glance — see
 * server/src/linkedin/dailyPlan.ts for what a plan actually is (a
 * human-paced set of minute-of-day slots for today, generated once and
 * reused for the rest of the day). */
export function fetchTodaysLinkedInPlan(): Promise<LinkedInTodaysPlan> {
  return localApiRequest('/api/linkedin/plan/today');
}
