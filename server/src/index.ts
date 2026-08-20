import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import {
  ZadarmaApiError,
  getStatistics,
  requestRecording,
  requestCallback,
  getWebrtcKey,
  sendSms,
  setWebhookUrl,
  setWebhookHooks,
} from './zadarma.js';
import { insertIncomingSms, listIncomingSms } from './smsInbox/db.js';
import { TranscriptionError, transcribeFromUrl } from './elevenlabs.js';
import {
  ContactParseError,
  parseContactText,
  SummarizeError,
  summarizeCall,
  LinkedInPersonalizeError,
  personalizeLinkedInMessage,
  LinkedInReplyError,
  suggestLinkedInReply,
} from './openai.js';
import { SerperError, searchSocialProfiles } from './serper.js';
import {
  loadTables,
  getTable,
  saveTable,
  updateTableColumns,
  updateTableName,
  deleteTable,
  loadRowsForTable,
  countRowsForTable,
  saveRow,
  saveRows,
  deleteRow,
} from './tableData/db.js';
import { AuthError, checkCredentials, issueToken, requireAuth } from './auth.js';
import { ApolloApiError, searchPeople, searchCompanies, enrichPerson, pollWebhookResult } from './apollo.js';
import { LinkedInBrowserError } from './linkedin/browser.js';
import { LinkedInPageError, getLinkedInStatus, sendConnectionRequest, replyInThread, searchLeads } from './linkedin/page.js';
import { logAction, getRecentActions } from './linkedin/db.js';
import {
  listCampaigns,
  createCampaign,
  getCampaign,
  updateCampaignStatus,
  deleteCampaign,
  listLeadsForCampaign,
  addLeads,
  deleteLead,
  updateLeadStatus,
  addSequenceStep,
  listSequenceSteps,
  updateSequenceStep,
  deleteSequenceStep,
  listConversations,
  getConversation,
  markConversationRead,
  listMessagesForConversation,
  addMessageIfNew,
} from './linkedin/db.js';
import { canSendConnect, recordConnectSent, canSendMessage, recordMessageSent, getSafetySnapshot, updateSafetySettings, setPaused } from './linkedin/safety.js';
import {
  findDueActions,
  findDueAction,
  approveAction,
  runSchedulerTick,
  applyLeadPlaceholders,
  findStaleInvites,
  withdrawInvite,
} from './linkedin/scheduler.js';
import { syncInbox } from './linkedin/inbox.js';
import { getAnalyticsSummary, getCampaignStepBreakdown, getDailyActivity } from './linkedin/analytics.js';

const PORT = Number(process.env.PORT) || 4000;
// Binds 127.0.0.1 by default — deliberately not reachable from the local
// network on a personal machine (see CLAUDE.md). A cloud host's own network
// isolation replaces that role, and most of them require listening on all
// interfaces to route traffic in at all — set HOST=0.0.0.0 in that env
// (Render and similar platforms document this).
const HOST = process.env.HOST || '127.0.0.1';
// Comma-separated list of allowed frontend origins, e.g.
// "https://crm.yourdomain.com,https://crm-preview.pages.dev" — set this in
// the hosting platform's env var UI once the frontend has a real domain.
// Falls back to the local Vite dev server origins so local dev is
// unaffected when this isn't set.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:5174'];

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());
// Zadarma's webhook deliveries (confirmed against the official PHP
// client's getWebhookEvent(), which reads $_POST) are form-encoded, not
// JSON — needed for the SMS webhook receiver below. Registering both
// parsers is safe: each only engages for its own Content-Type, so this
// doesn't change how any existing JSON route already behaves.
app.use(express.urlencoded({ extended: true }));

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Single shared account (this is a one-operator tool, not multi-tenant) —
// checkCredentials() accepts either AUTH_PASSWORD or AUTH_RECOVERY_PASSWORD
// for the same username. Logging in with the recovery password still
// issues a normal token (there's no separate "reset flow" that mutates
// server state — see CLAUDE.md for why, given this runs on a free-tier
// host with no persistent disk); the frontend just tells the user to
// update AUTH_PASSWORD in the hosting dashboard when `viaRecovery` comes
// back true, the same place every other secret in this app already lives.
app.post(
  '/api/auth/login',
  asyncHandler(async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const match = checkCredentials(username, password);
    if (!match) {
      res.status(401).json({ error: 'Neteisingas vartotojo vardas arba slaptažodis' });
      return;
    }
    res.json({ token: issueToken(username), viaRecovery: match === 'recovery' });
  }),
);

// Public on purpose, same as /health and /api/auth/login above — Apollo
// itself calls this (not our frontend), so it can't require our session
// token. webhook_url is a mandatory param whenever enrichPerson() asks
// for reveal_phone_number, but this route deliberately doesn't parse or
// store the body: GET /api/apollo/webhook/:requestId below (an
// authenticated route, polled by the frontend) retrieves the actual
// result via Apollo's own documented poll-webhook-result endpoint
// instead, which has a stable, documented response shape — unlike the
// webhook POST payload itself, which Apollo's docs don't fully specify.
app.post('/api/apollo/webhook', (_req, res) => {
  res.status(200).json({ ok: true });
});

