import type { Page } from 'playwright';
import { getLinkedInPage, humanDelay, humanMouseMove, humanType } from './browser.js';
import { getSafetySettings, shouldUseSearchNavigation, recordSearchUsed, recordSearchMiss, recordSearchHit, recordSearchLockout } from './safety.js';

// The only file in this feature allowed to know LinkedIn's actual DOM/URL
// structure — every action above this layer goes through a named function
// here instead of touching a selector directly. This is deliberate: when
// LinkedIn changes its markup (which it will, repeatedly, over this
// feature's lifetime), the fix is contained to this one file instead of
// being an archaeology dig through Campaign/Safety Engine logic that has
// no business knowing what a "Connect" button looks like.

const CHECKPOINT_URL_PATTERN = /linkedin\.com\/(checkpoint|authwall|uas\/login)/i;

export function isCheckpointUrl(url: string): boolean {
  return CHECKPOINT_URL_PATTERN.test(url);
}

/** A logged-in session always has a link to /messaging/ somewhere on the
 * page (the persistent top nav's Messaging item); a logged-out session
 * instead lands on a public marketing/login page with no such link at all.
 * Only checks for presence — this needs a yes/no, not to read or store who
 * is logged in.
 *
 * Confirmed live and rewritten TWICE during this session's own
 * verification pass — both times by literally attaching to a real, logged-
 * in session and inspecting the actual DOM, not by guessing:
 *
 * 1. The original selector (`#global-nav`, `[data-control-name=
 *    "identity_welcome_message"]`) reported a genuinely logged-in feed page
 *    as logged out — LinkedIn has dropped the `#global-nav` id entirely and
 *    now generates hashed, build-specific CSS class names throughout its
 *    nav (e.g. `_3bdeafd6`), so anything keyed to a class name is
 *    guaranteed to break on the next LinkedIn deploy.
 * 2. The immediate fix after that — `#primaryNavLinksComponentRef
 *    a[href*="/messaging/"]` — worked on the feed page but turned out to
 *    ALSO report false on the /messaging/ route itself: that route doesn't
 *    render nav inside `#primaryNavLinksComponentRef` at all, it's a
 *    differently-wrapped sub-layout. That's not a corner case here — it's
 *    the exact route listConversationThreads()/scrapeThreadMessages() (the
 *    Inbox sync) call this on every single sync, so the scoped version
 *    would have silently broken Inbox sync permanently while still working
 *    fine everywhere else this function is called from, which is a
 *    particularly nasty way for a regression to hide.
 *
 * The fix both times pointed the same direction: stop trying to scope to
 * *any* specific nav container element (every one of them has turned out to
 * be route-specific or unstable) and just check for the `/messaging/` href
 * anywhere on the page. A stray, unrelated `/messaging/` link appearing on
 * a genuinely logged-out marketing/login page is not a realistic false
 * positive — that path only exists in the logged-in product surface. If
 * this breaks a third time, the fix is the same process again: attach to a
 * real session and check what's actually on the specific page in question,
 * not just the feed. */
export async function isLoggedIn(page: Page): Promise<boolean> {
  if (isCheckpointUrl(page.url())) return false;
  const messagingLink = await page.locator('a[href*="/messaging/"]').count();
  return messagingLink > 0;
}

export type LinkedInSessionStatus = 'connected' | 'not_connected' | 'logged_out' | 'checkpoint';

export interface LinkedInStatus {
  status: LinkedInSessionStatus;
  message: string;
}

/** The three non-"connected" states here are exactly what the Safety
 * Engine's circuit breaker (Phase 1) will lean on: a checkpoint or a
 * logged-out session is just as good a reason to halt every automated
 * action as an outright CAPTCHA is — not only CAPTCHA specifically, which
 * is where the raw TZ's circuit-breaker description stopped short. */
export async function getLinkedInStatus(): Promise<LinkedInStatus> {
  let page: Page;
  try {
    page = await getLinkedInPage();
  } catch (err) {
    return { status: 'not_connected', message: err instanceof Error ? err.message : 'Could not connect to Chrome.' };
  }
  if (isCheckpointUrl(page.url())) {
    return {
      status: 'checkpoint',
      message: 'LinkedIn is showing a verification/checkpoint page — resolve it manually in Chrome first.',
    };
  }
  const loggedIn = await isLoggedIn(page);
  if (!loggedIn) {
    return { status: 'logged_out', message: 'Not logged into LinkedIn in this Chrome profile — log in manually first.' };
  }
  return { status: 'connected', message: 'Connected — LinkedIn session is live.' };
}

export class LinkedInPageError extends Error {}

/** Thrown by sendConnectionRequest() when the "···" More menu shows "Remove
 * Connection" instead of "Connect" — a confirmed, terminal "already
 * connected" outcome, exported so scheduler.ts's isNoConnectButtonError()
 * can treat it the same way as the generic no-button case (skip re-offering
 * the step, never mutate lead.status — see that function's own doc comment
 * for why). */
export const ALREADY_CONNECTED_ERROR = 'Already connected — LinkedIn shows "Remove Connection" for this profile.';

/** Types `name` into LinkedIn's own global search box (the same one a real
 * person uses, top-left of every page) and, if the typeahead dropdown that
 * appears within a couple seconds contains a result whose profile link
 * resolves to exactly `profileUrl`'s path, clicks into it — returning
 * `true` only once the page has actually landed on that path. Returns
 * `false` (never throws) on anything short of that: no search box found,
 * no matching result, or the click didn't land where expected — the
 * caller (sendConnectionRequest) always has a direct page.goto() fallback,
 * so a failed search attempt should degrade gracefully, not abort the
 * whole send.
 *
 * Live-verified against a real search (typing "Vladimir Koptev" into this
 * exact box) before this was written: the typeahead dropdown itself
 * already renders direct `<a href="/in/...">` result links within ~2s —
 * no need to submit the search and land on a separate /search/results/
 * page first, which would be slower and is one more page load LinkedIn
 * can see. Matching is by exact resolved-pathname equality against the
 * lead's own already-trusted stored URL (same loop-and-compare-in-JS
 * shape withdrawConnectionRequest() uses below, for the same
 * no-string-interpolated-selector reason) rather than fuzzy name
 * matching — safer than the profile-page name-matching heuristics
 * elsewhere in this file, since path equality against a known-good URL
 * can't land on a same-named-but-different person the way "does this
 * aria-label contain this name" could. */
/** LinkedIn's own commercial-use-limit page carries this exact phrasing
 * ("You've reached the monthly limit for profile searches. Upgrade to
 * Premium Business...") — live-confirmed this session by typing a real
 * name into this exact search box on an account already at its monthly
 * cap. Matched case-insensitively and loosely (two independent substrings
 * rather than the exact sentence) so a minor wording tweak on LinkedIn's
 * side doesn't silently stop this from firing. */
function isSearchLockedPageText(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('monthly limit') || lower.includes('unlimited search');
}

