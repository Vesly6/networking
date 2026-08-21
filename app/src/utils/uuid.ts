/** Real, live-reproduced bug: `crypto.randomUUID()` is a "secure context"
 * API — browsers only expose it on `https://`, or on `http://localhost`
 * (specifically allowlisted by spec even over plain HTTP), never on a
 * plain-HTTP LAN IP like `http://192.168.x.x:5173`. Opening the app on a
 * phone via the Mac's LAN IP (documented in CLAUDE.md for exactly this
 * reason — phone access needs `VITE_API_BASE_URL` pointed at the Mac's
 * own address) threw `crypto.randomUUID is not a function` the instant
 * anything tried to generate a new id — adding a note/contact entry, a
 * row, a table, a lead — a synchronous, uncaught exception that aborted
 * the whole action with zero visible error (not even a network error,
 * since the throw happens before any request is made). Worked previously
 * only because everyone had actually been testing against `localhost` or
 * the real HTTPS deployment, both of which are secure contexts.
 *
 * `crypto.getRandomValues()` — unlike `crypto.randomUUID()` — is *not*
 * secure-context-gated and has been universally available for far
 * longer, so it's used here to build an equivalent UUID v4 by hand. */
export function randomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
