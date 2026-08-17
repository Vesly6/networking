// Zadarma's widget has no documented "dial this number" JS API (see
// Softphone.tsx/CLAUDE.md — this was already looked into for the
// per-contact 📞 buttons and confirmed absent) — this instead drives its
// actual rendered <input id="zdrm-webphone-phonenumber-input"> directly.
// Confirmed live (Playwright, inspecting the real widget DOM): the field
// is a plain, undisguised HTML input, not behind a shadow root or iframe.
//
// A plain `input.value = x` is NOT enough — the widget tracks its own
// internal state reactively and silently ignores a bare property
// assignment, since that doesn't fire the events it listens for. Setting
// through the *native* HTMLInputElement value setter (bypassing whatever
// the widget's own framework may have overridden `value` to do) and then
// dispatching a real `input` event is what makes the widget's own UI
// (and, by the same mechanism, whatever it reads when you press its own
// Call button) actually pick up the change — confirmed by checking the
// value was still there, unreset, 1.5s after injection.
//
// Undocumented and reverse-engineered: this can break silently if Zadarma
// ever renames the widget's input id or changes its internal event
// wiring, with no error to catch — there's no supported alternative to
// fall back to if it does, just the existing copy-to-clipboard button
// staying as the manual path.
const WIDGET_INPUT_ID = 'zdrm-webphone-phonenumber-input';

/** Returns true if the widget's phone input was found and set, false if
 * the widget isn't on the page at all (SOFTPHONE_ENABLED off, still
 * loading, or failed) — callers should fall back to copy-to-clipboard on
 * false rather than leaving the user with no feedback at all. */
export function insertIntoSoftphone(phoneNumber: string): boolean {
  const input = document.getElementById(WIDGET_INPUT_ID);
  if (!(input instanceof HTMLInputElement)) return false;
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (!nativeSetter) return false;
  nativeSetter.call(input, phoneNumber);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
