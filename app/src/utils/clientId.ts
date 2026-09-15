import { randomUUID } from './uuid';

// One id per browser tab/session (module-level, so it survives for the
// whole page lifetime but is never persisted to localStorage — a reload
// is a genuinely new "viewer" as far as live-sync self-echo suppression
// cares). Sent as the X-Client-Id header on every mutating table/row
// request (utils/localApi.ts) and as the `clientId` query param when
// opening the live-sync EventSource (utils/tableRealtime.ts), so the
// server can skip echoing a write straight back to the exact tab that
// made it — see server/src/realtime.ts's own doc comment.
const CLIENT_ID = randomUUID();

export function getClientId(): string {
  return CLIENT_ID;
}