// Zadarma's own verification handshake for POST /v1/pbx/webhooks/url/ —
// confirmed directly by Zadarma support after the earlier "Wrong
// parameters" error (see CLAUDE.md's Zadarma section for the full
// debugging trail): before accepting a URL as a valid webhook target,
// Zadarma does a plain GET against it with a `zd_echo` query param and
// requires the response body to be exactly that value, verbatim — their
// own documented example is literally `exit($_GET['zd_echo'])`. This is
// NOT the SMS payload itself (that's the POST route below); it's a
// separate, one-time-per-registration check Zadarma runs against the same
// URL before POST /api/zadarma/setup-sms-webhook's call can succeed.
// Public for the same reason as every other webhook route in this file —
// Zadarma calls this directly, it can't carry our session token.
app.get('/api/zadarma/sms-webhook', (req, res) => {
  const echo = req.query.zd_echo;
  if (typeof echo === 'string') {
    res.status(200).send(echo);
    return;
  }
  res.status(200).send('ok');
});

// Public on purpose, same as /api/apollo/webhook above — Zadarma calls this
// directly, so it can't carry our session token either. Registered via
// POST /api/zadarma/setup-sms-webhook (below the auth gate).
//
// Unlike the Apollo webhook, this one's payload shape is genuinely
// undocumented: Zadarma's own official PHP reference client
// (github.com/zadarma/user-api-v1) has no SMS event class at all — every
// other webhook type (call start/end/answer/record/...) has one, each
// defining its own exact field names and its own getSignatureString() (the
// specific fields, in a specific order, that get HMAC-signed — confirmed
// this is NOT a generic "sign the whole body" scheme, it's picked per event
// type in the client's own source). Zadarma support confirmed the SMS
// webhook exists (see CLAUDE.md's Zadarma section) but neither their public
// docs nor the client library say what an SMS event's body/field names/
// signature composition actually are.
//
// So this receiver is deliberately defensive rather than strict: it always
// saves the full raw body (whatever shape it turns out to be) so the very
// first real incoming SMS can be inspected afterward and the field-name
// guesses below corrected if they're wrong — and it does NOT reject on a
// missing/unverifiable Signature header, since the exact string Zadarma
// signs for this event type isn't known well enough to check it correctly
// yet (encodeSignature() itself — base64(hmac-sha1(secret, signatureString))
// — is known and matches this file's own sign(), but signatureString's
// composition is per-event and only known for the event types the official
// client actually implements). The Signature header's raw value is still
// saved alongside the payload for later reference.
app.post('/api/zadarma/sms-webhook', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // Best-effort field extraction — Zadarma's known webhook events name the
  // caller/callee caller_id/called_did (see NotifyStart in the official
  // client), so those are checked first; from/to/sender/msisdn/text/message
  // are generic fallbacks in case the SMS event uses different names.
  const fromNumber = str(body.caller_id) ?? str(body.from) ?? str(body.sender) ?? str(body.msisdn);
  const toNumber = str(body.called_did) ?? str(body.to) ?? str(body.destination);
  const message = str(body.text) ?? str(body.message) ?? str(body.sms);
  insertIncomingSms({
    event: str(body.event),
    fromNumber,
    toNumber,
    message,
    rawPayload: JSON.stringify(body),
    signature: str(req.headers['signature']),
  });
  res.status(200).json({ ok: true });
});

// Everything below requires a valid session token — a visitor who never
// loads the frontend at all (hits these routes directly) is blocked here
// too, not just by the login screen.
app.use(requireAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

app.get(
  '/api/calls',
  asyncHandler(async (req, res) => {
    const { start, end, sip, skip, limit } = req.query;
    if (typeof start !== 'string' || typeof end !== 'string' || !DATE_RE.test(start) || !DATE_RE.test(end)) {
      res.status(400).json({ error: 'start/end formatas turi būti „YYYY-MM-DD HH:MM:SS“' });
      return;
    }
    const startMs = Date.parse(start.replace(' ', 'T'));
    const endMs = Date.parse(end.replace(' ', 'T'));
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs - startMs > 31 * 24 * 60 * 60 * 1000) {
      res.status(400).json({ error: 'Laikotarpis negali viršyti 31 dienos' });
      return;
    }
    const result = await getStatistics({
      start,
      end,
      sip: typeof sip === 'string' ? sip : undefined,
      skip: typeof skip === 'string' ? Number(skip) : undefined,
      limit: typeof limit === 'string' ? Number(limit) : undefined,
    });
    res.json(result);
  }),
);

app.get(
  '/api/calls/:callId/recording',
  asyncHandler(async (req, res) => {
    const result = await requestRecording({ callId: req.params.callId });
    res.json(result);
  }),
);

// Single synchronous request: fetch the recording link from Zadarma,
// download the audio, send it to ElevenLabs, return the transcript text.
// Unlike Zadarma's own speech_recognition (an async job you start then
// poll), ElevenLabs' transcription endpoint blocks until it's done — so
// there's no separate "start"/"poll" pair of routes here.
app.post(
  '/api/calls/:callId/transcribe',
  asyncHandler(async (req, res) => {
    const lang = typeof req.body?.lang === 'string' ? req.body.lang : 'lt';
    const recording = await requestRecording({ callId: req.params.callId });
    const link = recording.link ?? recording.links?.[0];
    if (!link) {
      res.status(502).json({ error: 'Šiam skambučiui įrašo nėra' });
      return;
    }
    const result = await transcribeFromUrl(link, lang);
    res.json(result);
  }),
);

// The transcript text lives client-side already (the /transcribe response
// above) — sent back up here rather than re-fetched, since there's no
// server-side cache of it (that's the frontend's job, via IndexedDB's
// transcriptions store). callId is only used for the error message below.
app.post(
  '/api/calls/:callId/summarize',
  asyncHandler(async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : undefined;
    if (!text || !text.trim()) {
      res.status(400).json({ error: 'Missing "text" to summarize' });
      return;
    }
    const result = await summarizeCall(text);
    res.json(result);
  }),
);

