import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export class LinkedInBrowserError extends Error {}

// The user launches their own real, logged-in Chrome with remote debugging
// enabled — this module only ever *attaches* to it (connectOverCDP), never
// launches its own browser instance. That's the entire safety premise of
// this feature (see TZ_LinkedIn_Automation.md): reuse a warm session with
// real cookies/history/fingerprint instead of a fresh automated profile,
// which is what would actually read as a bot to LinkedIn. Overridable via
// env for local testing against a non-default debugging port.
//
// IMPORTANT, found the hard way during live verification: current Chrome
// (confirmed on 151.x) silently refuses to open the remote-debugging port
// at all when launched against the *default* user-data-dir — a deliberate
// Google security hardening to stop outside tools from silently attaching
// to a user's main, cookie-holding profile. There's no error, no crash —
// `--remote-debugging-port=9222` is just quietly ignored and the port never
// listens, which from here looks identical to "Chrome isn't running yet."
// The fix is a SEPARATE, dedicated `--user-data-dir` (not a copy of the
// default profile) — remote debugging works fine there. This does mean the
// "reuse an already-warm daily-driver session" premise above has to bend
// slightly in practice: it's not literally the browser window you use for
// everyday browsing, but as long as the SAME dedicated profile directory is
// reused across every session (log into LinkedIn there once, then always
// relaunch pointed at that same directory), it still builds up its own
// real, persistent cookies/history over time rather than looking like a
// brand-new browser on every run. See server/.env.example for the actual
// launch command.
const CDP_URL = process.env.LINKEDIN_CDP_URL || 'http://127.0.0.1:9222';

let browser: Browser | null = null;
// Tracks which contexts already got the navigator.webdriver patch below,
// so getLinkedInPage() can call addInitScript() safely on every call
// without stacking up duplicate init scripts on a long-lived context.
const patchedContexts = new WeakSet<BrowserContext>();

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch {
    throw new LinkedInBrowserError(
      `Could not connect to Chrome at ${CDP_URL}. Launch Chrome with remote debugging enabled first, using a ` +
        `SEPARATE profile directory (current Chrome versions silently ignore --remote-debugging-port on your ` +
        `default profile) — and -n if any Chrome window is already open at all, or that instance just absorbs ` +
        `the new window and ignores the flags — e.g.: open -na "Google Chrome" --args --remote-debugging-port=9222 ` +
        `--user-data-dir="$HOME/.mydesk-linkedin-chrome-profile"`,
    );
  }
  browser.on('disconnected', () => {
    browser = null;
  });
  return browser;
}

/** Reuses an already-open LinkedIn tab when one exists rather than opening
 * a new one on every call — closer to how a real person keeps the site
 * open in one tab, and avoids silently accumulating tabs across repeated
 * actions. */
// Overloaded so callers passing `requireExistingTab: true` are typed to
// handle a `null` result, while every existing caller (which never passes
// the new second argument) keeps the old guaranteed-Page return type
// unchanged — no call site elsewhere in this codebase needed to change
// just because this one gained a new mode.
export async function getLinkedInPage(requireExistingTab?: false): Promise<Page>;
export async function getLinkedInPage(requireExistingTab: true): Promise<Page | null>;
export async function getLinkedInPage(requireExistingTab = false): Promise<Page | null> {
  const b = await getBrowser();
  const ctx: BrowserContext | undefined = b.contexts()[0];
  if (!ctx) throw new LinkedInBrowserError('Chrome is connected but has no open browser profile/context.');
  // Real, standard-mandated tell, separate from anything about IP/fingerprint
  // consistency: the W3C WebDriver spec requires navigator.webdriver to
  // read `true` on any page a CDP session is actively driving — Chrome sets
  // this itself, unconditionally, the instant a DevTools/WebDriver client
  // attaches, regardless of how "warm" or real the underlying profile is.
  // It's the single most basic, standard signal a site can check for "is
  // this page under automation," and nothing in this module patched it
  // before now. Patched on Navigator.prototype (not the `navigator`
  // instance) so it reads as an inherited property, matching how a
  // genuinely non-automated Chrome exposes it (absent on the instance,
  // `undefined` when read) — patching only the instance would itself be a
  // detectable inconsistency of exactly the kind documented elsewhere in
  // this codebase for LinkedIn's own cross-attribute checks. Applied via
  // addInitScript on the *context*, not a specific page, so it's in place
  // before any script on any current or future tab (including a reused
  // existing LinkedIn tab's next navigation) ever gets to read it.
  if (!patchedContexts.has(ctx)) {
    await ctx.addInitScript(() => {
      // Cast through globalThis rather than referencing `Navigator`
      // directly — this file's tsconfig has no `dom` lib (it's Node-only
      // backend code), so the DOM type isn't declared even though this
      // callback's body only ever actually runs in the browser, injected
      // by Playwright before page scripts execute.
      const g = globalThis as unknown as { Navigator: { prototype: Record<string, unknown> } };
      Object.defineProperty(g.Navigator.prototype, 'webdriver', {
        get: () => undefined,
        configurable: true,
      });
    });
    patchedContexts.add(ctx);
  }
  // ACCEPTED, UNMITIGATED RISK — documented here rather than "fixed,"
  // because there is no real client-side fix: chromium.connectOverCDP()
  // (getBrowser() above) necessarily sends a CDP `Runtime.enable` command
  // to instrument the page, and that command has a well-documented,
  // industry-wide detection side-effect (it changes how V8 reports certain
  // runtime timing/error-stack behavior in a way a page can observe) —
  // this affects every CDP-based automation tool (Playwright, Puppeteer,
  // Selenium's CDP mode) equally, it is not something this codebase's
  // implementation got wrong. Patching navigator.webdriver above closes
  // one specific, checkable property; it does nothing about this. A real
  // fix would mean not using CDP's Runtime domain at all, which would
  // break Playwright's own instrumentation (locators, waitFor, console
  // capture) — out of scope for this feature. Kept here as a durable note
  // so a future reader never assumes "detection-resistant" just because
  // *a* fingerprinting patch exists a few lines up.
  const existing = ctx.pages().find((p) => p.url().includes('linkedin.com'));
  if (existing) return existing;
  // Real, live-diagnosed incident this session: the old unconditional
  // version below (ctx.newPage() + goto) is exactly what made "the
  // LinkedIn window keeps turning itself back on" — a background interval
  // calling this every few minutes would silently recreate a tab the
  // account owner had deliberately closed, with no way to tell "never had
  // a tab" apart from "closed on purpose." `requireExistingTab: true`
  // (used only by the automatic scheduler/inbox-sync intervals — see
  // index.ts) makes that distinction explicit: no existing tab means
  // nothing to do this cycle, not "open one anyway." Manual, human-clicked
  // actions (the Testas tab, Pending Approval, "▶ Vykdyti dabar") keep the
  // old default (`false`) — an explicit click opening a tab on demand is
  // the normal, expected case that was never the actual problem.
  if (requireExistingTab) return null;
  const page = await ctx.newPage();
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  return page;
}