/** Types `name` into LinkedIn's own global search box and clicks through
 * to the matching profile if found — see this function's own history in
 * this file for the full reasoning. This session also live-confirmed the
 * failure mode: once an account is at LinkedIn's own monthly
 * commercial-use search cap, the typeahead dropdown returns *zero* real
 * person results at all (just the account's own profile/stats clutter),
 * and the full search-results page (only reached by pressing Enter, which
 * this function deliberately doesn't do — see the dropdown-only reasoning
 * below) shows the exact lockout text above. Since this function only
 * ever reads the lightweight dropdown, it can't always see that exact
 * text — so lockout detection combines both signals: the exact phrase
 * *when it happens to be visible*, and a consecutive-zero-candidates
 * counter (safety.ts's recordSearchMiss/recordSearchHit) as the robust
 * fallback that doesn't depend on LinkedIn's exact wording or which page
 * happens to be showing it. See recordSearchLockout()'s own doc comment
 * for what happens once either trips. */
async function searchByNameAndNavigate(page: Page, name: string, profileUrl: string): Promise<boolean> {
  const targetPath = new URL(profileUrl).pathname.replace(/\/+$/, '');
  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
    await humanDelay(1000, 2200);

    const searchBox = page.locator('input[placeholder="Search" i]').first();
    if ((await searchBox.count()) === 0) return false;

    await searchBox.click();
    await humanDelay(300, 700);
    await humanType(page, 'input[placeholder="Search" i]', name);
    await humanDelay(1300, 2600);

    const candidates = await page.locator('a[href*="/in/"]').all();

    if (candidates.length === 0) {
      // Zero real person-shaped results at all — never happens for a
      // genuinely working search against a real name (LinkedIn's own
      // typeahead is generous), so this is the search-is-degraded signal,
      // independent of whether this specific lead would have matched.
      // Cast through globalThis rather than referencing `document` directly —
      // this file's tsconfig has no `dom` lib (Node-only backend code), same
      // as browser.ts's navigator.webdriver patch; this callback's body only
      // ever actually runs in the browser, injected by Playwright.
      const bodyText = await page
        .evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText)
        .catch(() => '');
      if (isSearchLockedPageText(bodyText)) {
        recordSearchLockout('LinkedIn showed its own monthly search-limit message.');
      } else if (recordSearchMiss() >= 2) {
        recordSearchLockout('Two consecutive searches returned zero results — likely at the monthly cap even without seeing the exact message.');
      }
      return false;
    }
    recordSearchHit();

    let match: (typeof candidates)[number] | null = null;
    for (const candidate of candidates) {
      const href = await candidate.getAttribute('href').catch(() => null);
      if (!href) continue;
      const path = new URL(href, 'https://www.linkedin.com').pathname.replace(/\/+$/, '');
      if (path === targetPath) {
        match = candidate;
        break;
      }
    }
    if (!match) return false;

    await humanDelay(300, 800);
    await match.evaluate((el) => (el as { click: () => void }).click());
    await humanDelay(1500, 3000);

    const landedPath = new URL(page.url()).pathname.replace(/\/+$/, '');
    return landedPath === targetPath;
  } catch {
    return false;
  }
}

/** Human-realistic dwelling on a profile before Connect is ever searched
 * for — always scrolls a little (a real visitor never lands motionless),
 * and with `browseActivityProbability`% chance also visits the profile's
 * own recent-activity page and spends real time there before coming back,
 * rather than clicking Connect the instant the page loads. Deliberately
 * does NOT click into any individual post permalink — live DOM inspection
 * this session found `recent-activity/all/` already renders full post
 * previews directly (the same page listing used to source the Like button
 * for humanize.ts), so "spend time looking at this person's posts" is
 * fully satisfied by dwelling there, without adding a second, unverified
 * click target (a specific post's own permalink) on top of the "Show all"
 * link click below — this codebase has already hit the wrong-target class
 * of bug twice this session from exactly this kind of extra click.
 *
 * The "Show all" activity link's `href` (not its visible text) is what's
 * matched — live-confirmed on a real profile that TWO different "Show
 * all" links can be visible at once with identical text (one for
 * activity, one for an unrelated "People you may also know"-style
 * recommendations module) but different hrefs, so text-only matching
 * would be ambiguous by design, not just in theory. */
/** How long browseProfileBeforeConnect() actually spent dwelling on the
 * lead's recent-activity page, if it visited one at all — feeds
 * ConnectTiming below. `visitedRecentActivity: false` covers both "the
 * probability roll skipped it" and "no activity link existed to click." */
interface BrowseResult {
  visitedRecentActivity: boolean;
  recentActivityDwellMs: number | null;
}