// Click-to-call: dials your own number first, then connects you to `to`
// once you pick up. `from` defaults to ZADARMA_CALLER_NUMBER (server/.env)
// so the frontend never needs to know/hardcode which number is "yours".
app.post(
  '/api/callback',
  asyncHandler(async (req, res) => {
    const to = typeof req.body?.to === 'string' ? req.body.to : undefined;
    if (!to) {
      res.status(400).json({ error: 'Missing "to" phone number' });
      return;
    }
    const from = process.env.ZADARMA_CALLER_NUMBER;
    if (!from) {
      res.status(500).json({ error: 'ZADARMA_CALLER_NUMBER is not set — check server/.env' });
      return;
    }
    const result = await requestCallback({ from, to });
    res.json(result);
  }),
);

// Sends a real SMS the instant it's called — no confirmation/dry-run layer
// here on the server side, that's the frontend's job (a real, unrecoverable
// side effect once this fires, same category as /api/callback above).
// ZADARMA_SMS_CALLER_ID is optional: unset sends under the account's
// default sender name; set it only to a sender id already verified in
// Zadarma's own Sender ID settings, since an unverified one is rejected.
app.post(
  '/api/sms/send',
  asyncHandler(async (req, res) => {
    const number = typeof req.body?.number === 'string' ? req.body.number : undefined;
    const message = typeof req.body?.message === 'string' ? req.body.message : undefined;
    if (!number || !message) {
      res.status(400).json({ error: 'Missing "number" or "message"' });
      return;
    }
    const callerId = process.env.ZADARMA_SMS_CALLER_ID;
    const result = await sendSms({ number, message, ...(callerId ? { callerId } : {}) });
    res.json(result);
  }),
);

// One-time (or "re-run after moving hosts") admin action — registers this
// server's own /api/zadarma/sms-webhook route below as Zadarma's incoming-
// SMS callback URL. Not called automatically by anything; the frontend
// exposes a single button for it (see the Calls tab). Needs PUBLIC_BASE_URL
// (server/.env) — same var /api/apollo/people/enrich already requires for
// Apollo's phone-reveal webhook — since this obviously can't be tested
// against a local dev server (Zadarma has to be able to reach the URL over
// the public internet).
app.post(
  '/api/zadarma/setup-sms-webhook',
  asyncHandler(async (_req, res) => {
    const base = process.env.PUBLIC_BASE_URL;
    if (!base) {
      res.status(500).json({ error: 'PUBLIC_BASE_URL is not set — check server/.env (needed to register the SMS webhook)' });
      return;
    }
    await setWebhookUrl(`${base}/api/zadarma/sms-webhook`);
    await setWebhookHooks({ sms: true });
    res.json({ ok: true, url: `${base}/api/zadarma/sms-webhook` });
  }),
);

// Read side for the SMS inbox below — the frontend polls/loads this like
// any other list endpoint. See the public receiver route (above
// requireAuth) for why storage happens there instead of here.
app.get(
  '/api/sms-inbox',
  asyncHandler(async (_req, res) => {
    res.json({ messages: listIncomingSms() });
  }),
);

// Standalone browser softphone (floating widget, not tied to the Contacts
// 📞 buttons — Zadarma's widget has no documented "dial this number" JS
// API, only its own dialpad; the 📞 buttons keep using /api/callback
// above). Fetched fresh on every app load rather than cached anywhere —
// the key is only valid 72h, and a page load is cheap/infrequent enough
// that there's no reason to manage its lifetime more carefully than that.
app.get(
  '/api/webrtc/key',
  asyncHandler(async (_req, res) => {
    // Two different SIP formats for two different Zadarma calls — per
    // Zadarma support: /v1/webrtc/get_key/ itself wants the bare extension
    // ("100"), but the value actually handed to the WIDGET's own init
    // function (zadarmaWidgetFn, in Softphone.tsx) needs the fully
    // qualified "{account_id}-{extension}" form ("488048-100" for this
    // account) — using the bare extension there is what produced the
    // integrationDisabled/"Sip not found" error, not anything about the
    // domain or the key itself.
    const sip = process.env.ZADARMA_WEBRTC_SIP;
    const widgetSip = process.env.ZADARMA_WEBRTC_WIDGET_SIP;
    if (!sip || !widgetSip) {
      res.status(500).json({ error: 'ZADARMA_WEBRTC_SIP / ZADARMA_WEBRTC_WIDGET_SIP are not set — check server/.env' });
      return;
    }
    const result = await getWebrtcKey(sip);
    res.json({ key: result.key, sip: widgetSip });
  }),
);

app.post(
  '/api/contacts/parse',
  asyncHandler(async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : undefined;
    if (!text || !text.trim()) {
      res.status(400).json({ error: 'Missing "text" to parse' });
      return;
    }
    const result = await parseContactText(text);
    res.json(result);
  }),
);

// Never called automatically — only from an explicit per-contact 🔍 click
// (CellHoverEditor.tsx's SocialLookupModal), same "costs real money, needs
// an explicit click" philosophy as the Apollo enrich route and Calls'
// per-call Transcribe button above/elsewhere in this file. Backed by a
// real Google search (serper.dev) now, not an LLM asked to search and
// report back — see serper.ts's own doc comment for why that switch
// happened. `company` is still accepted for backward compatibility with
// the existing frontend request shape but no longer used server-side
// (searchSocialProfiles's own doc comment explains why narrowing the
// query by employer was dropped).
app.post(
  '/api/contacts/social-lookup',
  asyncHandler(async (req, res) => {
    const firstName = typeof req.body?.firstName === 'string' ? req.body.firstName : '';
    const lastName = typeof req.body?.lastName === 'string' ? req.body.lastName : '';
    if (!firstName.trim() && !lastName.trim()) {
      res.status(400).json({ error: 'Reikia bent vardo, kad būtų galima ieškoti' });
      return;
    }
    const result = await searchSocialProfiles({ firstName, lastName });
    res.json(result);
  }),
);

