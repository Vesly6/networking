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
  warmUpEnabled: boolean;
  warmUpDurationDays: number;
  warmUpStartPct: number;
  warmUpStartDate: string | null;
  manualReviewEnabled: boolean;
  paused: boolean;
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
  pendingApproval: number;
  errors: number;
  circuitBreakerTripped: boolean;
  skippedConcurrent?: boolean;
}

/** LinkedInView.tsx's "▶ Vykdyti dabar" button — this used to also run on
 * its own background setInterval every 5 minutes regardless of any user
 * action; removed on explicit request (see server/src/index.ts's own doc
 * comment on why), so this manual trigger is now the only way a due
 * sequence step ever actually gets processed — with manual review on (the
 * default), that just means refreshing what's in the Pending Approval
 * queue; with it off, this is what actually sends. */
export function runLinkedInScheduler(): Promise<SchedulerRunResult> {
  return localApiRequest('/api/linkedin/scheduler/run', { method: 'POST' });
}