async function browseProfileBeforeConnect(page: Page, profileUrl: string): Promise<BrowseResult> {
  await page.mouse.wheel(0, 400 + Math.random() * 500);
  await humanDelay(600, 1500);

  const settings = getSafetySettings();
  if (Math.random() * 100 >= settings.browseActivityProbability) {
    await humanDelay(15_000, 60_000);
    return { visitedRecentActivity: false, recentActivityDwellMs: null };
  }

  const activityLink = page.locator('a[href*="/recent-activity/"]').first();
  if ((await activityLink.count()) === 0) {
    await humanDelay(15_000, 60_000);
    return { visitedRecentActivity: false, recentActivityDwellMs: null };
  }

  const dwellStartedAt = Date.now();
  try {
    const box = await activityLink.boundingBox();
    if (box) {
      await humanMouseMove(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    }
    await humanDelay(300, 800);
    await activityLink.evaluate((el) => (el as { click: () => void }).click());
    await humanDelay(1500, 3000);
    await humanDelay(30_000, 180_000);
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await humanDelay(800, 2000);
    // goBack() can land somewhere unexpected (LinkedIn's own client-side
    // routing doesn't always treat this as a plain history entry) — if it
    // didn't actually return to the profile, re-navigate directly rather
    // than let sendConnectionRequest's own Connect-finding logic run
    // against the wrong page.
    const path = new URL(page.url()).pathname.replace(/\/+$/, '');
    const targetPath = new URL(profileUrl).pathname.replace(/\/+$/, '');
    if (path !== targetPath) {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
      await humanDelay(800, 1800);
    }
    return { visitedRecentActivity: true, recentActivityDwellMs: Date.now() - dwellStartedAt };
  } catch {
    // Best-effort — a failure here just means less realistic dwelling,
    // never a reason to abort the actual connect attempt below.
    const path = new URL(page.url()).pathname.replace(/\/+$/, '');
    const targetPath = new URL(profileUrl).pathname.replace(/\/+$/, '');
    if (path !== targetPath) {
      await page.goto(profileUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    return { visitedRecentActivity: true, recentActivityDwellMs: Date.now() - dwellStartedAt };
  }
}

/** Per-action timing breakdown for one connect send — answers exactly what
 * the account owner asked for: how many minutes were spent scrolling a
 * profile, how long it dwelled/"froze" on a recent-activity page, what
 * minute the Connect click and the actual send happened. Every field is an
 * absolute epoch-ms timestamp (or a duration for the dwell) so the caller
 * can reconstruct the whole sequence without guessing from log ordering
 * alone; `null` means that phase didn't happen (e.g. no note was added) or
 * wasn't reached before an error — a caller wraps this in JSON.stringify()
 * for actions_log.timing_json (db.ts), it's never persisted as-is. */
export interface ConnectTiming {
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

/** Sends one connection request to `profileUrl`, with an optional note.
 * Every step is human-paced (browser.ts's humanDelay/humanMouseMove/
 * humanType) — deliberately the slowest correct implementation, not the
 * fastest. Throws LinkedInPageError with a specific, actionable reason
 * (checkpoint / logged-out / button-not-found) rather than a generic
 * failure, so the caller's action-log entry records something useful
 * instead of just "it didn't work." `leadName`, when supplied (scheduler.ts
 * passes the lead's own stored name; the manual test-connect routes in
 * index.ts don't have one and simply skip this), is used only to decide
 * whether to navigate via LinkedIn's own search-by-name instead of a
 * direct URL — see searchByNameAndNavigate() above and
 * safety.ts's shouldUseSearchNavigation() for the probability/quota gate.
 * Returns a ConnectTiming breakdown on success (see above) rather than
 * void — a thrown LinkedInPageError on failure still carries no partial
 * timing, same as before this was added, since the caller's own
 * `responseTimeMs`/`executedAt` already covers the failure case. */
export async function sendConnectionRequest(profileUrl: string, note?: string, leadName?: string | null): Promise<ConnectTiming> {
  const startedAt = Date.now();
  const page = await getLinkedInPage();

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('LinkedIn is showing a checkpoint/verification page — resolve it manually first.');
  }

  const settings = getSafetySettings();
  let navigatedViaSearch = false;
  if (leadName?.trim() && shouldUseSearchNavigation(settings)) {
    navigatedViaSearch = await searchByNameAndNavigate(page, leadName.trim(), profileUrl);
    if (navigatedViaSearch) {
      recordSearchUsed();
      console.log('[linkedin/connect] navigated via search-by-name for', JSON.stringify(leadName));
    }
  }
  if (!navigatedViaSearch) {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
    await humanDelay(1500, 4000);
  }
  const navigatedAt = Date.now();

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('Navigating to the profile triggered a checkpoint page.');
  }
  if (!(await isLoggedIn(page))) {
    throw new LinkedInPageError('Not logged into LinkedIn in this Chrome profile.');
  }
  const loginConfirmedAt = Date.now();

  const browseResult = await browseProfileBeforeConnect(page, profileUrl);

  // The profile's own displayed name, captured now — before anything below
  // is clicked — so it can be cross-checked against the invite dialog's own
  // "Personalize your invitation to {name}" text further down. Added after
  // a real, live-witnessed incident this session: the account owner,
  // watching the actual Chrome window, reported the automation appearing to
  // target someone else entirely — a different, unrelated person shown in
  // this same profile page's own "People also viewed" sidebar — rather than
  // the profile actually navigated to. LinkedIn's own Sent Invitations and
  // Messaging views showed nothing was actually delivered to that other
  // person in that specific instance, but the underlying risk is real
  // regardless: every locator below searches the *whole page*, not just the
  // profile's own header, and a profile page always renders other real
  // people's names/buttons alongside it. This name check is the hard
  // backstop against ever confirming a send for the wrong person, no matter
  // what upstream locator logic matched.
  // NOTE: an <h1> lookup was tried first here and, live-confirmed this
  // session, came back empty/null on this exact repro profile — LinkedIn's
  // real name heading isn't reliably a plain <h1> (or isn't the *first* one
  // on the page; profile pages have other heading-role elements above it).
  // The "Follow {name}" button's own aria-label, by contrast, has been
  // consistently present with the exact name on every single dump taken
  // this session, so it's used as the primary source, with <h1> kept only
  // as a last-resort fallback.
  const followAriaLabel = await page.locator('[aria-label^="Follow " i]').first().getAttribute('aria-label').catch(() => null);
  const profileName =
    followAriaLabel?.replace(/^Follow\s+/i, '').trim() ||
    (await page.locator('h1').first().textContent().catch(() => null))?.trim() ||
    null;
  console.log('[linkedin/connect] navigated to', profileUrl, '— page url now', page.url(), '— detected profileName:', JSON.stringify(profileName));

  // Real, live-reproduced false positive found this session — a lead the
  // account owner confirmed by hand was NOT actually connected still got
  // logged as "no Connect button found," on every single attempt, no
  // exceptions. Root cause (found by dumping the actual DOM, not guessing):
  // LinkedIn's current Connect control is a `<div>` with
  // `aria-label="Invite {name} to connect"`, NOT a `<button>` element at
  // all — the class names on it are hashed/build-specific (e.g.
  // `ca689ff0`), same story as isLoggedIn()'s own nav-selector breakage
  // documented elsewhere in this file, but this one silently produced a
  // WRONG action-log entry every time instead of a clean "logged out"
  // failure, since `button:has-text("Connect")` simply never matches a
  // non-button element regardless of how long you wait for it. The
  // `aria-label*="to connect"` pattern is the reliable signal — it
  // describes intent, not markup, so it survives both a tag-type change
  // and a display-language change the same way `isLoggedIn()`'s
  // `href*="/messaging/"` fix does. `button:has-text("Connect")` is kept
  // as a fallback in case some contexts (e.g. the "More" dropdown below)
  // do render a real button.
  const anyActionButton = page.locator(
    '[aria-label*="to connect" i], button:has-text("Connect"), button:has-text("Message"), button:has-text("Follow"), button:has-text("Pending")',
  );
  await anyActionButton.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});

  // THE root cause of every real, live-witnessed wrong-target incident this
  // session (confirmed via inline logging, not guessed): this "direct
  // Connect" check used to be a blind page-wide `.first()` over
  // `[aria-label*="to connect" i]` — and a profile page routinely renders
  // OTHER real people's own direct "Invite {other name} to connect"
  // controls too (a "People also viewed"/"People you may know" module
  // further down the same page), each with an aria-label that matches this
  // same broad pattern. `.first()` doesn't mean "the one on the profile you
  // navigated to" — it means whichever one happens to sort first in DOM
  // order, which live-logged output confirmed was, twice, a completely
  // different person ("Invite Elzė Čebatariūnaitė to connect" while
  // navigated to Dmitry Furs's own profile). Fixed by collecting every
  // matching candidate and preferring whichever one's aria-label actually
  // contains the profile's own name (captured above) — falling back to the
  // old blind `.first()` only if profileName is unknown or none match,
  // since a stale fallback beats no fallback at all, but the invite-dialog
  // name check further down is what makes even that fallback safe.
  const directCandidates = await page.locator('[aria-label*="to connect" i], button:has-text("Connect")').all();
  // Deliberately starts as a locator matching nothing (a bogus attribute
  // name) rather than `directCandidates[0]` — if profileName is known and
  // NONE of the candidates actually name it (exactly the repro case: Dmitry
  // Furs has no direct Connect button at all, only unrelated people
  // elsewhere on his own page do), this must behave as "no direct Connect
  // found" so control correctly falls through to the More-menu path below,
  // not silently accept an unrelated person's button as a last resort.
  let connectButton = page.locator('[data-mydesk-no-direct-connect-match]');
  if (profileName) {
    for (const candidate of directCandidates) {
      const aria = (await candidate.getAttribute('aria-label').catch(() => null)) || '';
      if (aria.toLowerCase().includes(profileName.toLowerCase())) {
        connectButton = candidate;
        break;
      }
    }
  } else if (directCandidates.length > 0) {
    // profileName itself couldn't be determined — no safe way to
    // disambiguate candidates by name, so fall back to the old best-effort
    // behavior. Still protected by the invite-dialog name check further
    // down whenever profileName does happen to be available by then.
    connectButton = page.locator('[aria-label*="to connect" i], button:has-text("Connect")').first();
  }

  // Fallback: LinkedIn sometimes tucks Connect inside the "···" (More
  // actions) overflow menu instead of showing it directly (seen on
  // profiles where Follow is the primary action). A real, live-reproduced
  // repro profile this session (one the account owner confirmed by hand
  // was NOT yet connected) showed this fallback never even attempting the
  // click: the old version scoped its search for the More button to the
  // same immediate DOM parent as the Message/Follow button
  // (`.locator('xpath=..')`), but live inspection showed the real
  // profile-header More button is NOT inside that parent — LinkedIn's
  // hashed, build-specific class names (`_95143304 faf125bd ...`) give no
  // stable container to scope a DOM-ancestor search to at all, same gap
  // documented for isLoggedIn()'s own selector history elsewhere in this
  // file. Fixed by dropping the ancestor scoping and instead picking
  // whichever visible "More"/"More actions" control sits below the sticky
  // top nav (y > 50px — the nav's own "More", if present, renders near the
  // very top of the viewport) — a profile has exactly one such control in
  // its own header, confirmed against the real repro profile.
  if ((await connectButton.count()) === 0) {
    // Real, live-reproduced incident this session: `button:has-text("More")`
    // in this candidate list is a substring match, and profiles routinely
    // have an unrelated "… more" text-expansion control further down the
    // page (e.g. to expand a long About section) — its own visible text
    // contains "more", so it matched this selector too. On one repro
    // profile that control sat *below* the real "More actions" button
    // (y:664 vs y:483), and the "highest y wins" picking logic below chose
    // it instead — clicking it just expands some text, no menu opens, and
    // the whole flow fails with a generic "no Connect button found."
    // Fixed by requiring the precise aria-label match as the only
    // candidate source; text-based matching is dropped entirely rather
    // than kept as a fallback, since *any* "more"-labelled expander
    // anywhere on the page is a plausible false positive the same way,
    // not just this one instance of it.
    const moreCandidates = await page.locator('[aria-label="More actions" i], [aria-label="More" i]').all();
    let moreButton: (typeof moreCandidates)[number] | null = null;
    let moreButtonTop = -1;
    for (const candidate of moreCandidates) {
      const box = await candidate.boundingBox();
      if (box && box.y > 50 && box.y < 900 && box.y > moreButtonTop) {
        moreButton = candidate;
        moreButtonTop = box.y;
      }
    }
    console.log('[linkedin/connect] direct Connect not found; More candidates:', moreCandidates.length, '— chosen More button top:', moreButtonTop);
    if (moreButton) {
      await humanDelay(300, 800);
      const moreBox = await moreButton.boundingBox();
      if (moreBox) {
        await humanMouseMove(page, { x: moreBox.x + moreBox.width / 2, y: moreBox.y + moreBox.height / 2 });
      }
      await humanDelay(200, 500);
      await moreButton.evaluate((el) => (el as { click: () => void }).click());
      await humanDelay(500, 1200);
      console.log('[linkedin/connect] clicked More at top', moreButtonTop, '— page url now', page.url());

      // Live-confirmed real menu shape on the repro profile: plain
      // `<a role="menuitem">` items with no aria-label at all, matched
      // purely on visible text ("Send profile in a message", "Save to
      // PDF", "Connect", "Report / Block", "About this member"). If the
      // menu shows "Remove Connection" instead of "Connect", this person
      // is already a 1st-degree connection — a distinct, terminal outcome
      // from "layout changed" or "not found," so it gets its own message
      // (matched by scheduler.ts's isNoConnectButtonError() alongside the
      // generic one, same "exact string, terminal, skip-don't-retry"
      // handling already established there).
      //
      // CRITICAL: two real, live-witnessed incidents this session (the
      // account owner watching the actual Chrome window, confirmed by hand
      // both times) showed this exact block clicking "Connect" for a
      // completely unrelated, wrong person — once matching a sidebar
      // "People also viewed" card, once a "People you may know" module
      // further down the page. Root cause: `[role="menuitem"]` here was
      // never actually scoped to the dropdown that was JUST opened — it
      // searched the *whole page*, and `.first()` (DOM order) doesn't mean
      // "the menu that opened a moment ago." LinkedIn portals dropdown
      // content to the end of <body>, so a genuine, unrelated "Connect"
      // control embedded earlier in the page's own main content (not
      // inside any portal) sorts *before* the just-opened menu in DOM
      // order and wins `.first()` every time — while the actual freshly-
      // opened menu, portaled last, never does. Fixed by scoping strictly
      // to `[role="menu"]` (there is at most one open at a time — opening
      // a new one closes any previous) and preferring `.last()` over
      // `.first()` for the same reason. This is still not a perfect
      // structural guarantee (no stable container selector exists at all
      // — see this file's own repeated notes on LinkedIn's hashed class
      // names), which is exactly why the invite-dialog name check further
      // down exists as the real, final safety gate — this scoping fix
      // narrows the odds of ever reaching that gate with the wrong person
      // already clicked, it isn't itself the guarantee.
      const menuCountNow = await page.locator('[role="menu"]').count();
      const openMenu = page.locator('[role="menu"]').last();
      const menuText = await openMenu.innerText().catch(() => '(could not read menu text)');
      console.log('[linkedin/connect] role="menu" count on page:', menuCountNow, '— chosen (last) menu text:', JSON.stringify(menuText));
      if ((await openMenu.locator('[role="menuitem"]:has-text("Remove Connection")').count()) > 0) {
        throw new LinkedInPageError(ALREADY_CONNECTED_ERROR);
      }
      // No page-wide fallback here on purpose (an earlier version had one)
      // — a page-wide `[aria-label*="to connect" i]` search is exactly the
      // pattern that caused the direct-path incidents above; if the
      // scoped menu lookup finds nothing, that correctly falls through to
      // the generic "No Connect button found" error below rather than
      // silently reaching for an unrelated match again.
      connectButton = openMenu.locator('[role="menuitem"]:has-text("Connect")').last();
    }
  }

  if ((await connectButton.count()) === 0) {
    throw new LinkedInPageError(
      'No "Connect" button found on this profile — may already be connected/pending, or the page layout changed.',
    );
  }

  {
    const debugTag = await connectButton.evaluate((el) => (el as { tagName: string }).tagName).catch(() => '?');
    const debugText = await connectButton.innerText().catch(() => '?');
    const debugAria = await connectButton.getAttribute('aria-label').catch(() => null);
    const debugHref = await connectButton.getAttribute('href').catch(() => null);
    console.log('[linkedin/connect] resolved connectButton about to be clicked:', {
      tag: debugTag,
      text: debugText,
      ariaLabel: debugAria,
      href: debugHref,
    });
  }

  const box = await connectButton.boundingBox();
  if (box) {
    await humanMouseMove(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  await humanDelay(300, 900);
  // A real DOM click (element.click() via evaluate), not a simulated mouse
  // click at screen coordinates — found the hard way this session.
  // click({ force: true }) was tried first to work around "subtree
  // intercepts pointer events" (an unrelated decorative element sitting
  // over the same pixel area), but force:true only skips Playwright's own
  // pre-click actionability check — the actual click is still dispatched
  // at real screen coordinates, so it can still land on whatever the
  // browser's own hit-testing finds there. Confirmed live and firsthand:
  // it landed on that other element instead, navigating the tab to
  // LinkedIn's Campaign Manager (an ad-related icon, apparently), not
  // triggering Connect at all — a real, unintended side effect, not just a
  // failed click. element.click() bypasses screen-coordinate hit-testing
  // entirely by invoking the DOM's own click handling directly on the
  // exact element already confirmed correct via its aria-label above, so
  // there's nothing else on the page it could land on instead.
  await connectButton.evaluate((el) => (el as { click: () => void }).click());
  const connectClickedAt = Date.now();
  await humanDelay(800, 2000);
  console.log('[linkedin/connect] clicked connectButton — page url now', page.url());

  // Wait for LinkedIn's own invite-confirmation dialog and read its exact
  // "Personalize your invitation to {name} by adding a note." text — this
  // is the hard safety gate described above. A real, live-confirmed gotcha
  // this session: `page.locator('body').innerText()` (checked across every
  // frame, not just the main one) never found this text even with the
  // dialog visibly open on screen and confirmed via screenshot — but
  // Playwright's own `:text()` pseudo-class selector found it instantly.
  // `innerText()` is the *native* browser property, which does not pierce
  // shadow DOM boundaries; Playwright's own selector engine does. This
  // dialog's content apparently lives inside a shadow root somewhere
  // between <body> and the text itself, so any future check against this
  // dialog (or similar LinkedIn overlays) should go through a Playwright
  // text/role locator, never a raw `body.innerText()` scan.
  const personalizeLocator = page.locator(':text("Personalize your invitation to")');
  let invitedName: string | null = null;
  try {
    await personalizeLocator.first().waitFor({ state: 'visible', timeout: 15000 });
    const dialogText = await personalizeLocator.first().innerText();
    const match = dialogText.match(/Personalize your invitation to ([^.\n]+?) by adding a note/i);
    invitedName = match ? match[1].trim() : null;
  } catch {
    invitedName = null;
  }

  if (!invitedName) {
    console.log('[linkedin/connect] no Personalize dialog found via text locator after clicking Connect.');
    throw new LinkedInPageError(
      'Clicked Connect but no invite confirmation dialog ("Personalize your invitation...") appeared — aborting rather than guessing.',
    );
  }
  // Loose, both-direction substring match (case-insensitive): the profile
  // page's <h1> and the dialog's own text aren't always byte-identical
  // (the <h1> can carry trailing credentials/pronouns the dialog omits),
  // but one should always contain the other for the same real person.
  const namesMatch =
    !profileName ||
    invitedName.toLowerCase().includes(profileName.toLowerCase()) ||
    profileName.toLowerCase().includes(invitedName.toLowerCase());
  if (!namesMatch) {
    throw new LinkedInPageError(
      `Invite dialog is for "${invitedName}", not the expected "${profileName}" — aborting without sending.`,
    );
  }

  let noteAdded = false;
  if (note?.trim()) {
    const addNoteButton = page.locator('button:has-text("Add a note")').first();
    if ((await addNoteButton.count()) > 0) {
      await addNoteButton.click();
      await humanDelay(400, 1000);
      await humanType(page, 'textarea[name="message"]', note.trim());
      await humanDelay(500, 1500);
      noteAdded = true;
    }
  }

  // Prefer the exact button text LinkedIn's own invite dialog uses
  // ("Send without a note" / "Send invitation" / "Send now") over a bare
  // substring match on "Send" — a real, live-witnessed incident this
  // session (a genuine connect request landing on the wrong person,
  // confirmed by the account owner after having to withdraw it by hand) is
  // the reason a blind page-wide "Send" search is no longer trusted alone.
  // By this point invitedName has already been confirmed to match
  // profileName above, so this is defense in depth, not the primary gate.
  let sendButton = page.locator('button:has-text("Send without a note"), button:has-text("Send invitation"), button:has-text("Send now")').first();
  if ((await sendButton.count()) === 0) {
    sendButton = page.locator('button:has-text("Send")').first();
  }
  if ((await sendButton.count()) === 0) {
    throw new LinkedInPageError('Confirm/Send button not found after clicking Connect.');
  }
  await humanDelay(300, 900);
  await sendButton.click();
  const sentAt = Date.now();
  await humanDelay(500, 1200);

  return {
    startedAt,
    navigatedViaSearch,
    navigatedAt,
    loginConfirmedAt,
    visitedRecentActivity: browseResult.visitedRecentActivity,
    recentActivityDwellMs: browseResult.recentActivityDwellMs,
    connectClickedAt,
    noteAdded,
    sentAt,
    totalMs: sentAt - startedAt,
  };
}

/** Sends a direct message to `profileUrl` — only works for an existing
 * 1st-degree connection (LinkedIn only shows a "Message" button on a
 * profile you're already connected to; there's no InMail support here).
 * The Scheduler only calls this for leads it believes are already
 * connected — see scheduler.ts's own note on why nothing currently
 * verifies that automatically. */
export async function sendMessage(profileUrl: string, text: string): Promise<void> {
  const page = await getLinkedInPage();

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('LinkedIn is showing a checkpoint/verification page — resolve it manually first.');
  }

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await humanDelay(1500, 4000);

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('Navigating to the profile triggered a checkpoint page.');
  }
  if (!(await isLoggedIn(page))) {
    throw new LinkedInPageError('Not logged into LinkedIn in this Chrome profile.');
  }

  const messageButton = page.locator('button:has-text("Message"), a[aria-label*="Message" i]').first();
  if ((await messageButton.count()) === 0) {
    throw new LinkedInPageError('No "Message" button on this profile — likely not (yet) a 1st-degree connection.');
  }

  const box = await messageButton.boundingBox();
  if (box) {
    await humanMouseMove(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  await humanDelay(300, 900);
  await messageButton.click();
  await humanDelay(800, 2000);

  const composer = page.locator('div[role="textbox"][aria-label*="message" i], div.msg-form__contenteditable').first();
  if ((await composer.count()) === 0) {
    throw new LinkedInPageError('Message compose box did not open.');
  }
  await composer.click();
  for (const char of text) {
    await page.keyboard.type(char, { delay: 60 + Math.random() * 140 });
  }
  await humanDelay(500, 1500);

  const sendButton = page.locator('button:has-text("Send")').first();
  if ((await sendButton.count()) === 0) {
    throw new LinkedInPageError('Send button not found in the message compose box.');
  }
  await humanDelay(300, 900);
  await sendButton.click();
  await humanDelay(500, 1200);
}

export interface ScrapedConversation {
  participantUrl: string;
  participantName: string | null;
  preview: string | null;
  unread: boolean;
  threadUrl: string;
}

/** Scrapes the conversation list at linkedin.com/messaging/ — one row
 * per thread, not the messages themselves (see scrapeThreadMessages()
 * below for that). Conversations with no resolvable participant profile
 * link are skipped rather than stored with a null URL, since
 * participant_url is what everything else (lead matching, dedup) keys
 * off of. */
export async function listConversationThreads(): Promise<ScrapedConversation[]> {
  const page = await getLinkedInPage();
  await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded' });
  await humanDelay(1500, 3000);

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('LinkedIn is showing a checkpoint/verification page — resolve it manually first.');
  }
  if (!(await isLoggedIn(page))) {
    throw new LinkedInPageError('Not logged into LinkedIn in this Chrome profile.');
  }

  const threads = page.locator('li.msg-conversation-listitem');
  const count = await threads.count();
  const results: ScrapedConversation[] = [];
  for (let i = 0; i < count; i++) {
    const thread = threads.nth(i);
    const link = thread.locator('a.msg-conversation-listitem__link').first();
    const href = await link.getAttribute('href').catch(() => null);
    if (!href) continue;
    const participantUrl = new URL(href, 'https://www.linkedin.com').toString();
    const participantName = await thread
      .locator('.msg-conversation-listitem__participant-names')
      .first()
      .textContent()
      .catch(() => null);
    const preview = await thread.locator('.msg-conversation-card__message-snippet').first().textContent().catch(() => null);
    const unread = (await thread.locator('.notification-badge--show').count()) > 0;
    results.push({
      participantUrl,
      participantName: participantName?.trim() || null,
      preview: preview?.trim() || null,
      unread,
      threadUrl: participantUrl,
    });
  }
  return results;
}

type MessageDirectionGuess = 'in' | 'out';

export interface ScrapedMessage {
  direction: MessageDirectionGuess;
  content: string;
  // Best-effort — LinkedIn's own message timestamps are relative
  // ("2m", "Yesterday") once scraped from the DOM, not exact; inbox.ts's
  // dedup logic (addMessageIfNew) already tolerates a minute of drift
  // for exactly this reason, so "approximately now" is an acceptable
  // fallback when a precise time can't be parsed.
  timestamp: number;
}

/** Opens one thread and scrapes its full *currently rendered* message
 * history — LinkedIn's DOM gives no cheap "only what's new since X"
 * cursor, so this always returns everything visible; inbox.ts's own
 * dedup (addMessageIfNew) is what keeps re-syncing the same thread from
 * creating duplicate rows. Messages sent by the account owner render
 * with a distinguishing class LinkedIn applies to "outgoing" bubbles. */
export async function scrapeThreadMessages(threadUrl: string): Promise<ScrapedMessage[]> {
  const page = await getLinkedInPage();
  await page.goto(threadUrl, { waitUntil: 'domcontentloaded' });
  await humanDelay(1200, 2500);

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('LinkedIn is showing a checkpoint/verification page — resolve it manually first.');
  }

  const bubbles = page.locator('.msg-s-event-listitem');
  const count = await bubbles.count();
  const results: ScrapedMessage[] = [];
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const bubble = bubbles.nth(i);
    const content = await bubble.locator('.msg-s-event-listitem__body').first().textContent().catch(() => null);
    if (!content?.trim()) continue;
    const isOutgoing = (await bubble.locator('.msg-s-event-listitem--other').count()) === 0;
    results.push({ direction: isOutgoing ? 'out' : 'in', content: content.trim(), timestamp: now });
  }
  return results;
}