// The three Apollo routes below just forward the request body through to
// apollo.ts's typed wrappers — validation stays minimal (this is a single-
// operator tool, not a public API), the frontend's filter panel is
// responsible for building a well-formed body. Free to call (0 credits).
app.post(
  '/api/apollo/people/search',
  asyncHandler(async (req, res) => {
    const result = await searchPeople(req.body ?? {});
    res.json(result);
  }),
);

// Costs Apollo credits — "1 credit per page" (up to 100 results), unlike
// people search above. The frontend surfaces this before calling it (see
// SearchView.tsx) rather than the server silently spending money on every
// keystroke of a filter form.
app.post(
  '/api/apollo/companies/search',
  asyncHandler(async (req, res) => {
    const result = await searchCompanies(req.body ?? {});
    res.json(result);
  }),
);

// Costs Apollo credits (1 for email, +8 more for a phone number) — this is
// the one Apollo route in the whole app that's never called automatically,
// only from an explicit "Find email"/"Find phone" click per person, same
// philosophy as Calls' manual per-call "Transcribe" button (CLAUDE.md).
// webhook_url is filled in here, not left to the frontend, whenever
// reveal_phone_number is requested — it's a mandatory Apollo param at
// that point, and the frontend has no business knowing this server's own
// public URL (PUBLIC_BASE_URL, only meaningful once actually deployed;
// see the /api/apollo/webhook route above for why the URL only needs to
// exist and 200, not actually process anything).
app.post(
  '/api/apollo/people/enrich',
  asyncHandler(async (req, res) => {
    const body = { ...(req.body ?? {}) };
    if (body.reveal_phone_number) {
      const base = process.env.PUBLIC_BASE_URL;
      if (!base) {
        res.status(500).json({ error: 'PUBLIC_BASE_URL is not set — check server/.env (needed for phone reveal)' });
        return;
      }
      body.webhook_url = `${base}/api/apollo/webhook`;
    }
    const result = await enrichPerson(body);
    res.json(result);
  }),
);

// Polled by the frontend after a reveal_phone_number=true enrichPerson()
// call, using the request_id from that response — see pollWebhookResult()
// in apollo.ts for why this is used instead of actually parsing Apollo's
// webhook POST payload.
app.get(
  '/api/apollo/webhook/:requestId',
  asyncHandler(async (req, res) => {
    const result = await pollWebhookResult(req.params.requestId);
    res.json(result);
  }),
);

// --- LinkedIn (Phase 0 proved the CDP/Playwright connection works;
// Phase 1 is adding the Safety Engine below — see TZ_LinkedIn_Automation.md
// and the saved plan for the full roadmap. Campaign Engine/lead import/
// inbox/analytics are still ahead). Unlike every other integration in this
// server, there is no official LinkedIn API behind this: connectOverCDP
// attaches to the user's own real, already-logged-in Chrome and drives it
// with Playwright. Every route here is read-only or requires the frontend
// to have already shown an explicit confirm dialog before calling it — see
// CellHoverEditor's SMS-send/contact-delete confirmDialog() for the
// established pattern this follows.

app.get(
  '/api/linkedin/status',
  asyncHandler(async (_req, res) => {
    const status = await getLinkedInStatus();
    res.json(status);
  }),
);

app.get(
  '/api/linkedin/actions',
  asyncHandler(async (req, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json({ actions: getRecentActions(limit) });
  }),
);

// Sends a single, real connection request. The frontend must have already
// confirmed this with the user (a real, unrecoverable side effect the
// instant it succeeds, same category as requestCallback/sendSms elsewhere
// in this server) before ever calling this route. As of Phase 1, this also
// goes through the Safety Engine first — see safety.ts's canSendConnect():
// even a manually-triggered send respects the configured daily/weekly caps,
// work hours, warm-up ramp, and the pause switch. "No action is executed
// without going through this module" (the TZ's own Safety Engine framing)
// applies here from day one, not just once the Campaign Engine exists.
app.post(
  '/api/linkedin/test-connect',
  asyncHandler(async (req, res) => {
    const profileUrl = typeof req.body?.profileUrl === 'string' ? req.body.profileUrl : '';
    const note = typeof req.body?.note === 'string' ? req.body.note : undefined;
    if (!profileUrl.trim()) {
      res.status(400).json({ error: 'Missing "profileUrl"' });
      return;
    }
    const safetyCheck = canSendConnect();
    if (!safetyCheck.allowed) {
      res.status(429).json({ error: safetyCheck.reason ?? 'Blocked by the Safety Engine' });
      return;
    }
    const startedAt = Date.now();
    try {
      await sendConnectionRequest(profileUrl, note);
      recordConnectSent();
      logAction({
        leadId: null,
        stepId: null,
        actionType: 'connect',
        status: 'success',
        targetUrl: profileUrl,
        detail: null,
        executedAt: startedAt,
        responseTimeMs: Date.now() - startedAt,
      });
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send connection request';
      logAction({
        leadId: null,
        stepId: null,
        actionType: 'connect',
        status: 'error',
        targetUrl: profileUrl,
        detail: message,
        executedAt: startedAt,
        responseTimeMs: Date.now() - startedAt,
      });
      throw err;
    }
  }),
);

