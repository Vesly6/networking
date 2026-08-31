import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import compression from 'compression';
import cors from 'cors';
import { timingSafeEqual } from 'node:crypto';
import {
  bootstrapFirstCompanyIfNeeded,
  demoteOwnerUsers,
  getCompany,
  createCompany,
  listCompanies,
  updateCompanyFeatures,
  ALWAYS_ON_FEATURES,
  createUser,
  getUserById,
  getUserByUsername,
  listWorkers,
  updateWorker,
  deleteWorker,
  getCompanyIntegrations,
  upsertCompanyIntegrations,
  clearCompanyIntegrationField,
  recordLogin,
  listLoginLog,
  listNewsTopics,
  createNewsTopic,
  deleteNewsTopic,
  moveNewsTopic,
  markNewsLinkSeen,
  listNewsFolders,
  createNewsFolder,
  deleteNewsFolder,
  listNewsSavedItems,
  saveNewsItem,
  deleteNewsSavedItem,
  moveNewsSavedItem,
} from './accounts/db.js';
import {
  ZadarmaApiError,
  getStatistics,
  getBalance,
  getCallCosts,
  requestRecording,
  requestCallback,
  getWebrtcKey,
  sendSms,
  setWebhookUrl,
  setWebhookHooks,
} from './zadarma.js';
import { insertIncomingSms, listIncomingSms } from './smsInbox/db.js';
import { TranscriptionError, transcribeFromUrl, transcribeFromBuffer } from './elevenlabs.js';
import {
  ContactParseError,
  parseContactText,
  translateJobTitleToEnglish,
  SummarizeError,
  summarizeCall,
  LinkedInReplyError,
  suggestLinkedInReply,
} from './openai.js';
import { SerperError, searchSocialProfiles, searchNews, type SerperNewsResult } from './serper.js';
import { EmailGenerateError, generateEmail } from './anthropic.js';
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
  allTablesBelongToCompany,
  backfillCompanyId,
  listWorkerActions,
  findTimedNextActionRows,
  setTableBackupFlag,
  listBackupFlaggedTables,
  latestBackupDateUtc,
  createBackup,
  listBackupsForCompany,
  listAllBackups,
  deleteBackup,
  purgeOldBackups,
  backupToCsvText,
  restoreBackupAsNewTable,
  type WorkerRowRestriction,
} from './tableData/db.js';
import {
  AuthError,
  checkCredentials,
  issueToken,
  requireAuth,
  requirePermission,
  checkSuperAdminPassword,
  issueSuperAdminToken,
  requireSuperAdmin,
} from './auth.js';
import { ApolloApiError, searchPeople, searchCompanies, enrichPerson, pollWebhookResult } from './apollo.js';
import {
  InstantlyApiError,
  listCampaigns as listInstantlyCampaigns,
  getCampaign as getInstantlyCampaign,
  activateCampaign as activateInstantlyCampaign,
  pauseCampaign as pauseInstantlyCampaign,
  getCampaignAnalyticsOverview,
  getCampaignAnalyticsDaily,
  getCampaignsAnalyticsList,
  listLeads as listInstantlyLeads,
  createLead as createInstantlyLead,
  updateLead as updateInstantlyLead,
  deleteLead as deleteInstantlyLead,
  addToBlockList,
  listBlockList,
  removeFromBlockList,
  listAccounts as listInstantlyAccounts,
  createAccount as createInstantlyAccount,
  pauseAccount as pauseInstantlyAccount,
  resumeAccount as resumeInstantlyAccount,
  enableWarmup,
  disableWarmup,
  listEmails as listInstantlyEmails,
  replyToEmail as replyToInstantlyEmail,
  forwardEmail as forwardInstantlyEmail,
  markThreadRead,
  getUnreadCount,
  updateLeadInterestStatus,
} from './instantly.js';
import { syncInstantlyCampaignReplies } from './instantlyReplySync.js';
import { LinkedInBrowserError, humanDelay } from './linkedin/browser.js';
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
  getCampaignGraph,
  saveCampaignGraph,
  type NewSequenceNode,
  type NewSequenceEdge,
  listConversations,
  getConversation,
  markConversationRead,
  listMessagesForConversation,
  addMessageIfNew,
} from './linkedin/db.js';
import {
  canSendConnect,
  recordConnectSent,
  canSendMessage,
  recordMessageSent,
  getSafetySettings,
  getSafetySnapshot,
  updateSafetySettings,
  setPaused,
} from './linkedin/safety.js';
import { getOrCreateTodaysPlan, nextDueSlot } from './linkedin/dailyPlan.js';
import { runSchedulerTick, findStaleInvites, withdrawInvite } from './linkedin/scheduler.js';
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
// A real, reported problem: switching between tables felt "very slow,"
// most noticeably on the largest one (~14,000 rows) — GET
// /api/tables/:id/rows sends that whole table as one JSON response on
// every single switch (loadTable() always re-fetches fresh, deliberately,
// to avoid the staleness bugs a cached copy would reintroduce — see
// CLAUDE.md), and that response is several MB of highly repetitive JSON
// (the same column-id keys repeated across every row's cells_json). gzip
// compresses that kind of payload dramatically — this shrinks the actual
// bytes sent over the wire on every load/switch instead of trying to
// avoid the fetch altogether, with no behavior change and no new
// staleness risk. Placed before every route/body-parser so it compresses
// every JSON response this server sends, not just this one route.
app.use(compression());
// Express's default body-size limit is 100kb — fine for every other route
// in this app, but PUT /api/rows (the bulk row-save endpoint, saveRows()
// on the frontend) sends an entire table's rows as one JSON payload by
// design (see tableData's own doc comment — one bulk request, not one per
// row, for drag-reorder/sort/the one-time IndexedDB migration to even be
// usable on a real ~14,000-row table). A real table that size is several
// MB of JSON, well past 100kb — body-parser was rejecting it with a
// PayloadTooLargeError that the error middleware below had no specific
// case for, so it fell through to a generic, unhelpful 500 "Internal
// server error" (confirmed live: the one-time migration action failed
// this exact way against the real production table).
app.use(express.json({ limit: '50mb' }));
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

// Thrown by the requireXCreds() helpers below when a company hasn't
// configured the integration a route needs — mapped to a clean 409 by the
// error-mapping middleware near the bottom of this file, instead of the
// integration module's own fetch() throwing a confusing raw error partway
// through (an empty apiKey string reaching a real provider). This is the
// server-side enforcement that didn't exist at all before per-company
// credentials replaced the single shared server/.env — previously any
// authenticated user of any company could hit any integration route
// regardless of whether it was actually set up for them.
class IntegrationNotConfiguredError extends Error {}

// Every one of these messages used to say "enter it yourself in API
// raktai" — no longer universally true now that API-key management moved
// to owner-only (a company's own super_admin/worker can't reach that
// screen at all anymore, see WorkspaceView.tsx's own doc comment). Says
// "susisiekite su administratoriumi" instead, which is accurate
// regardless of who's actually seeing the error.
const NOT_CONFIGURED_HINT = 'susisiekite su administratoriumi, kad sukonfigūruotų API raktą.';

function requireZadarmaCreds(companyId: string): { key: string; secret: string } {
  const integrations = getCompanyIntegrations(companyId);
  if (!integrations?.zadarmaApiKey || !integrations?.zadarmaApiSecret) {
    throw new IntegrationNotConfiguredError(`Zadarma dar nesukonfigūruota — ${NOT_CONFIGURED_HINT}`);
  }
  return { key: integrations.zadarmaApiKey, secret: integrations.zadarmaApiSecret };
}

function requireInstantlyKey(companyId: string): string {
  const integrations = getCompanyIntegrations(companyId);
  if (!integrations?.instantlyApiKey) {
    throw new IntegrationNotConfiguredError(`Instantly dar nesukonfigūruota — ${NOT_CONFIGURED_HINT}`);
  }
  return integrations.instantlyApiKey;
}

function requireApolloKey(companyId: string): string {
  const integrations = getCompanyIntegrations(companyId);
  if (!integrations?.apolloApiKey) {
    throw new IntegrationNotConfiguredError(`Apollo dar nesukonfigūruota — ${NOT_CONFIGURED_HINT}`);
  }
  return integrations.apolloApiKey;
}

function requireSerperKey(companyId: string): string {
  const integrations = getCompanyIntegrations(companyId);
  if (!integrations?.serperApiKey) {
    throw new IntegrationNotConfiguredError(`Serper dar nesukonfigūruota — ${NOT_CONFIGURED_HINT}`);
  }
  return integrations.serperApiKey;
}

function requireOpenaiKey(companyId: string): string {
  const integrations = getCompanyIntegrations(companyId);
  if (!integrations?.openaiApiKey) {
    throw new IntegrationNotConfiguredError(`OpenAI dar nesukonfigūruota — ${NOT_CONFIGURED_HINT}`);
  }
  return integrations.openaiApiKey;
}

/** Returns undefined instead of throwing — the diacritic-guess step inside
 * serper.ts's searchSocialProfiles is a best-effort enhancement, not a
 * hard requirement, see that function's own doc comment. */
function optionalOpenaiKey(companyId: string): string | undefined {
  return getCompanyIntegrations(companyId)?.openaiApiKey ?? undefined;
}

function requireAnthropicKey(companyId: string): string {
  const integrations = getCompanyIntegrations(companyId);
  if (!integrations?.anthropicApiKey) {
    throw new IntegrationNotConfiguredError(`Anthropic dar nesukonfigūruota — ${NOT_CONFIGURED_HINT}`);
  }
  return integrations.anthropicApiKey;
}

function requireElevenlabsKey(companyId: string): string {
  const integrations = getCompanyIntegrations(companyId);
  if (!integrations?.elevenlabsApiKey) {
    throw new IntegrationNotConfiguredError(`ElevenLabs dar nesukonfigūruota — ${NOT_CONFIGURED_HINT}`);
  }
  return integrations.elevenlabsApiKey;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Real multi-tenant accounts now (see accounts/db.ts) — checkCredentials
// does a DB lookup + hash compare against `users` instead of matching one
// hardcoded pair. No more recovery-password concept (that existed because
// there was exactly one account); userToPublic() below is what both this
// route and /api/auth/me return, so the frontend hydrates identically
// whichever one it came from.
// enabledFeatures is a real, owner-set value again (see accounts/db.ts's
// updateCompanyFeatures — this replaced the brief "derive tabs from which
// integrations are configured" era, computeAvailableFeatures, now removed
// entirely). table/calendar are merged in unconditionally so an owner can
// never accidentally lock a company out of the app just by leaving both
// unchecked in the Funkcijos panel. Same shape (`Company &
// {enabledFeatures}`) as before, so AuthUser/App.tsx's allowedTabs logic
// needs no changes.
function companyWithFeatures(companyId: string) {
  const company = getCompany(companyId);
  if (!company) return null;
  const merged = new Set([...ALWAYS_ON_FEATURES, ...company.enabledFeatures]);
  return { ...company, enabledFeatures: [...merged] };
}

function userToPublic(user: NonNullable<ReturnType<typeof checkCredentials>>) {
  return {
    id: user.id,
    companyId: user.companyId,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    visibleTabs: user.visibleTabs,
    permissions: user.permissions,
    company: companyWithFeatures(user.companyId),
  };
}

app.post(
  '/api/auth/login',
  asyncHandler(async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const user = checkCredentials(username, password);
    if (!user) {
      res.status(401).json({ error: 'Neteisingas vartotojo vardas arba slaptažodis' });
      return;
    }
    recordLogin(user);
    res.json({ token: issueToken(user), user: userToPublic(user) });
  }),
);