/** Withdraws a previously-sent, still-pending connection request —
 * LinkedIn has no "Withdraw" action on the profile page itself once an
 * invite is pending (the button there just reads "Pending", not
 * clickable into anything useful), so this goes through the sent-
 * invitations management page instead and finds the row whose own
 * profile link matches `profileUrl`. Used by scheduler.ts's stale-invite
 * cleanup — see its own doc comment for why this is manual-approval-only
 * (never wired into the background auto-execute path), unlike
 * connect/message sends. */
export async function withdrawConnectionRequest(profileUrl: string): Promise<void> {
  const page = await getLinkedInPage();

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('LinkedIn is showing a checkpoint/verification page — resolve it manually first.');
  }

  await page.goto('https://www.linkedin.com/mynetwork/invitation-manager/sent/', { waitUntil: 'domcontentloaded' });
  await humanDelay(1500, 3000);

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('Navigating to sent invitations triggered a checkpoint page.');
  }
  if (!(await isLoggedIn(page))) {
    throw new LinkedInPageError('Not logged into LinkedIn in this Chrome profile.');
  }

  // Matched by checking each row's own link href in JS (targetPath.includes,
  // via a plain string comparison), not by interpolating the path into a
  // CSS attribute selector — profileUrl comes from this app's own stored
  // lead data (CSV import, manual entry, or the search scraper), which
  // could in principle contain a character (a literal `"`) that breaks a
  // dynamically-built `[href*="..."]` selector; a `.filter()` here can't be
  // malformed regardless of what the path contains. Same
  // loop-and-check-in-JS shape searchLeads()/listConversationThreads()
  // above already use for the identical reason.
  const targetPath = new URL(profileUrl).pathname.replace(/\/+$/, '');
  const rows = page.locator('li:has(a[href*="/in/"])');
  const rowCount = await rows.count();
  let row = null;
  for (let i = 0; i < rowCount; i++) {
    const candidate = rows.nth(i);
    const href = await candidate.locator('a[href*="/in/"]').first().getAttribute('href').catch(() => null);
    if (href && new URL(href, 'https://www.linkedin.com').pathname.replace(/\/+$/, '') === targetPath) {
      row = candidate;
      break;
    }
  }
  if (!row) {
    throw new LinkedInPageError('Could not find this person in the sent-invitations list — may already be accepted/withdrawn.');
  }

  const withdrawButton = row.locator('button:has-text("Withdraw")').first();
  if ((await withdrawButton.count()) === 0) {
    throw new LinkedInPageError('No "Withdraw" button found on this invitation row — LinkedIn may have changed this page\'s layout.');
  }
  await humanDelay(300, 900);
  await withdrawButton.click();
  await humanDelay(500, 1200);

  // LinkedIn confirms via a modal ("Withdraw invitation? ... Withdraw"),
  // not an immediate action on the first click.
  const confirmButton = page.locator('button:has-text("Withdraw")').last();
  if ((await confirmButton.count()) > 0) {
    await humanDelay(300, 800);
    await confirmButton.click();
    await humanDelay(500, 1200);
  }
}