// Snapshot for the Settings panel + the always-visible status header:
// today's/this-week's counts against the *effective* (warm-up-scaled)
// caps, the pause state, and the raw settings themselves.
app.get(
  '/api/linkedin/safety',
  asyncHandler(async (_req, res) => {
    res.json(getSafetySnapshot());
  }),
);

// Partial update — only the keys present in the body are written (see
// updateSafetySettings()), so the Settings UI can save one field (e.g. just
// the daily cap) without resending the whole form.
app.post(
  '/api/linkedin/safety/settings',
  asyncHandler(async (req, res) => {
    updateSafetySettings(req.body ?? {});
    res.json(getSafetySnapshot());
  }),
);

// The always-visible "⏸ Stop everything" control's backend — deliberately
// its own route rather than folded into the settings form, so it's never
// more than one click away regardless of which sub-view is open (the
// plan's own critique of the raw TZ: a kill switch buried in Settings
// isn't fast enough for "the whole premise is stopping the instant
// something looks off").
app.post(
  '/api/linkedin/pause',
  asyncHandler(async (req, res) => {
    const paused = req.body?.paused !== false;
    setPaused(paused);
    res.json(getSafetySnapshot());
  }),
);

// --- Campaigns/leads (Phase 1 data layer — no Scheduler executing
// sequence_steps yet, see the saved plan). Purely local data (SQLite),
// no LinkedIn side effect from any route below — deleting a campaign
// only removes local rows, the same "safe, reversible, local data" as
// deleting a table in this app's own main Table view.
app.get(
  '/api/linkedin/campaigns',
  asyncHandler(async (_req, res) => {
    res.json({ campaigns: listCampaigns() });
  }),
);

app.post(
  '/api/linkedin/campaigns',
  asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'Missing "name"' });
      return;
    }
    res.json(createCampaign(name));
  }),
);

app.get(
  '/api/linkedin/campaigns/:id',
  asyncHandler(async (req, res) => {
    const campaign = getCampaign(req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    res.json(campaign);
  }),
);

app.patch(
  '/api/linkedin/campaigns/:id/status',
  asyncHandler(async (req, res) => {
    const status = req.body?.status;
    if (!['draft', 'active', 'paused', 'completed'].includes(status)) {
      res.status(400).json({ error: 'Invalid "status"' });
      return;
    }
    updateCampaignStatus(req.params.id, status);
    const campaign = getCampaign(req.params.id);
    if (!campaign) {
      res.status(404).json({ error: 'Campaign not found' });
      return;
    }
    res.json(campaign);
  }),
);

app.delete(
  '/api/linkedin/campaigns/:id',
  asyncHandler(async (req, res) => {
    deleteCampaign(req.params.id);
    res.json({ ok: true });
  }),
);

app.get(
  '/api/linkedin/campaigns/:id/leads',
  asyncHandler(async (req, res) => {
    res.json({ leads: listLeadsForCampaign(req.params.id) });
  }),
);

// Bulk add — the frontend has already parsed/mapped a CSV client-side
// (same "parse, then an explicit mapping step, never silent auto-import"
// principle CsvImportMapping.tsx already established for the main table)
// and sends the resolved lead objects directly; nothing here re-parses a
// file.
app.post(
  '/api/linkedin/campaigns/:id/leads',
  asyncHandler(async (req, res) => {
    const leads = Array.isArray(req.body?.leads) ? req.body.leads : [];
    const inserted = addLeads(req.params.id, leads);
    res.json({ inserted });
  }),
);

app.delete(
  '/api/linkedin/leads/:id',
  asyncHandler(async (req, res) => {
    deleteLead(req.params.id);
    res.json({ ok: true });
  }),
);

// Phase 3's "simple scraper of search results, not deep crawling" (per
// TZ_LinkedIn_Automation.md) — a *read-only* LinkedIn interaction (no
// connect/message fired), same safety profile as the already-running
// background inbox sync. Returns candidates only; nothing gets added to a
// campaign until the frontend's own review step (LeadSearchImport.tsx)
// calls the existing POST .../leads above, same "review before import"
// rule CSV import already follows.
app.post(
  '/api/linkedin/search-leads',
  asyncHandler(async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      res.status(400).json({ error: 'Missing "query"' });
      return;
    }
    const results = await searchLeads(query);
    res.json({ results });
  }),
);

// Manual status override — currently only used for "skip" (permanently
// removes a lead from further sequence consideration without deleting
// its local record/history) from the Pending Approval panel, but general
// enough to also support marking a lead 'connected' by hand until the
// Inbox/reply-watcher piece exists to detect that automatically.
app.patch(
  '/api/linkedin/leads/:id/status',
  asyncHandler(async (req, res) => {
    const status = req.body?.status;
    if (!['new', 'connected', 'pending', 'replied', 'skipped', 'withdrawn'].includes(status)) {
      res.status(400).json({ error: 'Invalid "status"' });
      return;
    }
    updateLeadStatus(req.params.id, status);
    res.json({ ok: true });
  }),
);

// --- Sequence steps + Scheduler (the Campaign Engine — see scheduler.ts
// for the actual due-work/execute logic). Every executed step still goes
// through the Safety Engine at the moment it fires, same as the manual
// test-connect route above — nothing here bypasses it.

app.get(
  '/api/linkedin/campaigns/:id/steps',
  asyncHandler(async (req, res) => {
    res.json({ steps: listSequenceSteps(req.params.id) });
  }),
);