// One fixed, shared secret (REGISTRATION_SECRET in server/.env) instead of
// per-company generated tokens — the owner is the only one who's ever told
// this URL exists (never surfaced in the app's own nav/UI), and controls
// who can register a new company simply by controlling who they hand the
// link to. Deliberately public (alongside /health and /api/auth/login,
// above the requireAuth gate below) — this IS the pre-auth registration
// step. Never distinguishes "wrong secret" from any other failure in its
// response — a distinct error would confirm this endpoint does something,
// which defeats the entire "nobody even knows to look" security model.
app.post(
  '/api/register',
  asyncHandler(async (req, res) => {
    const { secret, companyName, username, password, firstName, lastName } = req.body ?? {};
    const expectedSecret = process.env.REGISTRATION_SECRET;
    const genericError = () => res.status(401).json({ error: 'Neteisinga nuoroda' });
    if (!expectedSecret) {
      // Not configured — behave exactly as if the secret were wrong, not
      // as a 500. A missing env var shouldn't turn into a different,
      // more revealing response shape than a wrong guess would.
      genericError();
      return;
    }
    if (typeof secret !== 'string' || secret.length !== expectedSecret.length) {
      genericError();
      return;
    }
    const a = Buffer.from(secret);
    const b = Buffer.from(expectedSecret);
    if (!timingSafeEqual(a, b)) {
      genericError();
      return;
    }
    if (
      typeof companyName !== 'string' ||
      !companyName.trim() ||
      typeof username !== 'string' ||
      !username.trim() ||
      typeof password !== 'string' ||
      !password ||
      typeof firstName !== 'string' ||
      !firstName.trim() ||
      typeof lastName !== 'string'
    ) {
      res.status(400).json({ error: 'Užpildykite visus laukus' });
      return;
    }
    if (getUserByUsername(username.trim())) {
      res.status(400).json({ error: 'Toks vartotojo vardas jau užimtas' });
      return;
    }
    // A freshly-registered company starts with zero owner-granted features
    // (just the always-on table/calendar — see ALWAYS_ON_FEATURES) until
    // the owner visits the Admin dashboard's Funkcijos panel and grants it
    // integrations/tabs directly — see accounts/db.ts's createCompany doc
    // comment for why this is no longer self-service.
    const company = createCompany(companyName.trim());
    const user = createUser({
      companyId: company.id,
      username: username.trim(),
      password,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      role: 'super_admin',
    });
    recordLogin(user);
    res.json({ token: issueToken(user), user: userToPublic(user) });
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
  // Logged deliberately — this route previously had zero logging at all,
  // which meant a real, reported "SMS never showed up" incident had
  // nothing to check in Render's logs either way, even though Zadarma's
  // own dashboard says the webhook is registered. This at least confirms
  // whether Zadarma is contacting this URL at all (this GET verification
  // step, or the POST below).
  console.log('[sms-webhook] GET verification hit', { query: req.query, ip: req.ip });
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
  // Logged deliberately — see the GET handler's own comment above for
  // why: this route had no logging at all before, so a real "the SMS
  // never showed up" report had nothing to check in Render's logs even
  // to confirm whether Zadarma tried at all. content-type is logged
  // specifically because this receiver depends on express.json()/
  // express.urlencoded() correctly recognizing the body's real
  // Content-Type — an unexpected one would leave `body` empty even if
  // Zadarma's request otherwise arrived fine.
  console.log('[sms-webhook] POST received', {
    contentType: req.headers['content-type'],
    body,
  });
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  // Confirmed live against a real incoming SMS (found only by logging a
  // real production payload — see this route's own long doc comment
  // above for why nothing about this shape is documented anywhere):
  // Zadarma's actual SMS webhook does NOT put caller/message fields at
  // the top level at all. The real body is `{ event: 'SMS', result:
  // '<JSON-encoded string>' }`, with the fields that actually matter —
  // caller_did (this account's own number, i.e. the SMS's recipient),
  // caller_id (the sender's number), text (the message) — inside that
  // nested, *double*-encoded JSON string. Parsed first; the original
  // top-level guesses stay as fallbacks in case a different event
  // shape ever doesn't nest this way.
  let resultObj: Record<string, unknown> = {};
  if (typeof body.result === 'string') {
    try {
      resultObj = JSON.parse(body.result);
    } catch {
      // Malformed/unexpected result string — falls through to the
      // top-level fallbacks below, same behavior as before this fix.
    }
  }
  const fromNumber = str(resultObj.caller_id) ?? str(body.caller_id) ?? str(body.from) ?? str(body.sender) ?? str(body.msisdn);
  const toNumber = str(resultObj.caller_did) ?? str(body.called_did) ?? str(body.to) ?? str(body.destination);
  const message = str(resultObj.text) ?? str(body.text) ?? str(body.message) ?? str(body.sms);
  insertIncomingSms({
    event: str(body.event),
    fromNumber,
    toNumber,
    message,
    rawPayload: JSON.stringify(body),
    signature: str(req.headers['signature']),
  });
  console.log('[sms-webhook] saved to incoming_sms', { fromNumber, toNumber, message });
  res.status(200).json({ ok: true });
});

// Public, same reasoning as every other webhook route in this file —
// Instantly calls this directly, can't carry a session token. Registered
// manually in Instantly's own dashboard (Integrations → Add Webhook —
// there's no API to register it the way setup-sms-webhook does for
// Zadarma), requires Instantly's Hyper Growth plan or above.
//
// Per-company via the :companyId path segment — on explicit request, once
// the owner started onboarding real *client* companies (each with their
// own separate Instantly account/API key, via the Admin dashboard's
// per-company Integrations panel) rather than just running this for their
// own account. Instantly's own webhook payload has no field of ours to
// route by (its `workspace` is Instantly's own internal name, not
// anything we control), so the company has to be identified by the URL
// itself — same "company's own id, already an unguessable UUID, as the
// path segment" precedent already used elsewhere (e.g. backups). Each
// company gets its own distinct URL to paste into *their* Instantly
// dashboard; IntegrationsView.tsx shows it right next to where that
// company's Instantly API key is entered.
//
// The exact payload shape beyond Instantly's own documented base fields
// (timestamp, event_type, campaign_id, campaign_name, workspace) isn't
// verifiable without a real event actually firing — same situation as the
// Zadarma SMS webhook above, so this is built the same defensive way:
// always logs the raw body, never rejects on an unexpected shape, and
// treats the webhook purely as a "go re-sync this campaign now" trigger
// rather than trying to extract a full reply record from the event
// payload itself (which may not even carry the reply's own body text) —
// syncInstantlyCampaignReplies re-derives the authoritative truth from a
// real Instantly API call afterward.
const instantlyWebhookState = new Map<string, { running: boolean; rerunPending: boolean }>();

async function runInstantlyWebhookSync(companyId: string, campaignId: string) {
  const key = `${companyId}:${campaignId}`;
  const state = instantlyWebhookState.get(key) ?? { running: false, rerunPending: false };
  instantlyWebhookState.set(key, state);
  if (state.running) {
    // A sync for this exact company+campaign is already in flight (e.g.
    // several replies landed within seconds of each other) — same
    // don't-run-two-overlapping-passes reasoning as the LinkedIn
    // scheduler's own tickInProgress lock (see its doc comment: a real,
    // reproduced "4 duplicate log rows" bug from exactly this class of
    // race). Marking rerunPending instead of starting a second pass means
    // whatever arrived mid-run still gets picked up, just after the
    // current pass finishes rather than concurrently with it.
    state.rerunPending = true;
    return;
  }
  state.running = true;
  try {
    const apiKey = getCompanyIntegrations(companyId)?.instantlyApiKey ?? undefined;
    if (!apiKey) {
      console.warn('[instantly-webhook] no Instantly API key configured for company', companyId, '— skipping sync');
      return;
    }
    const result = await syncInstantlyCampaignReplies(companyId, apiKey, campaignId, 'Visi atsakymai');
    console.log('[instantly-webhook] synced campaign', campaignId, 'for company', companyId, result);
  } catch (err) {
    console.error('[instantly-webhook] sync failed for campaign', campaignId, 'company', companyId, err);
  } finally {
    state.running = false;
    if (state.rerunPending) {
      state.rerunPending = false;
      void runInstantlyWebhookSync(companyId, campaignId);
    }
  }
}

app.post('/api/instantly/webhook/:companyId', (req, res) => {
  const { companyId } = req.params;
  const body = (req.body ?? {}) as Record<string, unknown>;
  console.log('[instantly-webhook] POST received', { companyId, body });
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const eventType = str(body.event_type);
  const campaignId = str(body.campaign_id);
  // Always ack quickly — Instantly retries 3x within 30s on a failed/slow
  // response, and syncInstantlyCampaignReplies can take a while (paced,
  // rate-limited, paginated real API calls), so the actual sync runs as a
  // fire-and-forget background call rather than blocking this response.
  res.status(200).json({ ok: true });
  if (eventType !== 'reply_received' || !campaignId) {
    console.log('[instantly-webhook] ignored (not a reply_received event, or missing campaign_id)', { companyId, eventType, campaignId });
    return;
  }
  void runInstantlyWebhookSync(companyId, campaignId);
});

// --- Independent super-admin (platform-wide admin dashboard) ---------
// Deliberately public/pre-auth, same tier as /api/auth/login above — on
// explicit request, the super-admin identity is NOT tied to any regular
// company login at all ("не хочу чтоб мой аккаунт был бы как-то связан с
// супер супер админом"), so it needs its own, completely independent
// credential check rather than requiring a normal session first. See
// auth.ts's own doc comment on requireSuperAdmin/issueSuperAdminToken for
// why this is a fixed env-var pair (SUPERADMIN_USERNAME/PASSWORD), not a
// `users` table row.
app.post(
  '/api/superadmin/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string' || !checkSuperAdminPassword(username, password)) {
      res.status(401).json({ error: 'Neteisingas vartotojo vardas arba slaptažodis' });
      return;
    }
    res.json({ token: issueSuperAdminToken() });
  }),
);

// Every /api/admin/* route below is requireSuperAdmin-gated (not
// requireAuth+requireOwner — see requireSuperAdmin's own doc comment for
// why these sit up here, above the normal-session gate, rather than
// stacked on top of it) — the platform-wide view the account owner asked
// for ("CEO/founder... full control over the app and its clients"): every
// company, every company's own workers (add/remove/reset password), every
// company's integrations, per-company feature toggles, and a cross-company
// login history. Deliberately thin wrappers around the exact same
// accounts/db.ts functions the per-company routes elsewhere already use —
// a worker/integration/feature CRUD function was already scoped by an
// explicit companyId parameter, never implicitly req.auth!.companyId, so
// nothing in accounts/db.ts itself needed to change to support "any
// company," only which companyId gets passed in.

app.get(
  '/api/admin/companies',
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ companies: listCompanies() });
  }),
);

app.get(
  '/api/admin/companies/:id/workers',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    res.json({ workers: listWorkers(req.params.id) });
  }),
);

