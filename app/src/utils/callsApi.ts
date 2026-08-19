import { localApiRequest } from './localApi';

// Matches Zadarma's /v1/statistics/pbx/ shape, NOT the plain
// /v1/statistics/ one — see the long comment in server/src/zadarma.ts for
// why: only this endpoint's call_id works with the recording/transcribe
// routes, and only it exposes is_recorded.
export interface CallRecord {
  call_id: string;
  sip: string;
  callstart: string;
  clid: string;
  destination: string;
  /** The number on the *other* end regardless of call direction — use this
   * for display/matching, not `destination` (which for an inbound call is
   * your own internal extension, not the caller). See the long comment on
   * extractOtherParty() in server/src/zadarma.ts. */
  otherParty: string;
  disposition: string;
  seconds: number;
  is_recorded: boolean;
}

export interface RecordingInfo {
  link?: string;
  links?: string[];
  lifetime_till?: string;
}

export interface TranscriptionResult {
  text: string;
  /** Absent until the "🤖 Summary" button is clicked — a separate, cheap
   * chat-completion call derived from `text`, not part of transcription
   * itself. See summarizeCall()/useCallsStore's `summarize` action. */
  summary?: string;
}

/** Cached in IndexedDB (db.ts) once a transcription finishes, so re-opening
 * the Calls tab or switching away and back doesn't need to re-trigger
 * (paid) transcription for a call already transcribed. */
export interface TranscriptionRecord extends TranscriptionResult {
  callId: string;
  savedAt: number;
}

export function fetchCalls(start: string, end: string): Promise<{ stats: CallRecord[] }> {
  const params = new URLSearchParams({ start, end });
  return localApiRequest(`/api/calls?${params.toString()}`);
}

export function fetchRecording(callId: string): Promise<RecordingInfo> {
  return localApiRequest(`/api/calls/${encodeURIComponent(callId)}/recording`);
}

/** Blocks until OpenAI finishes transcribing — unlike Zadarma's own
 * (async, start-then-poll) speech recognition, this is a single request. */
export function transcribeCall(callId: string): Promise<TranscriptionResult> {
  return localApiRequest(`/api/calls/${encodeURIComponent(callId)}/transcribe`, { method: 'POST' });
}

/** The transcript text is sent up, not re-fetched server-side — it's
 * already on the client (the transcribeCall() response, cached in
 * useCallsStore/IndexedDB), and the server has no transcript store of its
 * own to read it back from. */
export function summarizeCall(callId: string, text: string): Promise<{ summary: string }> {
  return localApiRequest(`/api/calls/${encodeURIComponent(callId)}/summarize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

/** Click-to-call — dials your own number (server/.env's
 * ZADARMA_CALLER_NUMBER) first, then connects you to `to` once you answer. */
export function requestCallback(to: string): Promise<{ from: string; to: string; time: number }> {
  return localApiRequest('/api/callback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to }),
  });
}

/** Sends a real SMS to `number` — a real, unrecoverable side effect the
 * instant it resolves (an actual message delivered, at Zadarma's per-SMS
 * rate), same category as requestCallback above. Only ever call this from
 * an explicit, already-confirmed user action. */
export function sendSms(number: string, message: string): Promise<{ number?: string; cost?: string; currency?: string }> {
  return localApiRequest('/api/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ number, message }),
  });
}
