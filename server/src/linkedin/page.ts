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

  let connectButton = page.locator('[aria-label*="to connect" i], button:has-text("Connect")').first();

  // Fallback: LinkedIn sometimes tucks Connect inside the "···" (More
  // actions) overflow button next to Message/Follow instead of showing it
  // directly (seen on profiles where Follow is the primary action). Scoped
  // to the same immediate container as the Message/Follow button (not just
  // any "More"-labelled control anywhere on the page — a profile's
  // activity feed further down has its own unrelated "···" controls on
  // individual posts) so this doesn't accidentally click something
  // unrelated.
  if ((await connectButton.count()) === 0) {
    const primaryActionRow = page.locator('button:has-text("Message"), button:has-text("Follow")').first().locator('xpath=..');
    const moreButton = primaryActionRow.locator('[aria-label*="more" i], button:has-text("More")').first();
    if ((await moreButton.count()) > 0) {
      await humanDelay(300, 800);
      await moreButton.click();
      await humanDelay(500, 1200);
      connectButton = page.locator('[aria-label*="to connect" i], button:has-text("Connect"), [role="menuitem"]:has-text("Connect")').first();
    }
  }

  if ((await connectButton.count()) === 0) {
    throw new LinkedInPageError(
      'No "Connect" button found on this profile — may already be connected/pending, or the page layout changed.',
    );
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

  if (note?.trim()) {
    const addNoteButton = page.locator('button:has-text("Add a note")').first();
    if ((await addNoteButton.count()) > 0) {
      await addNoteButton.click();
      await humanDelay(400, 1000);
      await humanType(page, 'textarea[name="message"]', note.trim());
      await humanDelay(500, 1500);
    }
  }

  const sendButton = page.locator('button:has-text("Send")').first();
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