export interface ScrapedSearchLead {
  linkedinUrl: string;
  name: string | null;
  title: string | null;
  company: string | null;
}

// LinkedIn's people-search URL takes a plain `keywords` query param — no
// separate "title"/"company" filter params here, since building out the
// full filter-URL grammar (location/industry/connection-degree, each with
// its own encoded facet id) is a lot of surface area for what the plan
// deliberately scoped down to "a simple scraper of search results, not
// deep profile crawling or a full filter UI" (per TZ_LinkedIn_Automation.md
// section 3, MVP item 2) — a free-text query covers the common case
// ("marketing director acme"), and a raw LinkedIn search URL (copy-pasted
// from an already-filtered search done manually in the browser) works
// here too, since this just navigates to whatever URL it's given.
function buildSearchUrl(query: string): string {
  const trimmed = query.trim();
  if (/^https?:\/\/(www\.)?linkedin\.com\/search\//i.test(trimmed)) return trimmed;
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(trimmed)}`;
}

/** Scrapes only the *currently loaded* first page of people-search
 * results — no automated "scroll for more" or pagination-clicking, by
 * design: this is meant as a lightweight, occasional lead-discovery aid
 * (a human reviews and picks which results to actually import — see
 * LeadSearchImport.tsx), not a bulk-harvesting crawler, which would both
 * defeat the point of "not deep crawling" in the plan and meaningfully
 * raise this account's automated-activity footprint for a feature that's
 * explicitly the lowest-priority, opt-in one (Phase 3). Results with no
 * resolvable profile link are skipped, same reasoning as
 * listConversationThreads() above. */
export async function searchLeads(query: string): Promise<ScrapedSearchLead[]> {
  const page = await getLinkedInPage();
  await page.goto(buildSearchUrl(query), { waitUntil: 'domcontentloaded' });
  await humanDelay(1800, 3500);

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('LinkedIn is showing a checkpoint/verification page — resolve it manually first.');
  }
  if (!(await isLoggedIn(page))) {
    throw new LinkedInPageError('Not logged into LinkedIn in this Chrome profile.');
  }

  const cards = page.locator('li.reusable-search__result-container, div[data-chameleon-result-urn]');
  const count = await cards.count();
  const results: ScrapedSearchLead[] = [];
  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    const link = card.locator('a.app-aware-link[href*="/in/"]').first();
    const href = await link.getAttribute('href').catch(() => null);
    if (!href) continue;
    // Search-result profile links carry tracking query params
    // (?miniProfileUrn=...) — stripped so the stored linkedinUrl matches
    // the same clean /in/handle form every other lead-entry path produces
    // (CSV import, manual add), which findLeadByLinkedinUrl()'s exact-match
    // lookup depends on.
    const parsedHref = new URL(href, 'https://www.linkedin.com');
    const linkedinUrl = parsedHref.origin + parsedHref.pathname;
    const name = await card.locator('span[aria-hidden="true"]').first().textContent().catch(() => null);
    const subtitle = await card
      .locator('.entity-result__primary-subtitle, div[class*="subtitle"]')
      .first()
      .textContent()
      .catch(() => null);
    // LinkedIn's own subtitle line is usually "Title at Company" or just
    // "Title" — split on " at " (case-sensitive, matching LinkedIn's own
    // English-UI phrasing) as a best-effort guess; if it doesn't match,
    // the whole subtitle lands in `title` rather than being dropped, since
    // *something* is more useful than silently losing it.
    const cleanedSubtitle = subtitle?.trim() || null;
    const atMatch = cleanedSubtitle ? / at /.exec(cleanedSubtitle) : null;
    const title = atMatch ? cleanedSubtitle!.slice(0, atMatch.index).trim() : cleanedSubtitle;
    const company = atMatch ? cleanedSubtitle!.slice(atMatch.index + 4).trim() : null;
    results.push({ linkedinUrl, name: name?.trim() || null, title, company });
  }
  return results;
}

/** Replies within an already-open thread — navigates straight to
 * `threadUrl` rather than going via the participant's profile the way
 * sendMessage() does, since a reply to an existing conversation doesn't
 * need to re-find a "Message" button on a profile page. */
export async function replyInThread(threadUrl: string, text: string): Promise<void> {
  const page = await getLinkedInPage();
  await page.goto(threadUrl, { waitUntil: 'domcontentloaded' });
  await humanDelay(1200, 2500);

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('LinkedIn is showing a checkpoint/verification page — resolve it manually first.');
  }
  if (!(await isLoggedIn(page))) {
    throw new LinkedInPageError('Not logged into LinkedIn in this Chrome profile.');
  }

  const composer = page.locator('div[role="textbox"][aria-label*="message" i], div.msg-form__contenteditable').first();
  if ((await composer.count()) === 0) {
    throw new LinkedInPageError('Message compose box not found on this thread.');
  }
  await composer.click();
  for (const char of text) {
    await page.keyboard.type(char, { delay: 60 + Math.random() * 140 });
  }
  await humanDelay(500, 1500);

  const replySendButton = page.locator('button:has-text("Send")').first();
  if ((await replySendButton.count()) === 0) {
    throw new LinkedInPageError('Send button not found in the message compose box.');
  }
  await humanDelay(300, 900);
  await replySendButton.click();
  await humanDelay(500, 1200);
}

/** Standalone "View Profile" campaign-graph action — navigates to a lead's
 * profile and dwells a human-plausible amount, no Connect/Message
 * involved. Reuses the same scroll + humanDelay dwelling primitives
 * sendConnectionRequest's own browseProfileBeforeConnect() established,
 * kept as a separate, simpler function here since this is a deliberate,
 * standalone action a graph author places on its own (e.g. "view their
 * profile a few times before ever connecting") rather than something
 * probabilistically folded into a connect send. */
export async function viewProfile(profileUrl: string): Promise<void> {
  const page = await getLinkedInPage();

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('LinkedIn is showing a checkpoint/verification page — resolve it manually first.');
  }

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await humanDelay(1500, 4000);

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('Navigating to the profile triggered a checkpoint page.');
  }
  if (!(await isLoggedIn(page))) {
    throw new LinkedInPageError('Not logged into LinkedIn in this Chrome profile.');
  }

  await page.mouse.wheel(0, 400 + Math.random() * 500);
  await humanDelay(15_000, 60_000);
}

/** Follows a profile — live-verified this session (Mikhail Sak's profile):
 * the Follow control is a real `<button aria-label="Follow {name}">`
 * (same hashed-class LinkedIn UI-kit component family as the Connect
 * button), and — unlike the reaction/Like button elsewhere in this file —
 * a plain `element.evaluate(el => el.click())` DID correctly flip its
 * state (confirmed via the aria-label changing to `"Following, click to
 * unfollow {name}"`). Kept as evaluate-click rather than switching to a
 * real Playwright `.click()` for consistency with every other non-
 * reaction control in this file, now that it's been individually
 * confirmed to actually work for this specific button — see
 * likeRecentFeedPosts()'s own doc comment for why that assumption isn't
 * safe to make blindly for every control. */
export async function followProfile(profileUrl: string): Promise<void> {
  const page = await getLinkedInPage();

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('LinkedIn is showing a checkpoint/verification page — resolve it manually first.');
  }

  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await humanDelay(1500, 4000);

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('Navigating to the profile triggered a checkpoint page.');
  }
  if (!(await isLoggedIn(page))) {
    throw new LinkedInPageError('Not logged into LinkedIn in this Chrome profile.');
  }

  const followButton = page.locator('[aria-label^="Follow " i]').first();
  if ((await followButton.count()) === 0) {
    // Not necessarily an error — a profile you already follow, or one
    // where Follow isn't offered as a separate action from Connect, simply
    // has no such control. Treated as a clean no-op rather than a thrown
    // failure, so a graph author who places this node broadly doesn't get
    // spurious error-log noise for the (normal) case of an already-
    // followed lead.
    return;
  }
  const box = await followButton.boundingBox();
  if (box) {
    await humanMouseMove(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  await humanDelay(300, 900);
  await followButton.evaluate((el) => (el as { click: () => void }).click());
  await humanDelay(500, 1200);
}

/** Likes the first post found on a lead's own recent-activity page —
 * unlike humanize.ts's likeRecentFeedPosts() (general feed "texture",
 * gated by its own probability, targeting random posts), this is a
 * deliberate, targeted campaign-graph action: like *this specific
 * person's* latest post. Reuses the exact same `/recent-activity/all/`
 * navigation and reaction-button selector already proven correct this
 * session (see §5's profile-dwelling work and likeRecentFeedPosts()'s own
 * doc comment) — and, live-reverified specifically for this function
 * against a real profile, the SAME real-Playwright-`.click()` requirement:
 * `element.evaluate(el => el.click())` was inconsistent here too (worked
 * once, silently no-opped once, confirmed by screenshot both times), so
 * this never uses it, matching likeRecentFeedPosts()'s already-established
 * choice. */
export async function likeLatestPost(profileUrl: string): Promise<void> {
  const page = await getLinkedInPage();

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('LinkedIn is showing a checkpoint/verification page — resolve it manually first.');
  }

  const activityUrl = profileUrl.replace(/\/+$/, '') + '/recent-activity/all/';
  await page.goto(activityUrl, { waitUntil: 'domcontentloaded' });
  await humanDelay(2000, 4000);

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('Navigating to recent activity triggered a checkpoint page.');
  }
  if (!(await isLoggedIn(page))) {
    throw new LinkedInPageError('Not logged into LinkedIn in this Chrome profile.');
  }

  const likeButton = page.locator('button[aria-label*="Reaction button state: no reaction" i], button[aria-label="React Like" i]').first();
  if ((await likeButton.count()) === 0) {
    // No posts at all, or everything already liked — a clean no-op, same
    // reasoning as followProfile() above.
    return;
  }
  await likeButton.scrollIntoViewIfNeeded().catch(() => {});
  await humanDelay(400, 1000);
  const box = await likeButton.boundingBox();
  if (box) {
    await humanMouseMove(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }
  await humanDelay(200, 600);
  await likeButton.click();
  await humanDelay(500, 1200);
}