app.post(
  '/api/linkedin/campaigns/:id/steps',
  asyncHandler(async (req, res) => {
    const type = req.body?.type;
    if (type !== 'connect' && type !== 'message') {
      res.status(400).json({ error: 'Invalid "type" — must be "connect" or "message"' });
      return;
    }
    const delayDays = Number(req.body?.delayDays);
    if (!Number.isFinite(delayDays) || delayDays < 0) {
      res.status(400).json({ error: 'Invalid "delayDays"' });
      return;
    }
    const messageTemplate = typeof req.body?.messageTemplate === 'string' ? req.body.messageTemplate : null;
    res.json(addSequenceStep(req.params.id, type, delayDays, messageTemplate));
  }),
);

app.patch(
  '/api/linkedin/steps/:id',
  asyncHandler(async (req, res) => {
    const patch: { delayDays?: number; messageTemplate?: string | null } = {};
    if (req.body?.delayDays !== undefined) {
      const delayDays = Number(req.body.delayDays);
      if (!Number.isFinite(delayDays) || delayDays < 0) {
        res.status(400).json({ error: 'Invalid "delayDays"' });
        return;
      }
      patch.delayDays = delayDays;
    }
    if (req.body?.messageTemplate !== undefined) {
      patch.messageTemplate = typeof req.body.messageTemplate === 'string' ? req.body.messageTemplate : null;
    }
    updateSequenceStep(req.params.id, patch);
    res.json({ ok: true });
  }),
);

app.delete(
  '/api/linkedin/steps/:id',
  asyncHandler(async (req, res) => {
    deleteSequenceStep(req.params.id);
    res.json({ ok: true });
  }),
);

// What's due right now, without executing anything — the Pending
// Approval list's data source when manual review is on (the default).
app.get(
  '/api/linkedin/scheduler/pending',
  asyncHandler(async (_req, res) => {
    res.json({ due: findDueActions() });
  }),
);

// Executes exactly one due action, re-verified as still-due at this
// moment (see approveAction()'s own doc comment) — the frontend's
// "Approve & send" button per pending item. A real, unrecoverable side
// effect against an actual LinkedIn profile the instant it succeeds.
app.post(
  '/api/linkedin/scheduler/approve',
  asyncHandler(async (req, res) => {
    const leadId = typeof req.body?.leadId === 'string' ? req.body.leadId : '';
    const stepId = typeof req.body?.stepId === 'string' ? req.body.stepId : '';
    if (!leadId || !stepId) {
      res.status(400).json({ error: 'Missing "leadId"/"stepId"' });
      return;
    }
    // Optional — the Pending Approval panel's own edited/AI-personalized
    // text (see /api/linkedin/personalize below), if the user reviewed and
    // possibly adjusted it before clicking approve. Omitted, this sends
    // the plain placeholder-substituted template exactly as Phase 1 did.
    const overrideMessage = typeof req.body?.overrideMessage === 'string' ? req.body.overrideMessage : undefined;
    const result = await approveAction(leadId, stepId, overrideMessage);
    res.json(result);
  }),
);

// Drafts an AI-personalized version of a due action's message for the
// human to review/edit *before* approving — never executes anything
// itself. 404s if the action isn't (or is no longer) due, for the same
// stale-snapshot reason approve does. Returns the plain placeholder-
// substituted base text alongside the AI version so the frontend can show
// "before" for comparison, or fall back to it if AI personalization is
// declined/unavailable.
app.post(
  '/api/linkedin/personalize',
  asyncHandler(async (req, res) => {
    const leadId = typeof req.body?.leadId === 'string' ? req.body.leadId : '';
    const stepId = typeof req.body?.stepId === 'string' ? req.body.stepId : '';
    if (!leadId || !stepId) {
      res.status(400).json({ error: 'Missing "leadId"/"stepId"' });
      return;
    }
    const action = findDueAction(leadId, stepId);
    if (!action) {
      res.status(404).json({ error: 'This action is no longer due (already handled, or conditions changed).' });
      return;
    }
    if (!action.messageTemplate?.trim()) {
      res.status(400).json({ error: 'This step has no message/note template to personalize.' });
      return;
    }
    const baseText = applyLeadPlaceholders(action.messageTemplate ?? '', {
      name: action.leadName,
      title: action.leadTitle,
      company: action.leadCompany,
    });
    const result = await personalizeLinkedInMessage({
      template: action.messageTemplate ?? '',
      firstName: action.leadName?.trim().split(/\s+/)[0] ?? null,
      lastName: action.leadName?.trim().split(/\s+/).slice(1).join(' ') || null,
      title: action.leadTitle,
      company: action.leadCompany,
      isConnectNote: action.stepType === 'connect',
    });
    res.json({ baseText, personalizedText: result.text });
  }),
);

// On-demand trigger, mainly for visibility/testing — the same tick also
// runs automatically on an interval (see the bottom of this file). With
// manual review on (the default), this never executes anything itself,
// it only refreshes what's due.
app.post(
  '/api/linkedin/scheduler/run',
  asyncHandler(async (_req, res) => {
    res.json(await runSchedulerTick());
  }),
);

// --- Stale invite cleanup (Phase 3 — see scheduler.ts's own doc comment
// on why this is manual-only, never part of runSchedulerTick's
// auto-execute path). ---

app.get(
  '/api/linkedin/stale-invites',
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days);
    res.json({ stale: findStaleInvites(Number.isFinite(days) && days >= 0 ? days : 14) });
  }),
);

