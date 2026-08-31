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
  // A real, live-found gap this session: work hours used to be compared
  // against the server process's own local clock (effectively UTC on
  // Render) — "09:00–18:00" meant nothing to do with the account owner's
  // actual day. Any valid IANA zone name works since this is only ever
  // fed to Intl.DateTimeFormat (see getZonedDateParts below), never
  // parsed by hand.
  work_hours_timezone: 'Europe/Vilnius',
  warm_up_enabled: 'true',
  warm_up_duration_days: '21',
  warm_up_start_pct: '25',
  warm_up_start_date: '',
  paused: 'false',
  // How far below the effective daily cap a given day's real target can
  // randomly land (dailyPlan.ts), as a PERCENTAGE of that day's own
  // effective cap rather than a flat count — a flat absolute number (this
  // setting's earlier form) barely mattered against a mature cap of 15 but
  // could swallow a warm-up-era cap of 5 whole, leaving little real
  // day-to-day variation exactly when a fixed daily count is most
  // detectable (this session's own research: LinkedIn's enforcement reads
  // as pattern/rhythm-based, and a perfectly consistent count — even a
  // "safe," gradually-ramped one — is itself a flagged signal). Default
  // 25% → cap 15 mostly lands in ~{12..15}, cap 5 (early warm-up) in
  // ~{4..5} — proportionally similar variation at either end.
  daily_target_jitter_pct: '25',
  // Probability (0-100) that a given connect send pauses to look at one
  // of the profile's own recent posts before proceeding — see page.ts's
  // browseProfileBeforeConnect(). Deliberately not 100: most sends stay
  // on the simpler, longer-verified path.
  browse_activity_probability: '35',
  // Probability (0-100) that a send navigates via LinkedIn's own
  // search-by-name instead of a direct profile URL — deliberately LOW by
  // default. LinkedIn's people search is a limited/commercial-use-gated
  // feature on non-premium accounts; using it on every send would burn
  // through the account's real, human search quota too, not just this
  // feature's own budget for it.
  search_navigation_probability: '18',
  // Hard daily ceiling on how many of those searches actually happen,
  // independent of the probability above — checked first, and once
  // reached for the day every remaining send just falls back to direct-
  // URL navigation rather than blocking the connect itself. LinkedIn
  // doesn't publish an exact quota and it varies by account, so this is
  // deliberately small/conservative and user-tunable, not a guessed
  // hardcoded number.
  daily_search_cap: '4',
  // Set by recordSearchLockout() (page.ts's searchByNameAndNavigate) the
  // moment LinkedIn's own search looks genuinely exhausted — live-
  // confirmed this session against a real account already at LinkedIn's
  // monthly commercial-use search cap. Epoch ms, empty string = not
  // currently locked out. Checked by shouldUseSearchNavigation() before
  // the probability roll, so a locked-out account never wastes another
  // attempt against a wall it already hit.
  search_blocked_until: '',
  // How long a lockout lasts once triggered — the account owner's own
  // suggested cooldown ("не повторять поиск неделю"), kept configurable
  // rather than hardcoded since LinkedIn's own monthly reset cadence
  // isn't published and may not line up with exactly 7 days.
  search_lockout_days: '7',
  // Consecutive zero-result search-by-name attempts, reset to 0 the
  // moment any attempt finds real candidates (matched or not) — see
  // recordSearchMiss()/recordSearchHit() below. The robust fallback
  // lockout trigger for when LinkedIn's exact "monthly limit" wording
  // isn't the page actually showing (this function only reads the
  // lightweight typeahead dropdown, not the full results page).
  search_misses_in_a_row: '0',
  // humanize.ts's account-level "texture" activity, independent of
  // whether any connect is actually due — on explicit request: likes
  // only, never comments (a materially bigger surface — real generated
  // text under this account's name — with no prior art anywhere in this
  // codebase). Probability is the per-opportunity chance of liking
  // anything at all once `likes_min_gap_minutes` has elapsed since the
  // last run — deliberately well under 100%, since a real person doesn't
  // react to something every single time they open the app either.
  likes_probability: '40',
  // Minimum real time between humanize passes — without this, a 5-minute
  // scheduler tick would otherwise re-roll the probability above every 5
  // minutes, which reads as far more feed activity than a real person
  // idly checking in produces. Deliberately a wide, human-plausible gap
  // rather than tied to the connect-scheduling cadence.
  likes_min_gap_minutes: '90',
  // Opt-in, OFF by default — dailyPlan.ts's procedural generator (seeded
  // jitter/clustering) is what actually guarantees every slot lands
  // inside work hours and is what ships enabled; this lets an LLM
  // (openai.ts's suggestDailyScheduleMinutes) propose today's slot times
  // instead, as an explicit live experiment to compare against the
  // procedural baseline — never a replacement for its safety guarantee,
  // since dailyPlan.ts re-validates every proposed slot against work
  // hours regardless of this setting and discards the whole AI response
  // in favor of the procedural one if it doesn't hold up.
  ai_schedule_enabled: 'false',
  // Opt-in, OFF by default — with manual review removed entirely (every
  // due action fires on its own, nothing waits for a human to read it
  // first — see scheduler.ts's runSchedulerTick), AI personalization
  // folds directly into executeAction() as an automatic pre-send step
  // when this is on. Off means the existing plain
  // {{firstName}}/{{title}}/{{company}} placeholder substitution keeps
  // happening exactly as before — this setting only controls whether an
  // *additional* AI rewrite happens on top of that baseline.
  auto_personalize_enabled: 'false',
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
  searchBlockedUntil: number | null;
  searchLockoutDays: number;
  likesProbability: number;
  likesMinGapMinutes: number;
  aiScheduleEnabled: boolean;
  autoPersonalizeEnabled: boolean;
}

