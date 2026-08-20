import { getSetting, setSetting, getTodaySafetyState, getWeekSafetyTotals, incrementSafetyCounter } from './db.js';

// Defaults deliberately sit well below the TZ's own cited "wall" (roughly
// 100-200 connects/week per account, unofficial/practice-derived) rather
// than up against it — margin of safety over growth speed, same reasoning
// the TZ itself calls out. All of these are read from `settings` (DB),
// never hardcoded past this fallback — see setSafetySettings() below for
// why they need to be UI-editable, not just here.
const DEFAULTS = {
  daily_connect_cap: '15',
  weekly_connect_cap: '80',
  daily_message_cap: '20',
  weekly_message_cap: '100',
  work_hours_start: '09:00',
  work_hours_end: '18:00',
  warm_up_enabled: 'true',
  warm_up_duration_days: '21',
  warm_up_start_pct: '25',
  warm_up_start_date: '',
  manual_review_enabled: 'true',
  paused: 'false',
};

export type SafetySettingKey = keyof typeof DEFAULTS;

function get(key: SafetySettingKey): string {
  return getSetting(key) ?? DEFAULTS[key];
}

export interface SafetySettings {
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

export function getSafetySettings(): SafetySettings {
  return {
    dailyConnectCap: Number(get('daily_connect_cap')),
    weeklyConnectCap: Number(get('weekly_connect_cap')),
    dailyMessageCap: Number(get('daily_message_cap')),
    weeklyMessageCap: Number(get('weekly_message_cap')),
    workHoursStart: get('work_hours_start'),
    workHoursEnd: get('work_hours_end'),
    warmUpEnabled: get('warm_up_enabled') === 'true',
    warmUpDurationDays: Number(get('warm_up_duration_days')),
    warmUpStartPct: Number(get('warm_up_start_pct')),
    warmUpStartDate: get('warm_up_start_date') || null,
    manualReviewEnabled: get('manual_review_enabled') === 'true',
    paused: get('paused') === 'true',
  };
}

/** Partial update — only keys actually present in `patch` are written, so
 * the Settings UI can save one changed field at a time without needing to
 * resend the whole form. Turning warm-up on for the first time (no
 * `warm_up_start_date` set yet) stamps today as day 0 automatically —
 * the alternative (leaving it unset until some later action notices) risks
 * silently running at 100% for a while before warm-up "starts". */
export function updateSafetySettings(patch: Partial<Record<SafetySettingKey, string | number | boolean>>): void {
  for (const [key, value] of Object.entries(patch)) {
    setSetting(key, String(value));
  }
  if (patch.warm_up_enabled === true && !get('warm_up_start_date')) {
    setSetting('warm_up_start_date', new Date().toISOString().slice(0, 10));
  }
}

export function isPaused(): boolean {
  return get('paused') === 'true';
}

export function setPaused(paused: boolean): void {
  setSetting('paused', paused ? 'true' : 'false');
}

function isWithinWorkHours(settings: SafetySettings, now = new Date()): boolean {
  const hhmm = now.toTimeString().slice(0, 5);
  return hhmm >= settings.workHoursStart && hhmm <= settings.workHoursEnd;
}

/** Returns the fraction (0-1] of the configured caps actually in effect
 * today. Ramps linearly from `warmUpStartPct` up to 100% over
 * `warmUpDurationDays`, anchored to `warmUpStartDate` — a brand-new or
 * long-idle account should start small and grow into its real limits over
 * a couple of weeks, not run at full volume from day one (TZ's own
 * warm-up reasoning). Returns 1 (no reduction) once warm-up is disabled
 * or has run its course. */
export function getWarmUpMultiplier(settings: SafetySettings, now = new Date()): number {
  if (!settings.warmUpEnabled || !settings.warmUpStartDate) return 1;
  const startPct = Math.max(0, Math.min(100, settings.warmUpStartPct)) / 100;
  const daysSinceStart = Math.floor((now.getTime() - Date.parse(`${settings.warmUpStartDate}T00:00:00Z`)) / 86_400_000);
  if (daysSinceStart >= settings.warmUpDurationDays) return 1;
  if (daysSinceStart <= 0) return startPct;
  return startPct + (1 - startPct) * (daysSinceStart / settings.warmUpDurationDays);
}

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
}

/** Shared by canSendConnect/canSendMessage below — pause and work-hours
 * apply identically to every action type, only which cap/counter gets
 * checked differs. */
function checkPauseAndWorkHours(settings: SafetySettings, now: Date): SafetyCheckResult | null {
  if (settings.paused) return { allowed: false, reason: 'Automation is paused (stop switch is on).' };
  if (!isWithinWorkHours(settings, now)) {
    return { allowed: false, reason: `Outside configured work hours (${settings.workHoursStart}–${settings.workHoursEnd}).` };
  }
  return null;
}

// Real, live-reproduced gap, found and fixed on the account owner's own
// explicit, emphatic instruction: canSendConnect()'s daily/weekly caps
// above only count SUCCESSFUL sends — a *failed* attempt (most commonly: a
// lead who turns out to already be a 1st-degree connection, so there's no
// Connect button to click at all) never counted against anything, which let
// a single tick burn through 41 real profile page-views in under 3 minutes
// against a list that was mostly already-existing connections (see
// scheduler.ts's MAX_ATTEMPTS_PER_TICK for the per-tick half of this fix).
// This is the other half: a hard DAILY ceiling on total *attempts*
// (success or fail), separate from and in addition to the success-only
// caps, so the account's real-world LinkedIn activity — page views
// LinkedIn can see regardless of whether a connect actually got sent —
// stays bounded even against a lead list that turns out to be mostly duds.
// Deliberately scaled off the *effective* (warm-up-adjusted) daily connect
// cap rather than a fixed number, so it naturally tightens during warm-up
// alongside everything else: at today's cap of 4, this allows at most 10
// attempts — exactly the ratio the account owner asked for by name.
const DAILY_ATTEMPT_CAP_MULTIPLIER = 2.5;