// A real, unrecoverable side effect against an actual LinkedIn invitation
// the instant it succeeds — the frontend must have already shown a
// confirm dialog, same as every other real-world action in this app.
app.post(
  '/api/linkedin/withdraw',
  asyncHandler(async (req, res) => {
    const leadId = typeof req.body?.leadId === 'string' ? req.body.leadId : '';
    if (!leadId) {
      res.status(400).json({ error: 'Missing "leadId"' });
      return;
    }
    res.json(await withdrawInvite(leadId));
  }),
);

// --- Inbox (Reply/Inbox Watcher — see inbox.ts's syncInbox for what a
// sync actually does: scrapes conversations/messages, promotes
// 'pending' leads to 'connected' once a real conversation exists, and
// auto-stops a campaign for a lead the moment a genuine reply is seen).
// Reads here serve from the local DB (already-synced data), not a live
// scrape — only /inbox/sync actually talks to Chrome.

app.get(
  '/api/linkedin/inbox',
  asyncHandler(async (_req, res) => {
    res.json({ conversations: listConversations() });
  }),
);

app.get(
  '/api/linkedin/inbox/:id/messages',
  asyncHandler(async (req, res) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    markConversationRead(req.params.id);
    res.json({ conversation, messages: listMessagesForConversation(req.params.id) });
  }),
);

// A real, unrecoverable side effect the instant it succeeds — the
// frontend must have already shown a confirm dialog before calling this,
// same as every other real-world action in this app.
app.post(
  '/api/linkedin/inbox/:id/reply',
  asyncHandler(async (req, res) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'Missing "text"' });
      return;
    }
    const check = canSendMessage();
    if (!check.allowed) {
      res.status(429).json({ error: check.reason });
      return;
    }
    const startedAt = Date.now();
    try {
      await replyInThread(conversation.participantUrl, text);
      recordMessageSent();
      addMessageIfNew(conversation.id, conversation.leadId, 'out', text, startedAt);
      logAction({
        leadId: conversation.leadId,
        stepId: null,
        actionType: 'reply',
        status: 'success',
        targetUrl: conversation.participantUrl,
        detail: null,
        executedAt: startedAt,
        responseTimeMs: Date.now() - startedAt,
      });
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send reply';
      logAction({
        leadId: conversation.leadId,
        stepId: null,
        actionType: 'reply',
        status: 'error',
        targetUrl: conversation.participantUrl,
        detail: message,
        executedAt: startedAt,
        responseTimeMs: Date.now() - startedAt,
      });
      throw err;
    }
  }),
);

// On-demand trigger, mainly for visibility/testing — the same sync also
// runs automatically on an interval (see the bottom of this file).
app.post(
  '/api/linkedin/inbox/sync',
  asyncHandler(async (_req, res) => {
    res.json(await syncInbox());
  }),
);

// Drafts a suggested reply from the conversation's already-synced message
// history — never sends anything itself, the result just lands in the
// frontend's reply textarea for the human to review/edit, same as every
// other AI-drafts-human-reviews feature in this app.
app.post(
  '/api/linkedin/inbox/:id/suggest-reply',
  asyncHandler(async (req, res) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const messages = listMessagesForConversation(req.params.id);
    const result = await suggestLinkedInReply(
      conversation.participantName,
      messages.map((m) => ({ direction: m.direction, content: m.content })),
    );
    res.json(result);
  }),
);

// --- Analytics ("basic" per the plan — see analytics.ts) ---

app.get(
  '/api/linkedin/analytics',
  asyncHandler(async (_req, res) => {
    res.json(getAnalyticsSummary());
  }),
);

app.get(
  '/api/linkedin/campaigns/:id/analytics/steps',
  asyncHandler(async (req, res) => {
    res.json({ steps: getCampaignStepBreakdown(req.params.id) });
  }),
);

app.get(
  '/api/linkedin/analytics/daily',
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days);
    res.json({ days: getDailyActivity(Number.isFinite(days) && days > 0 ? days : 30) });
  }),
);

// --- Table/CRM data (server/src/tableData/db.ts) — the main spreadsheet
// data, moved server-side so the same tables/rows are visible from every
// device, not just whichever browser's IndexedDB happened to hold them
// (a real, reported bug: 14,000 real contacts on the Mac, zero on the
// phone). Mirrors app/src/db/db.ts's own function names/signatures 1:1 —
// that file's public functions were rewritten to call these routes
// instead of `idb`, so useTableStore.ts/useWorkspaceStore.ts (which only
// ever call through db.ts, never touch storage directly) needed no
// changes at all. See CLAUDE.md's own section on this migration.

app.get(
  '/api/tables',
  asyncHandler(async (_req, res) => {
    res.json({ tables: loadTables() });
  }),
);

app.post(
  '/api/tables',
  asyncHandler(async (req, res) => {
    const table = req.body;
    if (!table?.id || typeof table.name !== 'string' || !Array.isArray(table.columns)) {
      res.status(400).json({ error: 'Invalid table payload' });
      return;
    }
    saveTable(table);
    res.json({ ok: true });
  }),
);

app.get(
  '/api/tables/:id',
  asyncHandler(async (req, res) => {
    const table = getTable(req.params.id);
    if (!table) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }
    res.json(table);
  }),
);

app.patch(
  '/api/tables/:id/columns',
  asyncHandler(async (req, res) => {
    if (!Array.isArray(req.body?.columns)) {
      res.status(400).json({ error: 'Invalid "columns"' });
      return;
    }
    updateTableColumns(req.params.id, req.body.columns);
    res.json({ ok: true });
  }),
);

app.patch(
  '/api/tables/:id/name',
  asyncHandler(async (req, res) => {
    if (typeof req.body?.name !== 'string') {
      res.status(400).json({ error: 'Invalid "name"' });
      return;
    }
    updateTableName(req.params.id, req.body.name);
    res.json({ ok: true });
  }),
);