export function getSafetySettings(): SafetySettings {
  return {
    dailyConnectCap: Number(get('daily_connect_cap')),
    weeklyConnectCap: Number(get('weekly_connect_cap')),
    dailyMessageCap: Number(get('daily_message_cap')),
    weeklyMessageCap: Number(get('weekly_message_cap')),
    workHoursStart: get('work_hours_start'),
    workHoursEnd: get('work_hours_end'),
    workHoursTimezone: get('work_hours_timezone'),
    warmUpEnabled: get('warm_up_enabled') === 'true',
    warmUpDurationDays: Number(get('warm_up_duration_days')),
    warmUpStartPct: Number(get('warm_up_start_pct')),
    warmUpStartDate: get('warm_up_start_date') || null,
    paused: get('paused') === 'true',
    dailyTargetJitterPct: Number(get('daily_target_jitter_pct')),
    browseActivityProbability: Number(get('browse_activity_probability')),
    searchNavigationProbability: Number(get('search_navigation_probability')),
    dailySearchCap: Number(get('daily_search_cap')),
    searchBlockedUntil: get('search_blocked_until') ? Number(get('search_blocked_until')) : null,
    searchLockoutDays: Number(get('search_lockout_days')),
    likesProbability: Number(get('likes_probability')),
    likesMinGapMinutes: Number(get('likes_min_gap_minutes')),
    aiScheduleEnabled: get('ai_schedule_enabled') === 'true',
    autoPersonalizeEnabled: get('auto_personalize_enabled') === 'true',
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

export interface ZonedDateParts {
  /** yyyy-MM-dd, the calendar date *in `timeZone`* — not UTC, not the
   * server's own local date. */
  dateStr: string;
  /** 'Monday'..'Sunday', in `timeZone`. */
  weekday: string;
  /** HH:MM (24h), in `timeZone`. */
  hhmm: string;
}

// Computes wall-clock date/weekday/time in an arbitrary IANA zone using
// the native Intl API — Node ships full ICU, so this needs no dependency
// (date-fns-tz/luxon/etc.), unlike every other date helper already in
// this codebase (callStats.ts's toUtcDate/addDays, analytics.ts's
// dayKeyUtc), which are UTC-anchored, not zone-parameterized — there was
// nothing to reuse here, this is genuinely new. Shared by
// isWithinWorkHours below and dailyPlan.ts's weekday/day-boundary logic,
// so both agree on exactly the same notion of "what day/time is it for
// this account" rather than each re-deriving it slightly differently.
export function getZonedDateParts(timeZone: string, now = new Date()): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const get2 = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // hour12:false can still render midnight as "24" in some ICU builds —
  // normalize to "00" so string comparison against "HH:MM" bounds behaves.
  const hour = get2('hour') === '24' ? '00' : get2('hour');
  return {
    dateStr: `${get2('year')}-${get2('month')}-${get2('day')}`,
    weekday: get2('weekday'),
    hhmm: `${hour}:${get2('minute')}`,
  };
}

export function isWithinWorkHours(settings: SafetySettings, now = new Date()): boolean {
  const { hhmm } = getZonedDateParts(settings.workHoursTimezone, now);
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

/** Whether *this* send should navigate via LinkedIn's own search-by-name
 * instead of a direct profile URL — called once per send, before
 * deciding how to navigate (page.ts). Checks the hard daily cap first
 * (independent of and before the probability roll), so a low
 * `dailySearchCap` genuinely bounds real search usage regardless of how
 * the probability happens to roll; once reached for the day this always
 * returns false and every remaining send that day just uses a direct URL
 * instead, never blocking the connect itself over a search-quota
 * concern. */
export function shouldUseSearchNavigation(settings: SafetySettings): boolean {
  // Checked before the daily cap/probability — a live lockout means "not
  // right now, regardless of how the day's numbers look," see
  // recordSearchLockout()'s own doc comment for what sets this.
  if (settings.searchBlockedUntil !== null && Date.now() < settings.searchBlockedUntil) return false;
  const today = getTodaySafetyState();
  if (today.searchesUsed >= Math.max(0, settings.dailySearchCap)) return false;
  return Math.random() * 100 < settings.searchNavigationProbability;
}

export function recordSearchUsed(): void {
  incrementSafetyCounter('searches_used');
}

/** A search-by-name attempt that found zero real person-shaped results at
 * all (not just "this specific lead wasn't among them") — see
 * page.ts's searchByNameAndNavigate() for the call site. Returns the new
 * consecutive-miss count so the caller can decide whether it's crossed
 * the lockout threshold without a second read. */
export function recordSearchMiss(): number {
  const next = Number(get('search_misses_in_a_row')) + 1;
  setSetting('search_misses_in_a_row', String(next));
  return next;
}

/** A search-by-name attempt that found real candidates — resets the
 * consecutive-miss streak, since whatever degraded the search (if
 * anything) is evidently not happening right now. */
export function recordSearchHit(): void {
  setSetting('search_misses_in_a_row', '0');
}

/** Sets search_blocked_until `search_lockout_days` days out from now and
 * resets the miss streak (a fresh streak should start counting only once
 * the lockout itself has lifted, not still be primed from the run that
 * just triggered it). Called from page.ts's searchByNameAndNavigate() the
 * moment either lockout signal fires — see that function's own doc
 * comment for what those are. Logged to the console (not just written
 * silently) since this is exactly the kind of state change that's easy to
 * miss without watching the UI — the next scheduler tick's own log line
 * will otherwise just look like an ordinary "used direct URL" send with
 * no visible cause. */
export function recordSearchLockout(reason: string): void {
  const days = Math.max(1, Number(get('search_lockout_days')));
  const until = Date.now() + days * 86_400_000;
  setSetting('search_blocked_until', String(until));
  setSetting('search_misses_in_a_row', '0');
  console.log(`[linkedin/safety] Search-by-name locked out until ${new Date(until).toISOString()} — ${reason}`);
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