/** The one gate every automated (and, from Phase 1 on, every manual)
 * connect action has to pass through — see the plan's own framing: "no
 * action is executed without going through this module" (TZ's Safety/
 * Limits Engine, section 2.1). Checks pause state, work hours, the
 * attempt-count ceiling (below), and both daily/weekly *success* caps
 * (each scaled down by the current warm-up multiplier) before allowing
 * anything through. */
export function canSendConnect(now = new Date()): SafetyCheckResult {
  const settings = getSafetySettings();
  const gate = checkPauseAndWorkHours(settings, now);
  if (gate) return gate;

  const multiplier = getWarmUpMultiplier(settings, now);
  const effectiveDailyCap = Math.max(1, Math.round(settings.dailyConnectCap * multiplier));
  const effectiveWeeklyCap = Math.max(1, Math.round(settings.weeklyConnectCap * multiplier));

  const today = getTodaySafetyState();

  // Checked before the success-only caps below, deliberately: this is the
  // one that actually stops a dud-heavy list from being fully attempted in
  // one sitting, since a run of failures alone would never trip
  // `connectsSent >= effectiveDailyCap` at all.
  const dailyAttemptCap = Math.ceil(effectiveDailyCap * DAILY_ATTEMPT_CAP_MULTIPLIER);
  if (today.profileViews >= dailyAttemptCap) {
    return {
      allowed: false,
      reason: `Daily attempt limit reached (${today.profileViews}/${dailyAttemptCap} profiles checked today, regardless of outcome) — protecting the account from excessive activity even when most attempts are failing.`,
    };
  }

  if (today.connectsSent >= effectiveDailyCap) {
    return { allowed: false, reason: `Daily connect cap reached (${today.connectsSent}/${effectiveDailyCap}).` };
  }
  const week = getWeekSafetyTotals();
  if (week.connects >= effectiveWeeklyCap) {
    return { allowed: false, reason: `Weekly connect cap reached (${week.connects}/${effectiveWeeklyCap}).` };
  }
  return { allowed: true };
}

export function recordConnectSent(): void {
  incrementSafetyCounter('connects_sent');
}

/** Counts one attempt (success or failure — call this unconditionally,
 * before the outcome is known) against the daily attempt ceiling above.
 * Reuses `safety_state.profile_views`, a column that already existed in
 * the schema (straight from the TZ's own data model) but was never wired
 * up to anything until this fix — repurposed here as "connect attempts
 * today" rather than adding a new column for the same underlying need. */
export function recordConnectAttempt(): void {
  incrementSafetyCounter('profile_views');
}

/** Same gate as canSendConnect, scoped to the message caps/counters
 * instead — a campaign sending a lot of follow-up messages shouldn't be
 * able to bypass rate limiting just because it's not a connect request. */
export function canSendMessage(now = new Date()): SafetyCheckResult {
  const settings = getSafetySettings();
  const gate = checkPauseAndWorkHours(settings, now);
  if (gate) return gate;

  const multiplier = getWarmUpMultiplier(settings, now);
  const effectiveDailyCap = Math.max(1, Math.round(settings.dailyMessageCap * multiplier));
  const effectiveWeeklyCap = Math.max(1, Math.round(settings.weeklyMessageCap * multiplier));

  const today = getTodaySafetyState();
  if (today.messagesSent >= effectiveDailyCap) {
    return { allowed: false, reason: `Daily message cap reached (${today.messagesSent}/${effectiveDailyCap}).` };
  }
  const week = getWeekSafetyTotals();
  if (week.messages >= effectiveWeeklyCap) {
    return { allowed: false, reason: `Weekly message cap reached (${week.messages}/${effectiveWeeklyCap}).` };
  }
  return { allowed: true };
}

export function recordMessageSent(): void {
  incrementSafetyCounter('messages_sent');
}

/** For the Settings UI / status display — today's counts alongside the
 * *effective* (warm-up-scaled) caps they're being measured against, not
 * just the raw configured numbers, so "12/15" on screen means what it
 * looks like it means. */
export function getSafetySnapshot(now = new Date()) {
  const settings = getSafetySettings();
  const multiplier = getWarmUpMultiplier(settings, now);
  const today = getTodaySafetyState();
  const week = getWeekSafetyTotals();
  return {
    settings,
    warmUpMultiplier: multiplier,
    effectiveDailyCap: Math.max(1, Math.round(settings.dailyConnectCap * multiplier)),
    effectiveWeeklyCap: Math.max(1, Math.round(settings.weeklyConnectCap * multiplier)),
    effectiveDailyMessageCap: Math.max(1, Math.round(settings.dailyMessageCap * multiplier)),
    effectiveWeeklyMessageCap: Math.max(1, Math.round(settings.weeklyMessageCap * multiplier)),
    connectsToday: today.connectsSent,
    connectsThisWeek: week.connects,
    messagesToday: today.messagesSent,
    messagesThisWeek: week.messages,
    // Total connect *attempts* today (success or fail) vs. the ceiling
    // that actually stops a dud-heavy list from being fully worked through
    // in one sitting — see canSendConnect()'s own doc comment above.
    attemptsToday: today.profileViews,
    dailyAttemptCap: Math.ceil(Math.max(1, Math.round(settings.dailyConnectCap * multiplier)) * DAILY_ATTEMPT_CAP_MULTIPLIER),
    withinWorkHours: isWithinWorkHours(settings, now),
  };
}
