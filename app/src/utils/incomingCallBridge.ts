import { useIncomingCallStore, type IncomingCallMatch } from '../store/useIncomingCallStore';
import { buildPhoneIndex, type PhoneIndex } from './rowPhoneIndex';
import { phoneMatchKey } from './phoneMatch';
import type { Column, Row } from '../types';

// A real, reported cause of the widget feeling unresponsive right when a
// call needs answering: buildPhoneIndex() was being rebuilt from scratch
// on *every* incoming call — for a real ~14,600-row table, that's
// iterating every row and JSON-parsing every Contacts cell synchronously
// on the main thread, at the exact moment the widget's own Answer button
// needs to respond to a click. Cached here by simple reference identity
// (columns/rows arrays are only ever replaced wholesale by useTableStore,
// never mutated in place — same assumption CallsView.tsx's own useMemo
// already relies on) so a second call against the same still-loaded table
// is a cheap map lookup, not a full rebuild.
let cachedColumns: Column[] | null = null;
let cachedRows: Row[] | null = null;
let cachedIndex: PhoneIndex | null = null;

function getPhoneIndex(columns: Column[], rows: Row[]): PhoneIndex {
  if (cachedIndex && cachedColumns === columns && cachedRows === rows) return cachedIndex;
  cachedColumns = columns;
  cachedRows = rows;
  cachedIndex = buildPhoneIndex(columns, rows);
  return cachedIndex;
}

/** Watches Zadarma's own softphone widget DOM for a live incoming call and
 * matches its caller number against the active table — on explicit
 * request ("надо чтоб афтоматом показывало мне контакт... которого ето
 * номер"). Confirmed live, against a real incoming call (see the doc
 * comment on the exact markup below) — this is the one file in this
 * feature allowed to know the widget's real structure, matching
 * softphoneBridge.ts's own established pattern for the same widget.
 *
 * Real markup captured during a live call:
 *   <input id="zdrm-webphone-phonenumber-input" disabled="disabled" class="incoming">
 *   <div class="zdrm-webphone-callername">+37061818301</div>
 *   <div class="zdrm-webphone-call-btn-ico ... zdrm-ringing"></div>
 * `.incoming` on the input (not just a populated callername div) is what
 * distinguishes an actual *incoming* call from an outgoing one the user
 * placed themselves — the callername div likely also populates for
 * outgoing calls once connected, and there's no reason to show "who is
 * this" for a number the user just dialed themselves.
 *
 * Undocumented and reverse-engineered, same caution as everywhere else
 * this app touches Zadarma's widget: no confirmed observation yet of the
 * exact markup once a call is answered or ends, so clearing the banner
 * falls back to "the .incoming class is gone" (should cover decline/
 * hangup-while-ringing) plus a fixed timeout below as a safety net for
 * whatever the post-answer state turns out to look like. */
const CLEAR_TIMEOUT_MS = 3 * 60 * 1000;
const WIDGET_POLL_MS = 300;

let observer: MutationObserver | null = null;
let widgetPollTimer: ReturnType<typeof setTimeout> | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
let lastSeenNumber: string | null = null;
let watching = false;

function matchNumber(number: string, columns: Column[], rows: Row[]): IncomingCallMatch {
  const key = phoneMatchKey(number);
  if (!key) return null;
  const { phoneToRow, phoneToContact } = getPhoneIndex(columns, rows);
  const contactMatch = phoneToContact.get(key);
  if (contactMatch) return { kind: 'contact', ...contactMatch };
  const rowMatch = phoneToRow.get(key);
  if (rowMatch) return { kind: 'row', ...rowMatch };
  return null;
}

function handleMutation(getTableState: () => { columns: Column[]; rows: Row[] }) {
  const input = document.getElementById('zdrm-webphone-phonenumber-input');
  const isIncoming = !!input?.classList.contains('incoming');
  const callerName = document.querySelector('.zdrm-webphone-callername')?.textContent?.trim() || '';

  if (isIncoming && callerName) {
    if (callerName !== lastSeenNumber) {
      lastSeenNumber = callerName;
      // Deferred a tick (setTimeout 0), not run inline in this mutation
      // callback — matching against the table (getPhoneIndex, a real,
      // possibly-not-yet-cached synchronous scan of every row for a large
      // table) has no business competing with the browser's own handling
      // of the Answer button's click right as a call starts ringing. This
      // pushes it to the next macrotask, after whatever's already pending
      // (like that click) gets its turn first.
      setTimeout(() => {
        const { columns, rows } = getTableState();
        useIncomingCallStore.getState().setIncomingCall(callerName, matchNumber(callerName, columns, rows));
      }, 0);
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = setTimeout(() => useIncomingCallStore.getState().clear(), CLEAR_TIMEOUT_MS);
    }
    return;
  }

  // Input no longer marked `.incoming` — the ring state ended (declined,
  // hung up, or missed). Clears the banner; if a call gets *answered*
  // instead and this class turns out to also drop at that point (not yet
  // confirmed against a real answered call), this would clear the banner
  // slightly early rather than keeping it through the conversation — a
  // safe failure direction (the banner disappearing a bit sooner than
  // ideal, not it lingering stale for a completely different, later
  // caller).
  if (!isIncoming && lastSeenNumber) {
    lastSeenNumber = null;
    if (clearTimer) clearTimeout(clearTimer);
    useIncomingCallStore.getState().clear();
  }
}

/** Starts watching — call once, near where the widget itself is
 * initialized (Softphone.tsx). `getTableState` is a function (not a
 * snapshot) so every match always runs against whichever table/rows are
 * current at the moment a call actually rings, not whatever was loaded
 * when watching started.
 *
 * A real, reported bug in the first version of this: the observer was
 * attached to `document.body` with `subtree: true`, meaning *every* DOM
 * mutation anywhere in this whole app (every table cell edit, every
 * re-render, everything) re-ran the callback — on a call where the user
 * genuinely couldn't get the widget's own Answer button to respond. No
 * confirmed mechanism for *why* that would interfere (Zadarma's widget
 * draws its own DOM outside React's tree entirely, so this shouldn't be
 * able to touch it), but a MutationObserver watching the *entire
 * document* for the one-time cost of "get a small, scoped subtree
 * instead" is unjustifiable regardless — this only ever needs to know
 * about mutations inside the widget's own root, never anything else on
 * the page. Scoped down to `.zdrm-webphone` specifically now, found via
 * the same short poll Softphone.tsx already uses to wait for the widget
 * script itself to finish loading. */
export function startIncomingCallWatcher(getTableState: () => { columns: Column[]; rows: Row[] }): () => void {
  if (watching) return () => {};
  watching = true;

  const attach = () => {
    const widgetRoot = document.querySelector('.zdrm-webphone');
    if (!widgetRoot) {
      widgetPollTimer = setTimeout(attach, WIDGET_POLL_MS);
      return;
    }
    observer = new MutationObserver(() => handleMutation(getTableState));
    observer.observe(widgetRoot, { childList: true, subtree: true, attributes: true, characterData: true });
  };
  attach();

  return () => {
    watching = false;
    if (widgetPollTimer) clearTimeout(widgetPollTimer);
    observer?.disconnect();
    observer = null;
    if (clearTimer) clearTimeout(clearTimer);
    lastSeenNumber = null;
  };
}
