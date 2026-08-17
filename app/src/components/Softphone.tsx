import { useEffect } from 'react';
import { fetchWebrtcKey } from '../utils/webrtcApi';
import { useToastStore } from '../store/useToastStore';

// Zadarma's widget loader (app/index.html) defines this on `window` — it's
// a plain classic <script>, not an npm package, so there's no type for it
// beyond what we declare ourselves.
declare global {
  interface Window {
    zadarmaWidgetFn?: (
      key: string,
      sip: string,
      skin: 'square' | 'rounded',
      lang: string,
      showNotifications: boolean,
      // A real object, not a stringified one — the dashboard-generated
      // embed snippet (My Zadarma → Settings → Integrations and API →
      // WebRTC widget integration) passes `{right:'10px',bottom:'5px'}`
      // as a literal JS object. An earlier version of this file passed a
      // string here (matching an older blog-post example, not this
      // account's actual dashboard-issued snippet) — worth remembering if
      // the widget ever silently ignores its position again.
      position: { right?: string; left?: string; top?: string; bottom?: string },
    ) => void;
  }
}

// The two loader <script> tags in index.html are plain classic scripts
// placed before our module script, so window.zadarmaWidgetFn is normally
// already defined by the time this component mounts — but network
// hiccups/ad-blockers can still make the load fail, so poll briefly
// rather than assuming it's there.
const READY_POLL_MS = 200;
const READY_TIMEOUT_MS = 8000;

// Temporarily disabled — Zadarma's own backend reports this account's
// WebRTC integration as disabled (GET .../sys/webrtc/get_sips.php returns
// {"sips":{"disabled":true},"errorCode":"integrationDisabled"}) regardless
// of anything configurable from our side (domain, SIP password, "Use
// WebRTC" toggle all confirmed correct — see the open Zadarma support
// ticket). Until support resolves that, initializing the widget only
// produces a permanent "Sip not found" console error and a red
// "integrationDisabled" banner in the corner of every page — both drawn by
// Zadarma's own script, not something we can style/catch away from our
// side. Flip this back to `true` once the ticket is resolved; nothing
// else in this file needs to change.
const SOFTPHONE_ENABLED = false;

/** Mounts Zadarma's floating WebRTC softphone widget (bottom-right corner,
 * its own dialpad/incoming-call UI) — a standalone browser phone, separate
 * from the callback-based 📞 buttons in Contacts (see CLAUDE.md: Zadarma's
 * widget has no documented "dial this number" API, so it can't be driven
 * from our own UI). Renders nothing itself; the widget draws its own DOM
 * outside React once initialized. Mount once, near the app root. */
export function Softphone() {
  const showToast = useToastStore((s) => s.show);

  useEffect(() => {
    if (!SOFTPHONE_ENABLED) return;
    // Relying on `cancelled` alone (rather than an extra "ran once" ref) is
    // what actually makes this correct under StrictMode's dev-only double
    // mount→cleanup→mount: the throwaway first run's cleanup flips its own
    // `cancelled` closure to true before the async work resolves, so it
    // never calls zadarmaWidgetFn; the second, real run gets a fresh
    // `cancelled` and completes normally. A ref-based "only once ever"
    // guard would break this, since refs (unlike effect closures) survive
    // the simulated unmount and would block the second, real run too.
    let cancelled = false;
    const start = Date.now();

    const waitForWidgetFn = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const check = () => {
          if (cancelled) return;
          if (window.zadarmaWidgetFn) {
            resolve();
          } else if (Date.now() - start > READY_TIMEOUT_MS) {
            reject(new Error('Zadarma widget script did not load'));
          } else {
            setTimeout(check, READY_POLL_MS);
          }
        };
        check();
      });

    (async () => {
      try {
        const [{ key, sip }] = await Promise.all([fetchWebrtcKey(), waitForWidgetFn()]);
        if (cancelled) return;
        window.zadarmaWidgetFn!(key, sip, 'rounded', 'en', true, { right: '20px', bottom: '20px' });
      } catch (err) {
        showToast(err instanceof Error ? `Softphone unavailable: ${err.message}` : 'Softphone unavailable');
      }
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally once per app session — re-running this on every
    // re-render would re-init the widget (and re-fetch/burn a new key)
    // for no reason.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}