/** Likes up to `maxLikes` posts on the main feed — the whole DOM-facing
 * half of humanize.ts's "occasionally like 1-2 recent posts, sometimes
 * none" activity-mixing (see that module for the probability/frequency
 * policy; this function just executes, it makes no decisions about
 * whether/how often to run). Never comments, never reposts — likes only,
 * on explicit request (comments are a materially bigger surface: real
 * generated text under this account's name, with no prior art anywhere in
 * this codebase, vs. a single reversible click).
 *
 * The selector is the one real gotcha here, live-confirmed this session:
 * the feed's Like button's `aria-label` is `"Reaction button state: no
 * reaction"` — it does NOT contain the word "like" at all, unlike the
 * `recent-activity/all/` page's own Like control (`aria-label="React
 * Like"`), a different pattern on a different LinkedIn surface for what
 * looks like the same button. Scoped to `"no reaction"` specifically (not
 * just `"Reaction button state"`) so this only ever clicks a post that
 * isn't already liked — a post already carrying some other reaction would
 * report a different state string here and is deliberately left alone,
 * since toggling an existing reaction is a different, unverified action
 * this function has no business taking.
 *
 * Live-verified this session, and the OPPOSITE lesson from the Connect
 * button above: `element.evaluate((el) => el.click())` (the pattern used
 * everywhere else in this file, specifically because it bypasses
 * screen-coordinate hit-testing) silently did NOTHING here on two separate
 * attempts — the button's own `aria-label` stayed "no reaction" and its
 * `componentkey` attribute changed (a re-render happened) but the actual
 * reaction never registered. A genuine Playwright `.click()` (a real,
 * full synthetic mouse event at screen coordinates) worked immediately,
 * confirmed three ways: `aria-label` flipped to `"Reaction button state:
 * Like"`, the icon turned blue/filled, and the post's reaction count/
 * "You and N others" text updated — screenshotted before/after to be
 * certain. This button apparently needs the fuller event sequence
 * (mousedown/mouseup/pointer events) a real Playwright click dispatches,
 * which a bare synthetic `click` event does not include. The lesson that
 * generalizes: a click-dispatch strategy that's correct for one LinkedIn
 * control is not guaranteed to work for another — verify each one
 * independently rather than assuming the last fix generalizes. */