app.post(
  '/api/admin/companies/:id/workers',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { username, password, firstName, lastName, visibleTabs, permissions } = req.body ?? {};
    if (
      typeof username !== 'string' ||
      !username.trim() ||
      typeof password !== 'string' ||
      !password ||
      typeof firstName !== 'string' ||
      !firstName.trim() ||
      typeof lastName !== 'string'
    ) {
      res.status(400).json({ error: 'Užpildykite visus laukus' });
      return;
    }
    if (getUserByUsername(username.trim())) {
      res.status(400).json({ error: 'Toks vartotojo vardas jau užimtas' });
      return;
    }
    const worker = createUser({
      companyId: req.params.id,
      username: username.trim(),
      password,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      role: 'worker',
      visibleTabs: Array.isArray(visibleTabs) ? visibleTabs : [],
      permissions: permissions && typeof permissions === 'object' ? permissions : undefined,
    });
    res.json(worker);
  }),
);

app.patch(
  '/api/admin/companies/:id/workers/:userId',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { visibleTabs, permissions, password } = req.body ?? {};
    if (password !== undefined && (typeof password !== 'string' || !password)) {
      res.status(400).json({ error: 'Slaptažodis negali būti tuščias' });
      return;
    }
    const worker = updateWorker(req.params.userId, req.params.id, {
      visibleTabs: Array.isArray(visibleTabs) ? visibleTabs : undefined,
      permissions: permissions && typeof permissions === 'object' ? permissions : undefined,
      password: typeof password === 'string' ? password : undefined,
    });
    if (!worker) {
      res.status(404).json({ error: 'Worker not found' });
      return;
    }
    res.json(worker);
  }),
);

app.delete(
  '/api/admin/companies/:id/workers/:userId',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    deleteWorker(req.params.userId, req.params.id);
    res.json({ ok: true });
  }),
);

app.get(
  '/api/admin/companies/:id/integrations',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    res.json(integrationsStatus(req.params.id));
  }),
);

app.patch(
  '/api/admin/companies/:id/integrations',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    patchIntegrations(req.params.id, (req.body ?? {}) as Record<string, unknown>);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/admin/companies/:id/integrations/clear',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { field } = req.body ?? {};
    if (typeof field !== 'string' || !(INTEGRATION_FIELDS as readonly string[]).includes(field)) {
      res.status(400).json({ error: 'Invalid "field"' });
      return;
    }
    clearCompanyIntegrationField(req.params.id, field as (typeof INTEGRATION_FIELDS)[number]);
    res.json({ ok: true });
  }),
);

// Mirrors app/src/utils/tabLabels.ts's ALL_TABS exactly — the full set of
// values updateCompanyFeatures will actually accept. Filtered against
// (unrecognized strings silently dropped) rather than rejecting the whole
// request, so a future tab added on one side without the other fails
// soft instead of blocking every other checkbox in the same save. 'workers'/
// 'backups' added on explicit request — the super-admin can now hide/show
// worker management and the backups panel per company, the same way every
// other tab already works, not just tabs in the literal top nav.
const VALID_FEATURES = new Set([
  'table',
  'calendar',
  'calls',
  'search',
  'linkedin',
  'instantly',
  'email',
  'lessons',
  'news',
  'workers',
  'backups',
]);

// The full merged list (ALWAYS_ON_FEATURES + whatever's stored) — same
// shape /api/auth/me's `company.enabledFeatures` already returns, so the
// Funkcijos panel can pre-check the exact same set that field drives.
app.get(
  '/api/admin/companies/:id/features',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const company = companyWithFeatures(req.params.id);
    if (!company) {
      res.status(404).json({ error: 'Company not found' });
      return;
    }
    res.json({ enabledFeatures: company.enabledFeatures });
  }),
);

app.put(
  '/api/admin/companies/:id/features',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { enabledFeatures } = req.body ?? {};
    if (!Array.isArray(enabledFeatures) || !enabledFeatures.every((f) => typeof f === 'string')) {
      res.status(400).json({ error: 'Invalid "enabledFeatures"' });
      return;
    }
    updateCompanyFeatures(req.params.id, enabledFeatures.filter((f) => VALID_FEATURES.has(f)));
    res.json(companyWithFeatures(req.params.id));
  }),
);

app.get(
  '/api/admin/login-log',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const { companyId, limit } = req.query;
    const parsedLimit = typeof limit === 'string' ? Number(limit) : NaN;
    const effectiveLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 1000) : 300;
    res.json({ entries: listLoginLog(typeof companyId === 'string' ? companyId : undefined, effectiveLimit) });
  }),
);

// Every company's backups, for the super-admin's oversight — download/
// delete/restore are separate routes below (not the same
// /api/backups/:id/* set the per-company routes use) because those are
// hardcoded to req.auth!.companyId; the super-admin needs the *backup's
// own* company, which tableData/db.ts's functions resolve automatically
// when companyId is omitted (see backupToCsvText/deleteBackup/
// restoreBackupAsNewTable's own doc comments).
app.get(
  '/api/admin/backups',
  requireSuperAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ backups: listAllBackups() });
  }),
);

// Plain JSON — see /api/backups/:id/csv's own doc comment above for why.
app.get(
  '/api/admin/backups/:id/csv',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const result = backupToCsvText(req.params.id);
    if (!result) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }
    res.json(result);
  }),
);

app.delete(
  '/api/admin/backups/:id',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    deleteBackup(req.params.id);
    res.json({ ok: true });
  }),
);

app.post(
  '/api/admin/backups/:id/restore',
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const table = restoreBackupAsNewTable(req.params.id);
    if (!table) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }
    res.json(table);
  }),
);

// Everything below requires a valid session token — a visitor who never
// loads the frontend at all (hits these routes directly) is blocked here
// too, not just by the login screen.
app.use(requireAuth);

// Reads the current user fresh from the DB on every call (not from the
// token's own payload, which only carries userId/companyId/role) — this
// is deliberate: a super-admin changing a worker's visible tabs or
// permissions should take effect the moment the worker's app calls this
// (App.tsx does, once on mount whenever a token exists), not only after
// they next log in. AUTH_DISABLED's escape hatch (see auth.ts) still
// attaches a real req.auth for this to resolve against.
app.get(
  '/api/auth/me',
  asyncHandler(async (req, res) => {
    const user = getUserById(req.auth!.userId);
    if (!user) {
      res.status(401).json({ error: 'Neautentifikuota' });
      return;
    }
    res.json({
      id: user.id,
      companyId: user.companyId,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      visibleTabs: user.visibleTabs,
      permissions: user.permissions,
      company: companyWithFeatures(user.companyId),
    });
  }),
);

// A super-admin (or the owner, viewing their own company) manages the
// workers under their own company — a worker itself is blocked from all
// four of these, not because any single permission flag covers it, but
// because "manage other workers" was never meant to be delegable at all.
function requireNotWorker(req: Request, res: Response, next: NextFunction) {
  if (req.auth!.role === 'worker') {
    res.status(403).json({ error: 'Neturite teisės atlikti šio veiksmo' });
    return;
  }
  next();
}

app.get(
  '/api/workers',
  requireNotWorker,
  asyncHandler(async (req, res) => {
    res.json({ workers: listWorkers(req.auth!.companyId) });
  }),
);

app.post(
  '/api/workers',
  requireNotWorker,
  asyncHandler(async (req, res) => {
    const { username, password, firstName, lastName, visibleTabs, permissions } = req.body ?? {};
    if (
      typeof username !== 'string' ||
      !username.trim() ||
      typeof password !== 'string' ||
      !password ||
      typeof firstName !== 'string' ||
      !firstName.trim() ||
      typeof lastName !== 'string'
    ) {
      res.status(400).json({ error: 'Užpildykite visus laukus' });
      return;
    }
    if (getUserByUsername(username.trim())) {
      res.status(400).json({ error: 'Toks vartotojo vardas jau užimtas' });
      return;
    }
    const worker = createUser({
      companyId: req.auth!.companyId,
      username: username.trim(),
      password,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      role: 'worker',
      visibleTabs: Array.isArray(visibleTabs) ? visibleTabs : [],
      permissions: permissions && typeof permissions === 'object' ? permissions : undefined,
    });
    res.json(worker);
  }),
);

app.patch(
  '/api/workers/:id',
  requireNotWorker,
  asyncHandler(async (req, res) => {
    const { visibleTabs, permissions, password } = req.body ?? {};
    if (password !== undefined && (typeof password !== 'string' || !password)) {
      res.status(400).json({ error: 'Slaptažodis negali būti tuščias' });
      return;
    }
    const worker = updateWorker(req.params.id, req.auth!.companyId, {
      visibleTabs: Array.isArray(visibleTabs) ? visibleTabs : undefined,
      permissions: permissions && typeof permissions === 'object' ? permissions : undefined,
      password: typeof password === 'string' ? password : undefined,
    });
    if (!worker) {
      res.status(404).json({ error: 'Worker not found' });
      return;
    }
    res.json(worker);
  }),
);

app.delete(
  '/api/workers/:id',
  requireNotWorker,
  asyncHandler(async (req, res) => {
    deleteWorker(req.params.id, req.auth!.companyId);
    res.json({ ok: true });
  }),
);

// A super-admin (or owner) reads what their workers actually did — same
// requireNotWorker gate as every other /api/workers route, since this is
// clearly not something a worker should see about themselves or their
// peers. Entries are written from inside saveRow/saveRows themselves (see
// tableData/db.ts's detectWorkerActions/logWorkerActions) — nothing about
// *this* route writes anything, it's read-only. `userId` narrows to one
// worker's own history (the panel's per-worker view); omitted, it's the
// whole company's feed. No pagination beyond a flat `limit` — an audit
// log growing without a UI to page through it further wasn't asked for.
app.get(
  '/api/worker-actions',
  requireNotWorker,
  asyncHandler(async (req, res) => {
    const { userId, limit } = req.query;
    const parsedLimit = typeof limit === 'string' ? Number(limit) : NaN;
    const effectiveLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 500) : 200;
    res.json({
      actions: listWorkerActions(req.auth!.companyId, typeof userId === 'string' ? userId : undefined, effectiveLimit),
    });
  }),
);

// Super-admin (platform-wide, independent login — see requireSuperAdmin in
// auth.ts) only, entirely — no company account of any role, including the
// former "owner," self-manages its own keys anymore (previously
// requireNotWorker, then later requireOwner tied to one specific company's
// login; now genuinely independent of every company). Every company's
// integrations, including what used to be "the owner's own," are managed
// exclusively through the Admin dashboard's Integracijos panel (see
// /api/admin/companies/:id/integrations, registered above app.use(requireAuth)
// since it needs no regular company session at all) — there is no
// self-service /api/integrations route anymore.
const INTEGRATION_FIELDS = [
  'zadarmaApiKey',
  'zadarmaApiSecret',
  'zadarmaCallerNumber',
  'instantlyApiKey',
  'apolloApiKey',
  'serperApiKey',
  'openaiApiKey',
  'anthropicApiKey',
  'elevenlabsApiKey',
  'linkedinCdpUrl',
] as const;
// Real secrets are never sent back to the browser after saving — only
// whether one is set. The handful of fields here aren't actually secret
// (a phone number, a local CDP URL) so those are returned in plain text,
// pre-filled, same as any other settings form field.
const NON_SECRET_INTEGRATION_FIELDS = new Set(['zadarmaCallerNumber', 'linkedinCdpUrl']);

