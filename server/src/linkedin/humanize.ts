import { getSetting, setSetting, logAction } from './db.js';
import { getSafetySettings, isPaused, isWithinWorkHours } from './safety.js';
import { likeRecentFeedPosts } from './page.js';

// Account-level activity texture, independent of whether any connect is
// actually due — the research done for the timing/scheduling rework this
// session found a specific, named LinkedIn-detection heuristic: an account
// that only ever sends connection requests and never likes/comments/posts
// is itself a flagged pattern, regardless of how well-paced the connects
// are. This module is the fix for that — on explicit request, likes only,
// never comments (real generated text under this account's name is a
// materially bigger, unverified surface than a single reversible click,
// and this codebase has no prior art for posting comment text anywhere).
//
// Deliberately called from the scheduler tick (see scheduler.ts) rather
// than bundled into sendConnectionRequest() itself — this is meant to read
// as "the account owner occasionally checks their own feed," not as
// something tied to any specific connect send.

const LAST_RUN_SETTING_KEY = 'humanize_last_run_at';

function getLastRunAt(): number | null {
  const raw = getSetting(LAST_RUN_SETTING_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function recordRunNow(now: number): void {
  setSetting(LAST_RUN_SETTING_KEY, String(now));
}

export interface HumanizeResult {
  ran: boolean;
  liked: number;
  skippedReason?: 'paused' | 'outsideWorkHours' | 'tooSoon' | 'probabilityMiss';
}

/** Called once per scheduler tick (automatic ticks only — see scheduler.ts;
 * a manual "run now" click has no business also triggering unrelated feed
 * activity). Most calls do nothing at all — that's by design, not a bug:
 * `likesMinGapMinutes` bounds *how often* this can even attempt anything,
 * and `likesProbability` then decides whether this particular opportunity
 * actually likes something, so a meaningful share of eligible opportunities
 * still do zero likes, matching how a real person doesn't react to
 * something every single time they open the app. */
export async function maybeRunHumanizePass(now = Date.now()): Promise<HumanizeResult> {
  const settings = getSafetySettings();

  if (isPaused()) return { ran: false, liked: 0, skippedReason: 'paused' };
  if (!isWithinWorkHours(settings, new Date(now))) {
    return { ran: false, liked: 0, skippedReason: 'outsideWorkHours' };
  }

  const lastRunAt = getLastRunAt();
  const minGapMs = Math.max(0, settings.likesMinGapMinutes) * 60_000;
  if (lastRunAt !== null && now - lastRunAt < minGapMs) {
    return { ran: false, liked: 0, skippedReason: 'tooSoon' };
  }

  // The gap has elapsed — this opportunity "counts" regardless of the
  // probability roll below, so the next eligible check is again
  // `likesMinGapMinutes` out from now, not from whenever the probability
  // next happens to hit. Recorded before the roll so a crash/error further
  // down can't leave this stuck re-attempting every single tick.
  recordRunNow(now);

  if (Math.random() * 100 >= settings.likesProbability) {
    return { ran: false, liked: 0, skippedReason: 'probabilityMiss' };
  }

  // 1 or 2 likes, per the account owner's own framing ("1 лайк или 2 лайка
  // на последние посты") — not a wider configurable range, since the
  // point is this stays a small, occasional gesture, not a scored/tunable
  // engagement campaign.
  const maxLikes = Math.random() < 0.5 ? 1 : 2;
  const startedAt = Date.now();
  try {
    const liked = await likeRecentFeedPosts(maxLikes);
    logAction({
      leadId: null,
      stepId: null,
      actionType: 'like',
      status: 'success',
      targetUrl: null,
      detail: `Liked ${liked} feed post(s).`,
      executedAt: startedAt,
      responseTimeMs: Date.now() - startedAt,
    });
    return { ran: true, liked };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to like feed posts';
    logAction({
      leadId: null,
      stepId: null,
      actionType: 'like',
      status: 'error',
      targetUrl: null,
      detail: message,
      executedAt: startedAt,
      responseTimeMs: Date.now() - startedAt,
    });
    return { ran: false, liked: 0 };
  }
}
