import { createHash, createHmac } from 'node:crypto';

const API_BASE = 'https://api.zadarma.com';

export class ZadarmaApiError extends Error {
  raw: unknown;
  constructor(message: string, raw: unknown) {
    super(message);
    this.raw = raw;
  }
}

function getCredentials(): { key: string; secret: string } {
  const key = process.env.ZADARMA_API_KEY;
  const secret = process.env.ZADARMA_API_SECRET;
  if (!key || !secret) {
    throw new Error('ZADARMA_API_KEY / ZADARMA_API_SECRET are not set — check server/.env');
  }
  return { key, secret };
}

/** Matches PHP's urlencode() (what PHP_QUERY_RFC1738 uses), which JS's
 * encodeURIComponent() does NOT: PHP additionally escapes `!'()*~` and
 * encodes spaces as `+` rather than `%20`. Zadarma's official PHP client
 * signs requests with exactly this encoding — a generic JS serializer
 * (URLSearchParams, bare encodeURIComponent) silently produces a different
 * signature for any value containing those six characters. */
function phpUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(/%20/g, '+')
    .replace(/[!'()*~]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Params must be filtered by `!== undefined` at the call site, never by
 * truthiness — `skip: 0` and `alternatives: 0` are meaningful values a
 * naive falsy-filter would silently drop. Built once and reused for both
 * signing and the actual request; never re-serialized twice. */
function buildParamsString(params: Record<string, string | number>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${phpUrlEncode(k)}=${phpUrlEncode(String(params[k]))}`)
    .join('&');
}

function sign(method: string, paramsString: string, secret: string): string {
  const md5Hash = createHash('md5').update(paramsString).digest('hex');
  const signatureString = method + paramsString + md5Hash;
  // PHP's hash_hmac('sha1', $data, $secret) defaults to $raw_output = false,
  // which returns a *hex-encoded string*, not raw bytes — and it's that hex
  // string's ASCII bytes that get base64-encoded, not the raw 20-byte HMAC
  // digest. Skipping the hex round-trip (going straight from raw digest to
  // base64) produces a completely different, wrong signature.
  const hmacHex = createHmac('sha1', secret).update(signatureString).digest('hex');
  return Buffer.from(hmacHex, 'utf-8').toString('base64');
}

async function callZadarma(
  method: string,
  params: Record<string, string | number>,
  httpMethod: 'GET' | 'PUT' | 'POST',
): Promise<any> {
  const { key, secret } = getCredentials();
  const paramsString = buildParamsString(params);
  const authHeader = `${key}:${sign(method, paramsString, secret)}`;
  const url = httpMethod === 'GET' ? `${API_BASE}${method}?${paramsString}` : `${API_BASE}${method}`;
  if (process.env.ZADARMA_DEBUG) {
    console.log('[zadarma debug]', { method, paramsString, authHeader, url });
  }

  // PUT and POST both carry the signed params as a urlencoded body — GET is
  // the only one that puts them on the query string instead.
  const isBodyMethod = httpMethod === 'PUT' || httpMethod === 'POST';
  let res: Response;
  try {
    res = await fetch(url, {
      method: httpMethod,
      headers: {
        Authorization: authHeader,
        ...(isBodyMethod ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: isBodyMethod ? paramsString : undefined,
    });
  } catch {
    throw new ZadarmaApiError('Could not reach Zadarma API', null);
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json || json.status === 'error') {
    throw new ZadarmaApiError(json?.message ?? `Zadarma request failed (HTTP ${res.status})`, json);
  }
  return json;
}

export interface CallRecord {
  call_id: string;
  sip: string;
  callstart: string;
  clid: string;
  destination: string;
  /** The number on the *other* end of the call, regardless of direction —
   * see extractOtherParty() below for why this isn't just `destination`. */
  otherParty: string;
  disposition: string;
  seconds: number;
  is_recorded: boolean;
}

// For an outbound call, `destination` IS the external number and `clid` is
// just a label for your own extension (e.g. "Extension 100"). For an
// *inbound* call, it's reversed: `destination` is your own short internal
// extension (the line being rung, e.g. "100"), and the caller's real
// number is embedded in `clid` instead, formatted like
// `"+37061200219" <+37061200219>` — note the SAME number appears twice
// (a quoted display-name part and a bracketed URI part), so a naive
// "strip every non-digit" on the whole string concatenates both
// occurrences into one doubled-up garbage string; pull out just the
// *first* digit run instead. Phone-matching against the CRM table (and
// just displaying something meaningful for incoming calls) needs
// whichever field is actually the external party, not blindly
// `destination` — a short digit count is what tells them apart, since a
// real external number always has considerably more digits than an
// internal extension.
function extractOtherParty(destination: string, clid: string): string {
  const destDigits = destination.replace(/\D/g, '');
  if (destDigits.length > 0 && destDigits.length <= 5) {
    const firstNumber = /\+?\d[\d\s().-]{5,}\d/.exec(clid);
    const clidDigits = firstNumber ? firstNumber[0].replace(/\D/g, '') : '';
    if (clidDigits.length >= 7) return clidDigits;
  }
  return destination;
}

// Deliberately /v1/statistics/pbx/, NOT the plain /v1/statistics/ — the two
// endpoints report call IDs in completely different formats
// ("6a8146e0fd8fc1013a966bd9" vs "1786857078.38121"), and only the PBX
// endpoint's call_id is what /v1/pbx/record/request/ and OpenAI
// transcription (which needs that recording) actually accept. Passing the
// plain-statistics id to those routes doesn't error loudly — it just
// returns Zadarma's generic "Requested file not found", indistinguishable
// from recording genuinely not existing. This endpoint's `is_recorded`
// flag is also why it's worth using even setting the ID mismatch aside:
// it tells the UI upfront which calls have a recording at all, instead of
// discovering that with a failed request per call.
export async function getStatistics(opts: {
  start: string;
  end: string;
  sip?: string;
  skip?: number;
  limit?: number;
}): Promise<{ stats: CallRecord[] }> {
  const { start, end, sip, skip, limit } = opts;
  const params: Record<string, string | number> = {
    start,
    end,
    ...(sip !== undefined ? { sip } : {}),
    ...(skip !== undefined ? { skip } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
  const result = await callZadarma('/v1/statistics/pbx/', params, 'GET');
  const stats: CallRecord[] = (result.stats ?? [])
    .map((c: any) => {
      // Zadarma sends `destination` as a bare JSON number (unquoted), not
      // a string, despite it being phone-number-like data — coerce here so
      // CallRecord's `string` type is actually true, not just asserted.
      const destination = String(c.destination);
      const clid = String(c.clid ?? '');
      return {
        ...c,
        destination,
        clid,
        otherParty: extractOtherParty(destination, clid),
        is_recorded: c.is_recorded === true || c.is_recorded === 'true',
      };
    })
    // Zadarma returns these oldest-first; most recent calls are what you
    // actually want to see first when checking in on today's activity.
    .sort((a: CallRecord, b: CallRecord) => (a.callstart < b.callstart ? 1 : a.callstart > b.callstart ? -1 : 0));
  return { stats };
}

export async function requestRecording(opts: {
  callId: string;
  lifetime?: number;
}): Promise<{ link?: string; links?: string[]; lifetime_till?: string }> {
  const { callId, lifetime } = opts;
  const params: Record<string, string | number> = {
    call_id: callId,
    ...(lifetime !== undefined ? { lifetime } : {}),
  };
  return callZadarma('/v1/pbx/record/request/', params, 'GET');
}

/** Click-to-call: dials `from` (your own SIP/extension) first, and once you
 * pick up, connects you to `to`. No public URL needed — this is a plain
 * outbound signed request, same as every other wrapper here. */
export async function requestCallback(opts: {
  from: string;
  to: string;
}): Promise<{ from: string; to: string; time: number }> {
  const { from, to } = opts;
  return callZadarma('/v1/request/callback/', { from, to }, 'GET');
}

/** POST /v1/sms/send/ — confirmed against Zadarma's own official PHP
 * reference client (github.com/zadarma/user-api-v1, Api.php's sendSms()):
 * `number`, `message`, optional `caller_id`. Unlike every other wrapper in
 * this file, this one has a real, unrecoverable side effect the instant it
 * succeeds (an actual SMS delivered to an actual phone, at Zadarma's
 * per-message SMS rate) — same "real-world side effect" category as
 * requestCallback above, so it should only ever fire on an explicit,
 * confirmed user action, never automatically or speculatively. `callerId`
 * must be a number already verified in the account's Sender ID settings
 * (Zadarma rejects an unverified one); omit it to send under the account's
 * default sender name. */
export async function sendSms(opts: {
  number: string;
  message: string;
  callerId?: string;
}): Promise<{ number?: string; cost?: string; currency?: string }> {
  const { number, message, callerId } = opts;
  const params: Record<string, string | number> = {
    number,
    message,
    ...(callerId !== undefined ? { caller_id: callerId } : {}),
  };
  return callZadarma('/v1/sms/send/', params, 'POST');
}

/** POST /v1/pbx/webhooks/url/ — sets the one URL Zadarma calls back to for
 * every enabled webhook event type (see setWebhookHooks below for which
 * ones fire). A one-time (or "re-run after moving hosts") admin action,
 * not something normal app usage ever needs to call — see the
 * /api/zadarma/setup-sms-webhook route in index.ts for the only caller. */
export async function setWebhookUrl(url: string): Promise<unknown> {
  return callZadarma('/v1/pbx/webhooks/url/', { url }, 'POST');
}

/** POST /v1/pbx/webhooks/hooks/ — toggles *which* event types get sent to
 * the URL set above. `sms` is what this app currently cares about
 * (confirmed by Zadarma's own support as the correct way to receive
 * incoming SMS — see CLAUDE.md's Zadarma section); the others are exposed
 * too since they're real, documented params on the same endpoint, but
 * nothing in this app currently sets them. Undefined fields are left
 * untouched by Zadarma (only the fields actually included in the request
 * get toggled), so this can be called with just `{ sms: true }` without
 * silently turning any other hook off. Values must be the literal strings
 * "true"/"false", per Zadarma's own docs — confirmed live: sending 1/0
 * (this codebase's usual boolean-as-int convention for other Zadarma
 * params) got rejected outright with a generic "Wrong parameters" error. */
export async function setWebhookHooks(opts: {
  sms?: boolean;
  numberLookup?: boolean;
  callTracking?: boolean;
  speechRecognition?: boolean;
}): Promise<unknown> {
  const b = (v: boolean) => (v ? 'true' : 'false');
  const params: Record<string, string | number> = {
    ...(opts.sms !== undefined ? { sms: b(opts.sms) } : {}),
    ...(opts.numberLookup !== undefined ? { number_lookup: b(opts.numberLookup) } : {}),
    ...(opts.callTracking !== undefined ? { call_tracking: b(opts.callTracking) } : {}),
    ...(opts.speechRecognition !== undefined ? { speech_recognition: b(opts.speechRecognition) } : {}),
  };
  return callZadarma('/v1/pbx/webhooks/hooks/', params, 'POST');
}

/** Temporary (72h-lifetime, per Zadarma's docs) key for the browser-side
 * WebRTC widget (zadarmaWidgetFn, loaded client-side from Zadarma's own
 * CDN — see app/index.html) — this is the one piece of this feature where
 * a Zadarma credential *does* reach the browser, unlike every other
 * wrapper in this file. It's scoped (a short-lived widget session token,
 * not the account's API secret) and expires in 72h, but it's still a
 * meaningfully different trust boundary than the rest of this proxy, so
 * don't casually reuse this pattern for anything else without thinking
 * through the same tradeoff again. `sip` is the PBX extension login the
 * widget should register as (see ZADARMA_WEBRTC_SIP in .env). */
export async function getWebrtcKey(sip: string): Promise<{ key: string }> {
  return callZadarma('/v1/webrtc/get_key/', { sip }, 'GET');
}

