import { useEffect } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { fetchWebrtcKey } from '../utils/webrtcApi';
import { useToastStore } from '../store/useToastStore';
import { useTableStore } from '../store/useTableStore';
import { startIncomingCallWatcher } from '../utils/incomingCallBridge';
import { useSoftphoneVisibilityStore } from '../store/useSoftphoneVisibilityStore';

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

// Re-enabled — Zadarma support (ticket follow-up) identified the actual
// cause: the value passed to zadarmaWidgetFn's `sip` argument needs to be
// the fully-qualified "{account_id}-{extension}" form ("488048-100" for
// this account), not the bare extension ("100") — which is what the
// /v1/webrtc/get_key/ API call itself wants, and what this was mistakenly
// also using for the widget. Neither the domain (fixed earlier) nor
// account-level WebRTC settings were ever the issue. See
// ZADARMA_WEBRTC_WIDGET_SIP in server/.env and the /api/webrtc/key route
// in server/src/index.ts, which now returns the two different SIP values
// for their two different purposes instead of one value used for both.
const SOFTPHONE_ENABLED = true;

/** Mounts Zadarma's floating WebRTC softphone widget (bottom-right corner,
 * its own dialpad/incoming-call UI) — a standalone browser phone, separate
 * from the callback-based 📞 buttons in Contacts (see CLAUDE.md: Zadarma's
 * widget has no documented "dial this number" API, so it can't be driven
 * from our own UI). The widget itself draws its own DOM outside React once
 * initialized — this component's only own rendered output is the small
 * show/hide toggle floating near its corner (useSoftphoneVisibilityStore;
 * see App.css's `:root[data-softphone-hidden]` rule for the actual
 * hide/show mechanism, a plain CSS toggle that never touches the widget's
 * own code or styling). Mount once, near the app root. */
export function Softphone() {
  const showToast = useToastStore((s) => s.show);
  const softphoneHidden = useSoftphoneVisibilityStore((s) => s.hidden);
  const toggleSoftphoneHidden = useSoftphoneVisibilityStore((s) => s.toggle);

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
            reject(new Error('Softphone widget script did not load'));
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
        // Skin switched to 'rounded' on explicit request — position
        // ({right:'10px',bottom:'5px'}) still matches this account's real
        // dashboard-issued embed snippet, only the skin shape changed.
        // Caller-ID/number display on an incoming call is unaffected by
        // this choice either way — that's handled by Zadarma's own
        // backend, not the skin parameter.
        window.zadarmaWidgetFn!(key, sip, 'rounded', 'en', true, { right: '10px', bottom: '5px' });
      } catch (err) {
        showToast(err instanceof Error ? `Telefono programėlė nepasiekiama: ${err.message}` : 'Telefono programėlė nepasiekiama');
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

  // Watches for a live incoming call — a separate effect from the widget
  // init above (own cleanup, doesn't wait on/depend on that one
  // succeeding) so a slow or failed widget load never blocks this. Reads
  // useTableStore lazily (getState(), not a subscription) each time a call
  // actually rings, so a match always runs against whatever table is
  // currently loaded at that moment, not whatever was active when this
  // component first mounted.
  useEffect(() => {
    if (!SOFTPHONE_ENABLED) return;
    return startIncomingCallWatcher(() => {
      const { columns, rows } = useTableStore.getState();
      return { columns, rows };
    });
  }, []);

  if (!SOFTPHONE_ENABLED) return null;
  return (
    <button
      type="button"
      className="softphone-toggle"
      title={softphoneHidden ? 'Rodyti telefono programėlę' : 'Slėpti telefono programėlę'}
      onClick={toggleSoftphoneHidden}
    >
      {softphoneHidden ? <PhoneOff className="icon" size={18} /> : <Phone className="icon" size={18} />}
    </button>
  );
}
