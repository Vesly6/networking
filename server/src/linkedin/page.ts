import type { Page } from 'playwright';
import { getLinkedInPage, humanDelay, humanMouseMove, humanType } from './browser.js';

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

/** Sends one connection request to `profileUrl`, with an optional note.
 * Every step is human-paced (browser.ts's humanDelay/humanMouseMove/
 * humanType) — deliberately the slowest correct implementation, not the
 * fastest. Throws LinkedInPageError with a specific, actionable reason
 * (checkpoint / logged-out / button-not-found) rather than a generic
 * failure, so the caller's action-log entry records something useful
 * instead of just "it didn't work." */
export async function sendConnectionRequest(profileUrl: string, note?: string): Promise<void> {
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
    const moreCandidates = await page.locator('[aria-label="More actions" i], [aria-label="More" i], button:has-text("More")').all();
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

  if (note?.trim()) {
    const addNoteButton = page.locator('button:has-text("Add a note")').first();
    if ((await addNoteButton.count()) > 0) {
      await addNoteButton.click();
      await humanDelay(400, 1000);
      await humanType(page, 'textarea[name="message"]', note.trim());
      await humanDelay(500, 1500);
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
  await humanDelay(500, 1200);
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