export async function likeRecentFeedPosts(maxLikes: number): Promise<number> {
  if (maxLikes <= 0) return 0;
  const page = await getLinkedInPage();

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('LinkedIn is showing a checkpoint/verification page — resolve it manually first.');
  }

  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await humanDelay(2000, 4000);

  if (isCheckpointUrl(page.url())) {
    throw new LinkedInPageError('Navigating to the feed triggered a checkpoint page.');
  }
  if (!(await isLoggedIn(page))) {
    throw new LinkedInPageError('Not logged into LinkedIn in this Chrome profile.');
  }

  // The feed lazy-loads posts as you scroll — live-confirmed this session
  // that a fresh page load with no scroll can render zero post containers
  // at all. A couple of modest scroll-and-pause cycles mimics a real
  // person reading down the feed and gives more posts a chance to mount
  // before candidates are collected.
  for (let i = 0; i < 2; i++) {
    await page.mouse.wheel(0, 500 + Math.random() * 600);
    await humanDelay(1200, 2800);
  }

  const likeButtons = page.locator('button[aria-label*="Reaction button state: no reaction" i]');
  const count = await likeButtons.count();
  if (count === 0) return 0;

  // Random sample, not "the first N" — the first posts in the feed are
  // what every automated pass would hit first if this always just took
  // index 0..maxLikes, itself a mechanical tell.
  const indices = Array.from({ length: count }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const chosen = indices.slice(0, Math.min(maxLikes, count));

  let liked = 0;
  for (const idx of chosen) {
    const button = likeButtons.nth(idx);
    const box = await button.boundingBox().catch(() => null);
    if (!box) continue;
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await humanDelay(400, 1000);
    await humanMouseMove(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await humanDelay(200, 600);
    await button.click();
    liked++;
    await humanDelay(1500, 4000);
  }
  return liked;
}