// --- Human-like interaction primitives ---
// Every one of these exists for the same reason: an instant click, a
// constant-speed mouse move, or a fixed-interval keystroke stream is
// exactly the kind of mechanical signature bot-detection looks for. None
// of this is meant to defeat detection outright (see the plan's own
// framing) — it just avoids the most obvious tells, the same "behave like
// a careful human, not a bot" principle the TZ opens with.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A jittered delay roughly centered on the midpoint of [minMs, maxMs] —
 * approximated as the mean of three uniform draws (a cheap
 * triangular-ish distribution, good enough here) rather than a uniform
 * draw across the whole range, so most delays cluster around a plausible
 * "thinking about it" pause instead of being equally likely to land at
 * either extreme. */
export async function humanDelay(minMs: number, maxMs: number): Promise<void> {
  const mean = (minMs + maxMs) / 2;
  const spread = (maxMs - minMs) / 2;
  const u = (Math.random() + Math.random() + Math.random()) / 3;
  const ms = Math.max(minMs, Math.min(maxMs, mean + (u - 0.5) * 2 * spread));
  await sleep(ms);
}

// Best-effort tracking of where humanMouseMove last left the cursor —
// Playwright exposes no getter for the CDP-side virtual mouse position, so
// this is only as accurate as "every move went through this function."
// Falls back to `target` (no deviation waypoint) the first time it's
// unknown, which just degrades to the old straight-line behavior rather
// than erroring.
let lastKnownMousePos: { x: number; y: number } | null = null;

/** Moves the mouse to `target` along a multi-step path instead of
 * Playwright's default instant jump — a real cursor doesn't teleport.
 * Security-tightening pass: a single linear interpolation start->target,
 * however many steps, still traces a perfectly straight line — this
 * session's own research into LinkedIn's pattern-based (not just
 * volume-based) enforcement flagged "mathematical precision" like that as
 * a real, named tell. Routes through one randomly-offset waypoint roughly
 * midway first, then settles on the actual target, so the overall path
 * bends slightly rather than being ruler-straight — cheap, and closer to
 * how a real hand-drawn cursor path actually looks. */
export async function humanMouseMove(page: Page, target: { x: number; y: number }): Promise<void> {
  const start = lastKnownMousePos ?? target;
  if (start.x !== target.x || start.y !== target.y) {
    const waypoint = {
      x: (start.x + target.x) / 2 + (Math.random() - 0.5) * 40,
      y: (start.y + target.y) / 2 + (Math.random() - 0.5) * 40,
    };
    await page.mouse.move(waypoint.x, waypoint.y, { steps: 6 + Math.floor(Math.random() * 6) });
  }
  const steps = 15 + Math.floor(Math.random() * 10);
  await page.mouse.move(target.x, target.y, { steps });
  lastKnownMousePos = target;
}

/** Types with per-character delay variance instead of a fill()'s
 * near-instant, perfectly even keystrokes — a real typing cadence isn't
 * constant. */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  for (const char of text) {
    await page.keyboard.type(char, { delay: 60 + Math.random() * 140 });
  }
}