// Shared by the /api/admin/companies/:id/integrations routes (registered
// above app.use(requireAuth), see their own doc comment) for every company.
function integrationsStatus(companyId: string): Record<string, boolean | string | null> {
  const integrations = getCompanyIntegrations(companyId);
  const status: Record<string, boolean | string | null> = {};
  for (const field of INTEGRATION_FIELDS) {
    const value = integrations?.[field] ?? null;
    status[field] = NON_SECRET_INTEGRATION_FIELDS.has(field) ? value : !!value;
  }
  return status;
}

function patchIntegrations(companyId: string, body: Record<string, unknown>): void {
  const patch: Record<string, string> = {};
  for (const field of INTEGRATION_FIELDS) {
    const value = body[field];
    if (typeof value === 'string' && value.trim()) patch[field] = value.trim();
  }
  upsertCompanyIntegrations(companyId, patch);
}

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
    const result = await getStatistics(
      {
        start,
        end,
        sip: typeof sip === 'string' ? sip : undefined,
        skip: typeof skip === 'string' ? Number(skip) : undefined,
        limit: typeof limit === 'string' ? Number(limit) : undefined,
      },
      requireZadarmaCreds(req.auth!.companyId),
    );
    res.json(result);
  }),
);

// Not a statistics endpoint (see getBalance's own doc comment) — no
// rate-limit cooldown needed on this one, unlike /api/calls above.
app.get(
  '/api/zadarma/balance',
  asyncHandler(async (req, res) => {
    const result = await getBalance(requireZadarmaCreds(req.auth!.companyId));
    res.json(result);
  }),
);

// A second, genuinely separate hit against the same 10-req/minute
// statistics budget /api/calls already uses — see getCallCosts's own doc
// comment for why this can't just be folded into that route. Deliberately
// its own endpoint so the frontend only ever calls it from an explicit,
// separate action (CallsView's "Rodyti kainas" button), never
// automatically alongside a normal call-list load. POST, not GET, because
// it needs the caller's already-loaded PBX call list (id + callstart) in
// the body to correlate against — see getCallCosts's own doc comment for
// why a shared query-string key wasn't reliable enough against real data.
app.post(
  '/api/calls/costs',
  asyncHandler(async (req, res) => {
    const { start, end, calls } = req.body ?? {};
    if (typeof start !== 'string' || typeof end !== 'string' || !DATE_RE.test(start) || !DATE_RE.test(end)) {
      res.status(400).json({ error: 'start/end formatas turi būti „YYYY-MM-DD HH:MM:SS“' });
      return;
    }
    if (!Array.isArray(calls)) {
      res.status(400).json({ error: 'Invalid "calls"' });
      return;
    }
    const result = await getCallCosts(
      {
        start,
        end,
        calls: calls
          .filter((c): c is { call_id: unknown; callstart: unknown } => c && typeof c === 'object')
          .map((c) => ({ callId: String(c.call_id), callstart: String(c.callstart) })),
      },
      requireZadarmaCreds(req.auth!.companyId),
    );
    res.json(result);
  }),
);

app.get(
  '/api/calls/:callId/recording',
  asyncHandler(async (req, res) => {
    const result = await requestRecording({ callId: req.params.callId }, requireZadarmaCreds(req.auth!.companyId));
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
    const recording = await requestRecording({ callId: req.params.callId }, requireZadarmaCreds(req.auth!.companyId));
    const link = recording.link ?? recording.links?.[0];
    if (!link) {
      res.status(502).json({ error: 'Šiam skambučiui įrašo nėra' });
      return;
    }
    const result = await transcribeFromUrl(link, requireElevenlabsKey(req.auth!.companyId), lang);
    res.json(result);
  }),
);

// Shared by the Notes tab's 🎤 voice-note button (CellHoverEditor.tsx) and
// the Email Generator's 🎤 dictation button (EmailGeneratorView.tsx) —
// records via the browser's own MediaRecorder, base64-encodes the
// resulting audio, and posts it here (reusing the existing
// express.json({limit:'50mb'}) parser rather than standing up a separate
// multipart/raw-body route for what's normally a short clip). Same
// synchronous "transcribe and return the text" shape as /transcribe above.
//
// `lang` is optional: omitted (the Notes tab's own call, unchanged since
// before this route took a language at all) still defaults to Lithuanian
// ('lt'), on that feature's own explicit prior request — it only ever has
// one known intended language, so a picker there would be pointless. The
// Email Generator sends the literal string `'auto'` instead, which maps
// to `undefined` here — passing no language hint to transcribeFromBuffer
// is what actually triggers ElevenLabs Scribe's own language
// auto-detection (see elevenlabs.ts's own doc comment), needed there
// because an operator dictating that field genuinely switches between
// Russian/Lithuanian/English call to call, and Web Speech API's
// real-time browser recognizer (the previous approach) has no
// multi-language auto-detect mode at all — it only ever listens for one
// fixed language per session, which is why that field used to need an
// explicit RU/LT toggle in the first place.
app.post(
  '/api/notes/transcribe',
  asyncHandler(async (req, res) => {
    const audioBase64 = req.body?.audioBase64;
    const mimeType = typeof req.body?.mimeType === 'string' ? req.body.mimeType : 'audio/webm';
    if (typeof audioBase64 !== 'string' || !audioBase64) {
      res.status(400).json({ error: 'Trūksta įrašyto garso' });
      return;
    }
    const rawLang = req.body?.lang;
    const lang = rawLang === 'auto' ? undefined : typeof rawLang === 'string' ? rawLang : 'lt';
    const buffer = Buffer.from(audioBase64, 'base64');
    const result = await transcribeFromBuffer(buffer, mimeType, requireElevenlabsKey(req.auth!.companyId), lang);
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
    const result = await summarizeCall(text, requireOpenaiKey(req.auth!.companyId));
    res.json(result);
  }),
);

