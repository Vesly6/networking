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
export async function getLinkedInPage(): Promise<Page> {
  const b = await getBrowser();
  const ctx: BrowserContext | undefined = b.contexts()[0];
  if (!ctx) throw new LinkedInBrowserError('Chrome is connected but has no open browser profile/context.');
  const existing = ctx.pages().find((p) => p.url().includes('linkedin.com'));
  if (existing) return existing;
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

/** Moves the mouse to `target` along a multi-step path instead of
 * Playwright's default instant jump — a real cursor doesn't teleport. */
export async function humanMouseMove(page: Page, target: { x: number; y: number }): Promise<void> {
  const steps = 15 + Math.floor(Math.random() * 10);
  await page.mouse.move(target.x, target.y, { steps });
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