app.delete(
  '/api/tables/:id',
  asyncHandler(async (req, res) => {
    deleteTable(req.params.id);
    res.json({ ok: true });
  }),
);

app.get(
  '/api/tables/:id/rows',
  asyncHandler(async (req, res) => {
    res.json({ rows: loadRowsForTable(req.params.id) });
  }),
);

app.get(
  '/api/tables/:id/rows/count',
  asyncHandler(async (req, res) => {
    res.json({ count: countRowsForTable(req.params.id) });
  }),
);

// Bulk save — the one endpoint that actually matters for real usage at
// scale: useTableStore.ts's moveRows/insertRows/applySortOrder all rewrite
// `order` across *every* row on a single drag-reorder or sort click, so
// this has to stay one request for the whole batch, never one request per
// row (14,000 individual PUTs would make the table unusable). See
// tableData/db.ts's own saveRows() doc comment.
app.put(
  '/api/rows',
  asyncHandler(async (req, res) => {
    if (!Array.isArray(req.body?.rows)) {
      res.status(400).json({ error: 'Invalid "rows"' });
      return;
    }
    saveRows(req.body.rows);
    res.json({ ok: true });
  }),
);

app.put(
  '/api/rows/:id',
  asyncHandler(async (req, res) => {
    const row = req.body;
    if (!row?.id || row.id !== req.params.id || !row.tableId) {
      res.status(400).json({ error: 'Invalid row payload' });
      return;
    }
    saveRow(row);
    res.json({ ok: true });
  }),
);

app.delete(
  '/api/rows/:id',
  asyncHandler(async (req, res) => {
    deleteRow(req.params.id);
    res.json({ ok: true });
  }),
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AuthError) {
    console.error('Auth config error:', err.message);
    res.status(500).json({ error: err.message });
    return;
  }
  if (err instanceof ZadarmaApiError) {
    console.error('Zadarma API error:', err.message, err.raw);
    res.status(502).json({ error: err.message });
    return;
  }
  if (err instanceof TranscriptionError) {
    console.error('ElevenLabs error:', err.message);
    res.status(502).json({ error: err.message });
    return;
  }
  if (
    err instanceof ContactParseError ||
    err instanceof SummarizeError ||
    err instanceof LinkedInPersonalizeError ||
    err instanceof LinkedInReplyError
  ) {
    console.error('OpenAI error:', err.message);
    res.status(502).json({ error: err.message });
    return;
  }
  if (err instanceof ApolloApiError) {
    console.error('Apollo API error:', err.message, err.raw);
    res.status(502).json({ error: err.message });
    return;
  }
  if (err instanceof SerperError) {
    console.error('serper.dev error:', err.message);
    res.status(502).json({ error: err.message });
    return;
  }
  if (err instanceof LinkedInBrowserError || err instanceof LinkedInPageError) {
    console.error('LinkedIn automation error:', err.message);
    res.status(502).json({ error: err.message });
    return;
  }
  console.error('Unexpected server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, HOST, () => {
  console.log(`Zadarma proxy listening on http://${HOST}:${PORT}`);
});

// The Scheduler's background heartbeat — runs independently of any HTTP
// request, since a due sequence step has to fire on schedule whether or
// not the frontend tab is even open. 5 minutes: frequent enough to be
// useful, infrequent enough not to matter for a feature whose own caps
// are measured in "per day"/"per week," not "per minute." With manual
// review on (the default), this tick never executes anything on its own
// — it only refreshes the Pending Approval queue findDueActions() feeds;
// see runSchedulerTick()'s own doc comment. Errors are swallowed (logged,
// not thrown) so one bad tick can't crash the whole proxy process — the
// same reasoning CallsView's own background history sync uses on the
// frontend side for its periodic work.
const SCHEDULER_INTERVAL_MS = 5 * 60 * 1000;
setInterval(() => {
  runSchedulerTick()
    .then((result) => {
      // With manual review off, this is the one place a tripped circuit
      // breaker (checkpoint/logged-out/Chrome unreachable) becomes visible
      // at all if nobody's watching the UI — logged loudly (not just
      // swallowed like an ordinary per-lead error) since `paused` is now
      // true and every subsequent tick will silently no-op until a human
      // notices this in the server logs and resumes manually.
      if (result.circuitBreakerTripped) {
        console.error(
          'LinkedIn scheduler: circuit breaker tripped (checkpoint/logged-out/Chrome unreachable) — ' +
            'automation has been auto-paused. Resolve the issue in Chrome, then resume from the LinkedIn tab.',
        );
      }
    })
    .catch((err) => {
      console.error('LinkedIn scheduler tick failed:', err);
    });
}, SCHEDULER_INTERVAL_MS);

// The Inbox's own background heartbeat — separate from the Scheduler's
// (different concern: this reads/reconciles, the Scheduler writes/sends),
// though sharing the same "swallow errors, keep the process alive"
// reasoning. Every sync is a handful of real page navigations (the
// conversation list + one per thread), so this runs less often than the
// Scheduler tick — checking for replies every 10 minutes is plenty
// responsive for a sales inbox, and keeps this from being the thing that
// burns through the account's "looks like a human" budget on its own.
const INBOX_SYNC_INTERVAL_MS = 10 * 60 * 1000;
setInterval(() => {
  syncInbox().catch((err) => {
    console.error('LinkedIn inbox sync failed:', err);
  });
}, INBOX_SYNC_INTERVAL_MS);