// Click-to-call: dials your own number first, then connects you to `to`
// once you pick up. `from` defaults to this company's own configured
// zadarmaCallerNumber (see requireZadarmaCreds below) so the frontend
// never needs to know/hardcode which number is "yours".
app.post(
  '/api/callback',
  asyncHandler(async (req, res) => {
    const to = typeof req.body?.to === 'string' ? req.body.to : undefined;
    if (!to) {
      res.status(400).json({ error: 'Missing "to" phone number' });
      return;
    }
    const creds = requireZadarmaCreds(req.auth!.companyId);
    const from = getCompanyIntegrations(req.auth!.companyId)?.zadarmaCallerNumber;
    if (!from) {
      res.status(409).json({ error: `Skambinančio numerio dar nesukonfigūruota — ${NOT_CONFIGURED_HINT}` });
      return;
    }
    const result = await requestCallback({ from, to }, creds);
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
    const result = await sendSms({ number, message, ...(callerId ? { callerId } : {}) }, requireZadarmaCreds(req.auth!.companyId));
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
  asyncHandler(async (req, res) => {
    const base = process.env.PUBLIC_BASE_URL;
    if (!base) {
      res.status(500).json({ error: 'PUBLIC_BASE_URL is not set — check server/.env (needed to register the SMS webhook)' });
      return;
    }
    const creds = requireZadarmaCreds(req.auth!.companyId);
    await setWebhookUrl(`${base}/api/zadarma/sms-webhook`, creds);
    await setWebhookHooks({ sms: true }, creds);
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
  asyncHandler(async (req, res) => {
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
    const result = await getWebrtcKey(sip, requireZadarmaCreds(req.auth!.companyId));
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
    const result = await parseContactText(text, requireOpenaiKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.post(
  '/api/search/translate-title',
  asyncHandler(async (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
    if (!title || !title.trim()) {
      res.status(400).json({ error: 'Missing "title" to translate' });
      return;
    }
    const translated = await translateJobTitleToEnglish(title.trim(), requireOpenaiKey(req.auth!.companyId));
    res.json({ title: translated ?? title.trim() });
  }),
);

// Email Generator tab (EmailGeneratorView.tsx) — ported from a standalone
// Chrome extension (Desktop/Email-Extention) that called the Anthropic API
// directly from the browser with a user-supplied key in chrome.storage.
// See anthropic.ts's own doc comment for why the key now lives here
// instead, same as every other AI provider this app already talks to.
app.post(
  '/api/email/generate',
  asyncHandler(async (req, res) => {
    const mode = req.body?.mode;
    const lang = req.body?.lang;
    const model = req.body?.model;
    const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions.trim() : '';
    if (!['new', 'reply', 'reminder'].includes(mode)) {
      res.status(400).json({ error: 'Invalid "mode" — must be "new", "reply", or "reminder"' });
      return;
    }
    if (!['lt', 'en'].includes(lang)) {
      res.status(400).json({ error: 'Invalid "lang" — must be "lt" or "en"' });
      return;
    }
    if (!['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'].includes(model)) {
      res.status(400).json({ error: 'Invalid "model"' });
      return;
    }
    if (!instructions) {
      res.status(400).json({ error: 'Missing "instructions"' });
      return;
    }
    const clientEmail = typeof req.body?.clientEmail === 'string' ? req.body.clientEmail.trim() : '';
    if (mode === 'reply' && !clientEmail) {
      res.status(400).json({ error: 'Missing "clientEmail" for reply mode' });
      return;
    }
    const clientHistory = typeof req.body?.clientHistory === 'string' ? req.body.clientHistory.trim() : '';
    if (mode === 'reminder' && !clientHistory) {
      res.status(400).json({ error: 'Missing "clientHistory" for reminder mode' });
      return;
    }
    const result = await generateEmail(
      { mode, lang, model, instructions, clientEmail, clientHistory },
      requireAnthropicKey(req.auth!.companyId),
    );
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
    const result = await searchSocialProfiles(
      { firstName, lastName },
      requireSerperKey(req.auth!.companyId),
      optionalOpenaiKey(req.auth!.companyId),
    );
    res.json(result);
  }),
);

// "Naujienos" tab's own short-lived cache, keyed by topic id (immutable
// once a topic is created, unlike its query string which nothing ever
// edits either, but id is the natural key regardless). Exists purely to
// avoid spending a real serper.dev credit on every manual "↻ Atnaujinti"
// click within a short window — a real cost concern the account owner
// raised directly, not a correctness one (a topic's News results don't
// meaningfully change minute to minute). In-memory only, module-level —
// losing it on a server restart just means the next request re-fetches
// fresh, which is fine; no need to persist it.
const NEWS_CACHE_TTL_MS = 20 * 60 * 1000;
const newsCache = new Map<string, { results: SerperNewsResult[]; fetchedAt: number }>();

async function searchNewsCached(topicId: string, query: string, apiKey: string): Promise<SerperNewsResult[]> {
  const cached = newsCache.get(topicId);
  if (cached && Date.now() - cached.fetchedAt < NEWS_CACHE_TTL_MS) {
    return cached.results;
  }
  const results = await searchNews(query, apiKey);
  newsCache.set(topicId, { results, fetchedAt: Date.now() });
  return results;
}

// "Naujienos" tab — plain CRUD over a company's saved search topics.
// Topics aren't secret (same visibility as the tab itself, which any
// authenticated company member sees once Serper is configured), so no
// requireNotWorker-style role gate here, unlike Workers/Integrations.
app.get(
  '/api/news/topics',
  asyncHandler(async (req, res) => {
    res.json({ topics: listNewsTopics(req.auth!.companyId) });
  }),
);

app.post(
  '/api/news/topics',
  asyncHandler(async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      res.status(400).json({ error: 'Reikia įvesti temą' });
      return;
    }
    const folderId = typeof req.body?.folderId === 'string' ? req.body.folderId : null;
    const topic = createNewsTopic(req.auth!.companyId, query, folderId);
    res.json(topic);
  }),
);

app.delete(
  '/api/news/topics/:id',
  asyncHandler(async (req, res) => {
    deleteNewsTopic(req.auth!.companyId, req.params.id);
    newsCache.delete(req.params.id);
    res.json({ ok: true });
  }),
);

// Re-files an already-active topic into a different folder (or `null` to
// ungroup) without touching its active/query state — distinct from
// createNewsTopic's own folder-on-reactivate path, which only applies
// when re-adding a soft-deleted topic.
app.patch(
  '/api/news/topics/:id',
  asyncHandler(async (req, res) => {
    const folderId = typeof req.body?.folderId === 'string' ? req.body.folderId : null;
    moveNewsTopic(req.auth!.companyId, req.params.id, folderId);
    res.json({ ok: true });
  }),
);

// Folders — purely organizational, group topics and/or saved articles.
// Same "no role gate" reasoning as topics above.
app.get(
  '/api/news/folders',
  asyncHandler(async (req, res) => {
    res.json({ folders: listNewsFolders(req.auth!.companyId) });
  }),
);

app.post(
  '/api/news/folders',
  asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'Reikia įvesti aplanko pavadinimą' });
      return;
    }
    res.json(createNewsFolder(req.auth!.companyId, name));
  }),
);

app.delete(
  '/api/news/folders/:id',
  asyncHandler(async (req, res) => {
    deleteNewsFolder(req.auth!.companyId, req.params.id);
    res.json({ ok: true });
  }),
);

// Bookmarked articles — a real snapshot of the article's fields at save
// time (see accounts/db.ts's news_saved_items doc comment for why), sent
// straight from the frontend's already-rendered NewsItem rather than
// re-searching serper.dev for it server-side.
app.get(
  '/api/news/saved',
  asyncHandler(async (req, res) => {
    res.json({ items: listNewsSavedItems(req.auth!.companyId) });
  }),
);

app.post(
  '/api/news/saved',
  asyncHandler(async (req, res) => {
    const link = typeof req.body?.link === 'string' ? req.body.link.trim() : '';
    if (!link) {
      res.status(400).json({ error: 'Trūksta nuorodos' });
      return;
    }
    // A saved article only exists *as* belonging to a folder (confirmed
    // with the user) — no "ungrouped saved items" bucket, unlike topics.
    // Enforced here, not just in the frontend, since the column itself
    // stays nullable (see deleteNewsFolder's own doc comment on why the
    // schema wasn't migrated).
    const folderId = typeof req.body?.folderId === 'string' ? req.body.folderId.trim() : '';
    if (!folderId) {
      res.status(400).json({ error: 'Pasirinkite aplanką, į kurį išsaugoti' });
      return;
    }
    const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const item = saveNewsItem(req.auth!.companyId, {
      folderId,
      link,
      title: str(req.body?.title),
      snippet: str(req.body?.snippet),
      source: str(req.body?.source),
      date: str(req.body?.date),
      imageUrl: str(req.body?.imageUrl),
    });
    res.json(item);
  }),
);

app.delete(
  '/api/news/saved/:id',
  asyncHandler(async (req, res) => {
    deleteNewsSavedItem(req.auth!.companyId, req.params.id);
    res.json({ ok: true });
  }),
);

app.patch(
  '/api/news/saved/:id',
  asyncHandler(async (req, res) => {
    const folderId = typeof req.body?.folderId === 'string' ? req.body.folderId : null;
    moveNewsSavedItem(req.auth!.companyId, req.params.id, folderId);
    res.json({ ok: true });
  }),
);

// One searchNews() call per saved topic, in parallel (same shape as
// searchSocialProfiles' own two-platform Promise.all above) — no topics
// configured just means an empty, valid result rather than an error, so
// the frontend's empty state ("no topics yet, add one") is what a
// brand-new company actually sees rather than a raw failure.
app.get(
  '/api/news',
  asyncHandler(async (req, res) => {
    const apiKey = requireSerperKey(req.auth!.companyId);
    // Only active topics actually get searched (and billed) — a
    // soft-deleted one stays recoverable (see deleteNewsTopic's own doc
    // comment) but shouldn't keep spending serper.dev credits while it's
    // hidden from the chip row.
    const topics = listNewsTopics(req.auth!.companyId).filter((t) => t.active);
    const perTopic = await Promise.all(
      topics.map(async (topic) => {
        const results = await searchNewsCached(topic.id, topic.query, apiKey);
        return results.map((r) => ({
          ...r,
          topicId: topic.id,
          topicQuery: topic.query,
          // markNewsLinkSeen both records the sighting and reports whether
          // this is the first one — `isNew` reflects that directly, so a
          // link already shown on an earlier visit/refresh comes back
          // false even though it's still included (full history, not a
          // self-clearing "unread" feed — confirmed with the user).
          // Un-linked items (rare — Serper occasionally omits `link`)
          // can't be tracked at all, so they're always treated as new
          // rather than silently miscounted as "seen".
          isNew: r.link ? markNewsLinkSeen(req.auth!.companyId, r.link) : true,
        }));
      }),
    );
    // Round-robin across topics rather than a real chronological sort —
    // serper.dev's `date` field is Google's own relative string ("2 hours
    // ago", "3 days ago", an absolute date for older items, ...), not a
    // consistent parseable timestamp, so sorting by it as a plain string
    // would not actually produce chronological order. Each topic's own
    // results already arrive in Google's own relevance/recency order for
    // that query; interleaving one-from-each keeps the combined list from
    // being dominated by whichever topic happens to be listed first,
    // without pretending to a precision the raw data doesn't support.
    const items: (typeof perTopic)[number] = [];
    for (let i = 0; i < Math.max(0, ...perTopic.map((r) => r.length)); i++) {
      for (const results of perTopic) {
        if (results[i]) items.push(results[i]);
      }
    }
    res.json({ items });
  }),
);

// The three Apollo routes below just forward the request body through to
// apollo.ts's typed wrappers — validation stays minimal (this is a single-
// operator tool, not a public API), the frontend's filter panel is
// responsible for building a well-formed body. Free to call (0 credits).
app.post(
  '/api/apollo/people/search',
  asyncHandler(async (req, res) => {
    const result = await searchPeople(req.body ?? {}, requireApolloKey(req.auth!.companyId));
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
    const result = await searchCompanies(req.body ?? {}, requireApolloKey(req.auth!.companyId));
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
    const result = await enrichPerson(body, requireApolloKey(req.auth!.companyId));
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
    const result = await pollWebhookResult(req.params.requestId, requireApolloKey(req.auth!.companyId));
    res.json(result);
  }),
);

// --- Instantly (cold-email campaigns/leads/mailboxes/Unibox) — a plain
// typed proxy over instantly.ts, same shape as the Apollo routes above:
// validation stays minimal (single-operator tool), the frontend builds a
// well-formed request and this just forwards it with the API key attached
// server-side.

app.get(
  '/api/instantly/campaigns',
  asyncHandler(async (req, res) => {
    const { limit, starting_after, search, status } = req.query;
    const result = await listInstantlyCampaigns(
      {
        limit: limit ? Number(limit) : undefined,
        starting_after: typeof starting_after === 'string' ? starting_after : undefined,
        search: typeof search === 'string' ? search : undefined,
        status: status ? Number(status) : undefined,
      },
      requireInstantlyKey(req.auth!.companyId),
    );
    res.json(result);
  }),
);

app.get(
  '/api/instantly/campaigns/analytics/overview',
  asyncHandler(async (req, res) => {
    const { id, start_date, end_date } = req.query;
    const result = await getCampaignAnalyticsOverview(
      {
        id: typeof id === 'string' ? id : undefined,
        start_date: typeof start_date === 'string' ? start_date : undefined,
        end_date: typeof end_date === 'string' ? end_date : undefined,
      },
      requireInstantlyKey(req.auth!.companyId),
    );
    res.json(result);
  }),
);

app.get(
  '/api/instantly/campaigns/analytics/daily',
  asyncHandler(async (req, res) => {
    const { campaign_id, start_date, end_date } = req.query;
    const result = await getCampaignAnalyticsDaily(
      {
        campaign_id: typeof campaign_id === 'string' ? campaign_id : undefined,
        start_date: typeof start_date === 'string' ? start_date : undefined,
        end_date: typeof end_date === 'string' ? end_date : undefined,
      },
      requireInstantlyKey(req.auth!.companyId),
    );
    res.json(result);
  }),
);

// Plural /list suffix specifically to avoid colliding with the existing
// singular-style /campaigns/analytics/overview and .../daily routes above.
app.get(
  '/api/instantly/campaigns/analytics/list',
  asyncHandler(async (req, res) => {
    const { start_date, end_date } = req.query;
    const result = await getCampaignsAnalyticsList(
      {
        start_date: typeof start_date === 'string' ? start_date : undefined,
        end_date: typeof end_date === 'string' ? end_date : undefined,
      },
      requireInstantlyKey(req.auth!.companyId),
    );
    res.json(result);
  }),
);

app.get(
  '/api/instantly/campaigns/:id',
  asyncHandler(async (req, res) => {
    const result = await getInstantlyCampaign(req.params.id, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

// Real, live effect on the account's actual sending — the frontend gates
// this behind an explicit button click, no confirmDialog (pausing/
// resuming an existing campaign is the same category of action as this
// app's own toolbar toggles, not a destructive one).
app.post(
  '/api/instantly/campaigns/:id/activate',
  asyncHandler(async (req, res) => {
    const result = await activateInstantlyCampaign(req.params.id, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.post(
  '/api/instantly/campaigns/:id/pause',
  asyncHandler(async (req, res) => {
    const result = await pauseInstantlyCampaign(req.params.id, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.post(
  '/api/instantly/leads/list',
  asyncHandler(async (req, res) => {
    const result = await listInstantlyLeads(req.body ?? {}, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.post(
  '/api/instantly/leads',
  asyncHandler(async (req, res) => {
    const result = await createInstantlyLead(req.body ?? {}, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.patch(
  '/api/instantly/leads/:id',
  asyncHandler(async (req, res) => {
    const result = await updateInstantlyLead(req.params.id, req.body ?? {}, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.delete(
  '/api/instantly/leads/:id',
  asyncHandler(async (req, res) => {
    const result = await deleteInstantlyLead(req.params.id, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

// The real "unsubscribe" mechanism — see instantly.ts's own doc comment
// on why this (not lt_interest_status) is what Instantly's web app itself
// calls "Unsubscribe". Close to permanent, so the frontend guards this
// behind confirmDialog() before ever calling it.
app.post(
  '/api/instantly/block-list',
  asyncHandler(async (req, res) => {
    const { bl_value } = req.body ?? {};
    if (!bl_value || typeof bl_value !== 'string') {
      res.status(400).json({ error: 'bl_value (email or domain) is required' });
      return;
    }
    const result = await addToBlockList(bl_value, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.get(
  '/api/instantly/block-list',
  asyncHandler(async (req, res) => {
    const { limit, starting_after, search } = req.query;
    const result = await listBlockList(
      {
        limit: limit ? Number(limit) : undefined,
        starting_after: typeof starting_after === 'string' ? starting_after : undefined,
        search: typeof search === 'string' ? search : undefined,
      },
      requireInstantlyKey(req.auth!.companyId),
    );
    res.json(result);
  }),
);

app.delete(
  '/api/instantly/block-list/:id',
  asyncHandler(async (req, res) => {
    const result = await removeFromBlockList(req.params.id, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.get(
  '/api/instantly/accounts',
  asyncHandler(async (req, res) => {
    const { limit, starting_after, search, status } = req.query;
    const result = await listInstantlyAccounts(
      {
        limit: limit ? Number(limit) : undefined,
        starting_after: typeof starting_after === 'string' ? starting_after : undefined,
        search: typeof search === 'string' ? search : undefined,
        status: status ? Number(status) : undefined,
      },
      requireInstantlyKey(req.auth!.companyId),
    );
    res.json(result);
  }),
);

// Custom SMTP/IMAP only (provider_code 1) — see instantly.ts's own doc
// comment on CreateAccountBody for why Gmail/Outlook OAuth isn't built
// here. Misconfigured credentials can disrupt real sending, so the
// frontend's add-mailbox form is the one place validating every field is
// present before this is ever called.
app.post(
  '/api/instantly/accounts',
  asyncHandler(async (req, res) => {
    const result = await createInstantlyAccount(req.body ?? {}, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.post(
  '/api/instantly/accounts/:email/pause',
  asyncHandler(async (req, res) => {
    const result = await pauseInstantlyAccount(req.params.email, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.post(
  '/api/instantly/accounts/:email/resume',
  asyncHandler(async (req, res) => {
    const result = await resumeInstantlyAccount(req.params.email, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.post(
  '/api/instantly/accounts/warmup/enable',
  asyncHandler(async (req, res) => {
    const { emails } = req.body ?? {};
    if (!Array.isArray(emails) || emails.length === 0) {
      res.status(400).json({ error: 'emails (non-empty array) is required' });
      return;
    }
    const result = await enableWarmup(emails, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.post(
  '/api/instantly/accounts/warmup/disable',
  asyncHandler(async (req, res) => {
    const { emails } = req.body ?? {};
    if (!Array.isArray(emails) || emails.length === 0) {
      res.status(400).json({ error: 'emails (non-empty array) is required' });
      return;
    }
    const result = await disableWarmup(emails, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.get(
  '/api/instantly/emails',
  asyncHandler(async (req, res) => {
    const { limit, starting_after, search, campaign_id, is_unread, eaccount, has_reminder, scheduled_only } = req.query;
    const result = await listInstantlyEmails(
      {
        limit: limit ? Number(limit) : undefined,
        starting_after: typeof starting_after === 'string' ? starting_after : undefined,
        search: typeof search === 'string' ? search : undefined,
        campaign_id: typeof campaign_id === 'string' ? campaign_id : undefined,
        is_unread: is_unread === 'true' ? true : is_unread === 'false' ? false : undefined,
        eaccount: typeof eaccount === 'string' ? eaccount : undefined,
        has_reminder: has_reminder === 'true' ? true : undefined,
        scheduled_only: scheduled_only === 'true' ? true : undefined,
      },
      requireInstantlyKey(req.auth!.companyId),
    );
    res.json(result);
  }),
);

app.get(
  '/api/instantly/emails/unread/count',
  asyncHandler(async (req, res) => {
    const result = await getUnreadCount(requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

// Sends a real email to a real prospect the instant it succeeds — same
// category as click-to-call/SMS elsewhere in this app. The frontend
// guards this behind confirmDialog() before ever calling it.
app.post(
  '/api/instantly/emails/reply',
  asyncHandler(async (req, res) => {
    const result = await replyToInstantlyEmail(req.body ?? {}, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

app.post(
  '/api/instantly/emails/threads/:threadId/mark-as-read',
  asyncHandler(async (req, res) => {
    const result = await markThreadRead(req.params.threadId, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

// Same real-side-effect caveat as /emails/reply above.
app.post(
  '/api/instantly/emails/forward',
  asyncHandler(async (req, res) => {
    const result = await forwardInstantlyEmail(req.body ?? {}, requireInstantlyKey(req.auth!.companyId));
    res.json(result);
  }),
);

// The editable status pill (Interested/Meeting Booked/Won/...) shown at
// the top of an open Unibox conversation — a CRM-style status tag, not
// the block-list unsubscribe mechanism above.
app.post(
  '/api/instantly/leads/interest-status',
  asyncHandler(async (req, res) => {
    const { leadEmail, interestValue, campaignId } = req.body ?? {};
    if (!leadEmail || typeof leadEmail !== 'string') {
      res.status(400).json({ error: 'leadEmail is required' });
      return;
    }
    const result = await updateLeadInterestStatus(
      { leadEmail, interestValue: interestValue ?? null, campaignId },
      requireInstantlyKey(req.auth!.companyId),
    );
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
      const timing = await sendConnectionRequest(profileUrl, note);
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
        timingJson: JSON.stringify(timing),
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

// Batch version of test-connect above — real connection requests to a
// list of profile URLs, one at a time, with a randomized human-paced
// delay between each. Deliberately NOT the literal fixed 3s/5s/2s/5s
// sequence first requested — a fixed, repeating cadence is exactly the
// mechanical "looks scripted" signature this whole feature exists to
// avoid (see browser.ts's own doc comment on humanDelay). Reusing
// humanDelay's jittered-triangular distribution here instead keeps this
// consistent with every other pacing decision already in this feature,
// rather than inventing a second, different randomization scheme.
//
// Every item re-checks canSendConnect() individually, not just once
// up front — caps/pause state can change mid-batch (e.g. this exact
// batch crossing the daily cap partway through), so a later item must
// be blocked the same way a single test-connect call would be. On the
// first Safety Engine rejection, the whole batch stops rather than
// skipping ahead to the next URL — same "stop, don't silently skip"
// caution CLAUDE.md documents for Calls' history-sync chunking, for the
// identical reason: skipping would make it look like everything after
// the block point was simply never attempted, when the real reason is a
// safety gate.
app.post(
  '/api/linkedin/test-connect-batch',
  asyncHandler(async (req, res) => {
    const profileUrls: string[] = Array.isArray(req.body?.profileUrls)
      ? req.body.profileUrls.filter((u: unknown): u is string => typeof u === 'string' && u.trim().length > 0)
      : [];
    if (profileUrls.length === 0) {
      res.status(400).json({ error: 'Missing "profileUrls" (non-empty array of strings)' });
      return;
    }
    const results: Array<{ profileUrl: string; status: 'success' | 'error' | 'skipped'; detail: string | null }> = [];
    for (let i = 0; i < profileUrls.length; i++) {
      const profileUrl = profileUrls[i];
      const safetyCheck = canSendConnect();
      if (!safetyCheck.allowed) {
        results.push({ profileUrl, status: 'skipped', detail: safetyCheck.reason ?? 'Blocked by the Safety Engine' });
        break;
      }
      const startedAt = Date.now();
      try {
        const timing = await sendConnectionRequest(profileUrl);
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
          timingJson: JSON.stringify(timing),
        });
        results.push({ profileUrl, status: 'success', detail: null });
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
        results.push({ profileUrl, status: 'error', detail: message });
      }
      if (i < profileUrls.length - 1) {
        await humanDelay(2000, 6000);
      }
    }
    res.json({ results });
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

// Today's human-paced plan (dailyPlan.ts) — the Apžvalga dashboard
// section's "today's plan progress" glance. `firedCount`/`nextSlotAt` are
// derived here rather than duplicated client-side: `connectsToday` (the
// same safety-snapshot field the header bar already shows) IS the fired
// count, since dailyPlan.ts's own nextDueSlot() consumes planned slots in
// order — see its doc comment.
app.get(
  '/api/linkedin/plan/today',
  asyncHandler(async (req, res) => {
    const settings = getSafetySettings();
    const snapshot = getSafetySnapshot();
    const plan = await getOrCreateTodaysPlan(settings, snapshot.effectiveDailyCap, req.auth!.companyId);
    const firedCount = Math.min(snapshot.connectsToday, plan.targetCount);
    const nextSlot = nextDueSlot(plan, Date.now(), snapshot.connectsToday);
    res.json({
      date: plan.date,
      targetCount: plan.targetCount,
      plannedSlots: plan.plannedSlots,
      firedCount,
      // The soonest still-due slot, if any is due *right now* — null just
      // means "nothing due at this exact moment," not "nothing left
      // today" (a later un-fired slot can still exist further in plannedSlots).
      nextSlotDueNowAt: nextSlot,
    });
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

// --- Campaign graph (the visual builder) + Scheduler (the Campaign
// Engine — see scheduler.ts for the actual due-work/execute logic).
// Every executed node still goes through the Safety Engine at the moment
// it fires, same as the manual test-connect route above — nothing here
// bypasses it. Replaces the old flat sequence_steps CRUD routes.

const SEQUENCE_NODE_TYPES = new Set([
  'connect', 'message', 'withdraw', 'view_profile', 'follow', 'like_post', 'wait', 'end',
  'condition_connected', 'condition_replied', 'condition_followed_back', 'condition_profile_visited',
  'condition_post_liked', 'condition_custom', 'inmail', 'endorse', 'find_email',
]);
const SEQUENCE_EDGE_BRANCHES = new Set(['default', 'yes', 'no']);

app.get(
  '/api/linkedin/campaigns/:id/graph',
  asyncHandler(async (req, res) => {
    res.json(getCampaignGraph(req.params.id));
  }),
);

/** Bulk replace — see saveCampaignGraph()'s own doc comment on why this is
 * one endpoint, not per-node/per-edge CRUD: an editor session naturally
 * touches many nodes/edges in one save (add a few, rewire a few, drag
 * several into new positions). Validation here is deliberately shape-only
 * (known types, branch values, numeric positions) — it does not enforce
 * graph-structural rules like "a condition node has exactly two edges";
 * the frontend editor is what keeps the graph well-formed, and the
 * traversal engine (scheduler.ts) simply doesn't fire an edge that isn't
 * there rather than needing the server to reject a not-yet-finished
 * in-progress graph a user is still mid-edit on. */
app.put(
  '/api/linkedin/campaigns/:id/graph',
  asyncHandler(async (req, res) => {
    const rawNodes = req.body?.nodes;
    const rawEdges = req.body?.edges;
    if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) {
      res.status(400).json({ error: '"nodes" and "edges" must both be arrays' });
      return;
    }
    const nodes: NewSequenceNode[] = [];
    for (const n of rawNodes) {
      if (typeof n?.id !== 'string' || !n.id || !SEQUENCE_NODE_TYPES.has(n?.type)) {
        res.status(400).json({ error: `Invalid node: ${JSON.stringify(n)}` });
        return;
      }
      nodes.push({
        id: n.id,
        type: n.type,
        messageTemplate: typeof n.messageTemplate === 'string' ? n.messageTemplate : null,
        waitDays: typeof n.waitDays === 'number' && Number.isFinite(n.waitDays) ? n.waitDays : null,
        posX: typeof n.posX === 'number' && Number.isFinite(n.posX) ? n.posX : 0,
        posY: typeof n.posY === 'number' && Number.isFinite(n.posY) ? n.posY : 0,
      });
    }
    const nodeIds = new Set(nodes.map((n) => n.id));
    const edges: NewSequenceEdge[] = [];
    for (const e of rawEdges) {
      const fromNodeId = e?.fromNodeId === null ? null : e?.fromNodeId;
      if (fromNodeId !== null && (typeof fromNodeId !== 'string' || !nodeIds.has(fromNodeId))) {
        res.status(400).json({ error: `Invalid edge fromNodeId: ${JSON.stringify(e)}` });
        return;
      }
      if (typeof e?.toNodeId !== 'string' || !nodeIds.has(e.toNodeId) || !SEQUENCE_EDGE_BRANCHES.has(e?.branch)) {
        res.status(400).json({ error: `Invalid edge: ${JSON.stringify(e)}` });
        return;
      }
      edges.push({ fromNodeId, toNodeId: e.toNodeId, branch: e.branch });
    }
    saveCampaignGraph(req.params.id, nodes, edges);
    res.json({ ok: true });
  }),
);

// On-demand trigger — a manual "▶ Vykdyti dabar" click. The account's own
// configured OpenAI key (if any) is resolved here from the authenticated
// request and passed through for the optional auto-personalize step
// (safety.ts's auto_personalize_enabled) — scheduler.ts itself stays
// company-agnostic (see its own doc comment on why) and never looks this
// up on its own.
app.post(
  '/api/linkedin/scheduler/run',
  asyncHandler(async (req, res) => {
    const openaiApiKey = getCompanyIntegrations(req.auth!.companyId)?.openaiApiKey ?? undefined;
    res.json(await runSchedulerTick(false, openaiApiKey));
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
      requireOpenaiKey(req.auth!.companyId),
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

// Every route below scopes to req.auth!.companyId (attached by
// requireAuth) — see accounts/db.ts + tableData/db.ts's own doc comments
// for the isolation model this enforces: a request for another company's
// table/row id returns 404, not 403, so it doesn't even confirm the id
// exists. requirePermission() gates the handful of actions the worker
// permission flags actually restrict (see accounts/db.ts's
// UserPermissions) — owner/super_admin always pass.

app.get(
  '/api/tables',
  asyncHandler(async (req, res) => {
    res.json({ tables: loadTables(req.auth!.companyId) });
  }),
);

// Creating a table (also what duplicateTable — useWorkspaceStore.ts —
// goes through, since a duplicate is just a fresh saveTable + saveRows
// call under the hood, no separate endpoint) is workspace/company-level
// management, same bucket as renaming or deleting one — a worker is
// blocked from all of it, same requireNotWorker gate /api/workers already
// uses, not a togglable permission. This route has no other legitimate
// caller left: the one-time local-data migration action that used to call
// it was removed earlier (see CLAUDE.md's table-data migration section).
app.post(
  '/api/tables',
  requireNotWorker,
  asyncHandler(async (req, res) => {
    const table = req.body;
    if (!table?.id || typeof table.name !== 'string' || !Array.isArray(table.columns)) {
      res.status(400).json({ error: 'Invalid table payload' });
      return;
    }
    saveTable(table, req.auth!.companyId);
    res.json({ ok: true });
  }),
);

app.get(
  '/api/tables/:id',
  asyncHandler(async (req, res) => {
    const table = getTable(req.params.id, req.auth!.companyId);
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
    const companyId = req.auth!.companyId;
    // A worker without can_insert_columns/can_delete_columns may still
    // freely rename/reorder columns — this endpoint gets the *whole*
    // column list every time, so unlike the row bulk-save path below, a
    // real diff against what's currently stored is possible here: an id
    // missing from the incoming list is a removal (can_delete_columns), an
    // id present in both with a changed `hidden` flag is a hide/unhide
    // (can_hide_rows_columns — enforceable because it's an existing id's
    // own field changing, not a new id appearing), and a changed `type` on
    // an existing id is a structural retype that's blocked unconditionally
    // for every worker regardless of any permission flag (changing a
    // column's type can silently corrupt how its existing data displays —
    // see CLAUDE.md's CSV-import mapping story for exactly that failure
    // mode — so this is an admin-only action, not a togglable one).
    // Column *insertion* (a genuinely new id) is deliberately NOT checked
    // here — indistinguishable from an ordinary "+ Add column" append at
    // this endpoint (both are just "a new id in the incoming list"), so
    // can_insert_columns stays a client-side-only UI gate, same accepted-
    // limitation reasoning the original plan used for CSV export.
    if (req.auth!.role === 'worker') {
      const existing = getTable(req.params.id, companyId);
      const existingColumns = (existing?.columns as Array<{ id: string; hidden?: boolean; type: string }> | undefined) ?? [];
      const existingById = new Map(existingColumns.map((c) => [c.id, c]));
      const incomingColumns = req.body.columns as Array<{ id: string; hidden?: boolean; type: string }>;
      const incomingIds = new Set(incomingColumns.map((c) => c.id));
      const removedAny = existingColumns.some((c) => !incomingIds.has(c.id));
      const retypedAny = incomingColumns.some((c) => {
        const old = existingById.get(c.id);
        return old && old.type !== c.type;
      });
      if (retypedAny) {
        res.status(403).json({ error: 'Darbuotojai negali keisti stulpelio tipo' });
        return;
      }
      const user = getUserById(req.auth!.userId);
      if (removedAny && !user?.permissions.canDeleteColumns) {
        res.status(403).json({ error: 'Neturite teisės atlikti šio veiksmo' });
        return;
      }
      const hiddenChangedAny = incomingColumns.some((c) => {
        const old = existingById.get(c.id);
        return old && !!old.hidden !== !!c.hidden;
      });
      if (hiddenChangedAny && !user?.permissions.canHideRowsColumns) {
        res.status(403).json({ error: 'Neturite teisės atlikti šio veiksmo' });
        return;
      }
    }
    updateTableColumns(req.params.id, req.body.columns, companyId);
    res.json({ ok: true });
  }),
);

// Renaming a whole table is workspace/company-level management, same
// requireNotWorker gate as creating/duplicating (POST /api/tables above)
// and deleting (DELETE below) — not a togglable permission, no natural fit
// among the existing flags, and unlike an in-table edit there's no undo
// stack covering this screen's own table list.
app.patch(
  '/api/tables/:id/name',
  requireNotWorker,
  asyncHandler(async (req, res) => {
    if (typeof req.body?.name !== 'string') {
      res.status(400).json({ error: 'Invalid "name"' });
      return;
    }
    updateTableName(req.params.id, req.body.name, req.auth!.companyId);
    res.json({ ok: true });
  }),
);

// The Workspace screen's "📦" per-table daily-backup toggle — same
// requireNotWorker gate as the other table-management routes just above
// (a company's own super_admin decides which of their tables get backed
// up; not a worker's call). See tableData/db.ts's own doc comment on why
// this is explicit opt-in, not automatic for every table.
app.post(
  '/api/tables/:id/backup-flag',
  requireNotWorker,
  asyncHandler(async (req, res) => {
    if (typeof req.body?.enabled !== 'boolean') {
      res.status(400).json({ error: 'Invalid "enabled"' });
      return;
    }
    setTableBackupFlag(req.params.id, req.auth!.companyId, req.body.enabled);
    res.json({ ok: true });
  }),
);

// Deleting an entire table is workspace/company-level management, same
// requireNotWorker gate as create/duplicate/rename above — reused to be
// can_delete_rows-gated instead at first (deleting a table being "a strict
// superset of deleting its rows"), tightened to a full block on explicit
// request: a worker having can_delete_rows for ordinary row cleanup inside
// a table they're scoped to shouldn't also mean they can make the whole
// table disappear.
app.delete(
  '/api/tables/:id',
  requireNotWorker,
  asyncHandler(async (req, res) => {
    deleteTable(req.params.id, req.auth!.companyId);
    res.json({ ok: true });
  }),
);

app.get(
  '/api/tables/:id/rows',
  asyncHandler(async (req, res) => {
    res.json({ rows: loadRowsForTable(req.params.id, req.auth!.companyId) });
  }),
);

app.get(
  '/api/tables/:id/rows/count',
  asyncHandler(async (req, res) => {
    res.json({ count: countRowsForTable(req.params.id, req.auth!.companyId) });
  }),
);

// --- Daily backups (a company's own view — see /api/admin/backups for
// the owner's cross-company one) ---------------------------------------
// Same requireNotWorker gate as every other table-management route
// above — a company's own super_admin manages/downloads/restores their
// own backups, never a worker.

app.get(
  '/api/backups',
  requireNotWorker,
  asyncHandler(async (req, res) => {
    res.json({ backups: listBackupsForCompany(req.auth!.companyId) });
  }),
);

app.delete(
  '/api/backups/:id',
  requireNotWorker,
  asyncHandler(async (req, res) => {
    deleteBackup(req.params.id, req.auth!.companyId);
    res.json({ ok: true });
  }),
);

// Plain JSON, not a Content-Disposition file response — a browser
// navigation/plain <a href> download can't carry the Authorization
// header requireAuth needs, and this route is behind it like everything
// else in this app. The frontend instead fetches this via the normal
// authenticated localApiRequest() and triggers the actual save with the
// existing client-side downloadCsv() (utils/csv.ts), same blob-download
// mechanism every other CSV export in this app already uses.
app.get(
  '/api/backups/:id/csv',
  requireNotWorker,
  asyncHandler(async (req, res) => {
    const result = backupToCsvText(req.params.id, req.auth!.companyId);
    if (!result) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }
    res.json(result);
  }),
);

// Creates a brand-new table from this backup — current data is never
// touched (see restoreBackupAsNewTable's own doc comment). The frontend
// must have already shown a confirm dialog, same as every other
// real-world action in this app.
app.post(
  '/api/backups/:id/restore',
  requireNotWorker,
  asyncHandler(async (req, res) => {
    const table = restoreBackupAsNewTable(req.params.id, req.auth!.companyId);
    if (!table) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }
    res.json(table);
  }),
);

// Powers the global "time to call" browser notification — polled every
// ~60s by the client regardless of which tab/table is open (see
// useReminderStore.ts). Deliberately not scoped to any one table (see
// findTimedNextActionRows' own doc comment for why this has to read
// straight from the DB rather than an in-memory table's rows) and
// deliberately returns every match with no due-time filtering — that
// comparison has to happen client-side in the user's own timezone.
app.get(
  '/api/reminders/timed',
  asyncHandler(async (req, res) => {
    res.json({ groups: findTimedNextActionRows(req.auth!.companyId) });
  }),
);

// A worker's row writes go through sanitizeRowForWorker (tableData/db.ts)
// regardless of which of the three routes below they arrive on — unlike
// the columns endpoint above, this bulk path can't tell an "insert at
// position" apart from an ordinary "+ Add row" append (both are just "a
// new row id in this batch"), so can_insert_rows stays a client-side-only
// UI gate; what *is* enforceable here (append-only text/phone/company/
// link, the note/contact edit/delete lock, and can_hide_rows_columns) is
// exactly what sanitizeRowForWorker checks. Returns null for anyone who
// isn't a worker (owner/super_admin writes are never restricted).
function workerRowRestriction(req: Request): WorkerRowRestriction | null {
  if (req.auth!.role !== 'worker') return null;
  const user = getUserById(req.auth!.userId);
  if (!user) return null;
  return {
    userId: user.id,
    userName: `${user.firstName} ${user.lastName}`.trim(),
    canDeleteNotes: user.permissions.canDeleteNotes,
    canEditContacts: user.permissions.canEditContacts,
    canDeleteContacts: user.permissions.canDeleteContacts,
    canHideRowsColumns: user.permissions.canHideRowsColumns,
  };
}

// Bulk save — the one endpoint that actually matters for real usage at
// scale: useTableStore.ts's moveRows/insertRows/applySortOrder all rewrite
// `order` across *every* row on a single drag-reorder or sort click, so
// this has to stay one request for the whole batch, never one request per
// row (14,000 individual PUTs would make the table unusable). See
// tableData/db.ts's own saveRows() doc comment. Not gated by any
// requirePermission() middleware — this is the everyday save path for
// every ordinary edit (paste, drag-reorder, cell writes), not just CSV
// import; see POST /api/rows/import below for the actual import-specific
// endpoint that can_export_import additionally gates. A worker's write
// still passes through workerRowRestriction/sanitizeRowForWorker though —
// see that function's own doc comment for exactly what it does and doesn't
// catch.
app.put(
  '/api/rows',
  asyncHandler(async (req, res) => {
    if (!Array.isArray(req.body?.rows)) {
      res.status(400).json({ error: 'Invalid "rows"' });
      return;
    }
    const companyId = req.auth!.companyId;
    const tableIds = (req.body.rows as Array<{ tableId?: string }>).map((r) => r.tableId).filter((id): id is string => !!id);
    if (!allTablesBelongToCompany(tableIds, companyId)) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }
    saveRows(req.body.rows, companyId, workerRowRestriction(req));
    res.json({ ok: true });
  }),
);

// Same shape as PUT /api/rows above, but a distinct route specifically so
// CSV import can be gated on can_export_import without also blocking
// every other bulk-save use (drag-reorder, paste, column sort) that
// route already serves — see useTableStore.ts's importCsvRows, which
// calls this instead of the generic saveRows path for each of its
// batches.
app.post(
  '/api/rows/import',
  requirePermission('canExportImport'),
  asyncHandler(async (req, res) => {
    if (!Array.isArray(req.body?.rows)) {
      res.status(400).json({ error: 'Invalid "rows"' });
      return;
    }
    const companyId = req.auth!.companyId;
    const tableIds = (req.body.rows as Array<{ tableId?: string }>).map((r) => r.tableId).filter((id): id is string => !!id);
    if (!allTablesBelongToCompany(tableIds, companyId)) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }
    saveRows(req.body.rows, companyId, workerRowRestriction(req));
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
    const companyId = req.auth!.companyId;
    if (!allTablesBelongToCompany([row.tableId], companyId)) {
      res.status(404).json({ error: 'Table not found' });
      return;
    }
    saveRow(row, companyId, workerRowRestriction(req));
    res.json({ ok: true });
  }),
);

app.delete(
  '/api/rows/:id',
  requirePermission('canDeleteRows'),
  asyncHandler(async (req, res) => {
    deleteRow(req.params.id, req.auth!.companyId);
    res.json({ ok: true });
  }),
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.too.large') {
    console.error('Request body too large:', err);
    res.status(413).json({ error: 'Request body too large — this payload exceeded the server’s size limit.' });
    return;
  }
  if (err instanceof IntegrationNotConfiguredError) {
    res.status(409).json({ error: err.message });
    return;
  }
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
  if (err instanceof ContactParseError || err instanceof SummarizeError || err instanceof LinkedInReplyError) {
    console.error('OpenAI error:', err.message);
    res.status(502).json({ error: err.message });
    return;
  }
  if (err instanceof ApolloApiError) {
    console.error('Apollo API error:', err.message, err.raw);
    res.status(502).json({ error: err.message });
    return;
  }
  if (err instanceof InstantlyApiError) {
    console.error('Instantly API error:', err.message, err.raw);
    res.status(502).json({ error: err.message });
    return;
  }
  if (err instanceof SerperError) {
    console.error('serper.dev error:', err.message);
    res.status(502).json({ error: err.message });
    return;
  }
  if (err instanceof EmailGenerateError) {
    console.error('Anthropic error:', err.message);
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

// One-time bootstrap, run synchronously before the server starts
// accepting requests — see accounts/db.ts's bootstrapFirstCompanyIfNeeded
// doc comment for the full story. On a fresh install this creates "Company
// #1" + today's AUTH_USERNAME/AUTH_PASSWORD as its first (ordinary
// super_admin) user; on every boot after the first it's a no-op that just
// returns the existing first company's id. Either way, backfillCompanyId()
// assigns that id to any pre-existing tables/rows still carrying the ALTER
// TABLE's temporary '' placeholder (see tableData/db.ts) — real on the
// very first boot after this multi-tenant model shipped, a no-op forever
// after. demoteOwnerUsers() runs right alongside it — a separate,
// independently-idempotent migration converting any pre-existing
// `role = 'owner'` row (this app's real account, before admin access
// became a fully independent login — see auth.ts's requireSuperAdmin) into
// an ordinary super_admin, in place.
demoteOwnerUsers();
const { companyId: firstCompanyId } = bootstrapFirstCompanyIfNeeded();
backfillCompanyId(firstCompanyId);

// One-time seed, same "idempotent, real on the very first boot after this
// shipped, a no-op forever after" shape as backfillCompanyId above — moves
// the first company's own already-working credentials (today's
// server/.env/Render values) into company_integrations, so that real
// account keeps working with zero manual re-entry the moment per-company
// credentials replace the old single-shared-env-var model. Every route
// from here on reads from the DB, never process.env directly, so without
// this seed those integrations would all silently stop working on first
// boot.
if (!getCompanyIntegrations(firstCompanyId)) {
  upsertCompanyIntegrations(firstCompanyId, {
    zadarmaApiKey: process.env.ZADARMA_API_KEY,
    zadarmaApiSecret: process.env.ZADARMA_API_SECRET,
    zadarmaCallerNumber: process.env.ZADARMA_CALLER_NUMBER,
    instantlyApiKey: process.env.INSTANTLY_API_KEY,
    apolloApiKey: process.env.APOLLO_API_KEY,
    serperApiKey: process.env.SERPER_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    elevenlabsApiKey: process.env.ELEVENLABS_API_KEY,
    // A real, reported gap: LINKEDIN_CDP_URL is normally left UNSET on
    // purpose — CLAUDE.md's own Commands section says it "only needs
    // setting if you're not using the 9222 default," which is the common
    // case — but linkedin/browser.ts's own CDP_URL constant falls back to
    // 'http://127.0.0.1:9222' when the env var is absent, so "unset"
    // there means "use the default," not "not configured." This seed
    // copied process.env.LINKEDIN_CDP_URL literally, so a company running
    // on the implicit default seeded a `null` linkedin_cdp_url — and
    // computeAvailableFeatures (accounts/db.ts) correctly-per-its-own-
    // logic then hid the LinkedIn tab entirely, even though the feature
    // was actually working. Matching browser.ts's own fallback here means
    // the seed reflects what's actually running, not just what happens to
    // be an explicit env var.
    linkedinCdpUrl: process.env.LINKEDIN_CDP_URL || 'http://127.0.0.1:9222',
  });
}

app.listen(PORT, HOST, () => {
  console.log(`Zadarma proxy listening on http://${HOST}:${PORT}`);
});

// Both the Scheduler tick and the Inbox sync USED to also run on their own
// background setInterval heartbeats (5 min / 10 min) here, independently
// of any HTTP request or user action — then were removed after a real,
// reported problem: the Inbox sync had *zero* pause-switch check, and
// getLinkedInPage() unconditionally recreated a closed LinkedIn tab, so
// the pair of these together kept "turning the window back on" every 10
// minutes regardless of the pause state or whether the account owner had
// deliberately closed the tab. Brought back here, on the account owner's
// own explicit request for genuinely unattended ("turn on and forget")
// operation — but built on the actual fixes, not the same behavior that
// caused the original complaint: inbox.ts's syncInbox() now checks
// isPaused() before doing anything (scheduler.ts's connect/message paths
// already did, via canSendConnect()/canSendMessage()), and both pass
// `isAutomatic = true`, which makes getLinkedInPage() (browser.ts) refuse
// to open a tab that isn't already there — an automatic tick with no
// LinkedIn tab open just logs a clean skip and waits for the next one,
// never recreates what was deliberately closed. The Scheduler tick
// additionally paces itself against dailyPlan.ts's human-realistic daily
// plan when automatic (see scheduler.ts's own doc comment) — this is what
// actually spreads sends across the day instead of firing every due lead
// the instant a tick finds them. Both routes below (POST
// /api/linkedin/scheduler/run, POST /api/linkedin/inbox/sync) are
// unchanged and still work exactly as before for an explicit click — only
// the *automatic* path is new.
const SCHEDULER_TICK_INTERVAL_MS = 5 * 60 * 1000;
const INBOX_SYNC_INTERVAL_MS = 10 * 60 * 1000;

setInterval(() => {
  // Resolved fresh on every tick, not captured once at startup — lets a
  // key added/changed later via the Integrations UI take effect on the
  // very next automatic tick rather than needing a server restart.
  const openaiApiKey = getCompanyIntegrations(firstCompanyId)?.openaiApiKey ?? undefined;
  runSchedulerTick(true, openaiApiKey)
    .then((result) => {
      if (result.autoExecuted > 0 || result.circuitBreakerTripped || result.errors > 0) {
        console.log('[linkedin/scheduler] automatic tick:', result);
      }
    })
    .catch((err) => console.error('[linkedin/scheduler] automatic tick failed:', err));
}, SCHEDULER_TICK_INTERVAL_MS);

setInterval(() => {
  syncInbox(true)
    .then((result) => {
      if (result.newMessages > 0 || result.leadsPromoted > 0 || result.leadsMarkedReplied > 0) {
        console.log('[linkedin/inbox] automatic sync:', result);
      }
    })
    .catch((err) => console.error('[linkedin/inbox] automatic sync failed:', err));
}, INBOX_SYNC_INTERVAL_MS);

// Daily table backups (see tableData/db.ts's own doc comments on the
// backups table) — hourly polling, same lightweight shape as the two
// intervals above, not a literal once-a-day cron: checks every flagged
// table's own latestBackupDateUtc() against today's UTC date and only
// actually snapshots the ones that haven't run yet today, so this stays
// correct (no missed or duplicate days) across server restarts/redeploys
// without needing precise time-of-day scheduling. purgeOldBackups runs
// every tick too — cheap enough not to need its own separate timer.
const BACKUP_TICK_INTERVAL_MS = 60 * 60 * 1000;
const BACKUP_RETENTION_DAYS = 30;

setInterval(() => {
  try {
    const todayUtc = new Date().toISOString().slice(0, 10);
    let created = 0;
    for (const table of listBackupFlaggedTables()) {
      if (latestBackupDateUtc(table.id) === todayUtc) continue;
      if (createBackup(table.id, table.companyId)) created++;
    }
    if (created > 0) console.log('[backups] automatic daily tick: created', created, 'backup(s).');
    purgeOldBackups(BACKUP_RETENTION_DAYS);
  } catch (err) {
    console.error('[backups] automatic daily tick failed:', err);
  }
}, BACKUP_TICK_INTERVAL_MS);
