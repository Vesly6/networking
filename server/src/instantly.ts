const API_BASE = 'https://api.instantly.ai/api/v2';

export class InstantlyApiError extends Error {
  raw: unknown;
  status: number;
  constructor(message: string, status: number, raw: unknown) {
    super(message);
    this.status = status;
    this.raw = raw;
  }
}

interface CallOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

function buildQuery(query?: CallOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

async function callInstantly<T>(path: string, options: CallOptions = {}, apiKey: string): Promise<T> {
  const { method = 'GET', query, body } = options;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}${buildQuery(query)}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new InstantlyApiError('Could not reach the email service', 0, null);
  }

  const rawText = await res.text();
  let json: unknown = null;
  try {
    json = rawText ? JSON.parse(rawText) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message =
      (json && typeof json === 'object' && 'message' in json && typeof (json as { message: unknown }).message === 'string'
        ? (json as { message: string }).message
        : null) ?? `Instantly request failed (HTTP ${res.status})`;
    throw new InstantlyApiError(message, res.status, json);
  }
  return json as T;
}

/** Every list endpoint (campaigns, leads, accounts, emails, block-list)
 * shares this same cursor-pagination envelope — confirmed directly against
 * the real OpenAPI spec (api.instantly.ai/openapi/api_v2.json), not
 * guessed from docs prose. `next_starting_after` is absent once there are
 * no more pages. */
export interface InstantlyPage<T> {
  items: T[];
  next_starting_after?: string;
}

// --- Campaigns ---

export interface InstantlyCampaign {
  id: string;
  name: string;
  status: number;
  timestamp_created: string;
  timestamp_updated: string;
  daily_limit?: number;
  [key: string]: unknown;
}

export function listCampaigns(
  params: { limit?: number; starting_after?: string; search?: string; status?: number },
  apiKey: string,
) {
  return callInstantly<InstantlyPage<InstantlyCampaign>>('/campaigns', { query: params }, apiKey);
}

export function getCampaign(id: string, apiKey: string) {
  return callInstantly<InstantlyCampaign>(`/campaigns/${encodeURIComponent(id)}`, {}, apiKey);
}

// Real, live side effects on the account's actual sending — confirmed
// paths directly against the spec: NOT /start and /stop (what the docs
// site's own summary claimed), the real paths are /activate and /pause.
export function activateCampaign(id: string, apiKey: string) {
  return callInstantly<{ status: string }>(`/campaigns/${encodeURIComponent(id)}/activate`, { method: 'POST' }, apiKey);
}

export function pauseCampaign(id: string, apiKey: string) {
  return callInstantly<{ status: string }>(`/campaigns/${encodeURIComponent(id)}/pause`, { method: 'POST' }, apiKey);
}

export interface InstantlyCampaignAnalyticsOverview {
  open_count: number;
  open_count_unique: number;
  link_click_count: number;
  link_click_count_unique: number;
  reply_count: number;
  reply_count_unique: number;
  emails_sent_count: number;
  total_opportunities: number;
  total_opportunity_value: number;
  [key: string]: unknown;
}

export function getCampaignAnalyticsOverview(
  params: { id?: string; ids?: string[]; start_date?: string; end_date?: string },
  apiKey: string,
) {
  return callInstantly<InstantlyCampaignAnalyticsOverview>(
    '/campaigns/analytics/overview',
    { query: { id: params.id, start_date: params.start_date, end_date: params.end_date } },
    apiKey,
  );
}

export interface InstantlyCampaignDailyAnalytics {
  date: string;
  sent: number;
  opened: number;
  unique_opened: number;
  replies: number;
  unique_replies: number;
  clicks: number;
  unique_clicks: number;
  opportunities: number;
  [key: string]: unknown;
}

export function getCampaignAnalyticsDaily(
  params: { campaign_id?: string; start_date?: string; end_date?: string },
  apiKey: string,
) {
  return callInstantly<InstantlyCampaignDailyAnalytics[]>('/campaigns/analytics/daily', { query: params }, apiKey);
}

/** The per-campaign analytics *list* (plural /campaigns/analytics) — not
 * to be confused with getCampaign() (a single campaign's own record) or
 * getCampaignAnalyticsOverview() (one aggregated total across campaigns).
 * This is what feeds the "Campaign analytics" table row-per-campaign. */
export interface InstantlyCampaignAnalyticsRow {
  campaign_id: string;
  campaign_name: string;
  campaign_status: number;
  contacted_count: number;
  emails_sent_count: number;
  open_count: number;
  open_count_unique: number;
  reply_count: number;
  reply_count_unique: number;
  total_opportunities: number;
  total_opportunity_value: number;
  [key: string]: unknown;
}

export function getCampaignsAnalyticsList(params: { start_date?: string; end_date?: string }, apiKey: string) {
  return callInstantly<InstantlyCampaignAnalyticsRow[]>('/campaigns/analytics', { query: params }, apiKey);
}

// --- Leads ("companies") ---

export interface InstantlyLead {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  company_domain: string | null;
  job_title: string | null;
  phone: string | null;
  website: string | null;
  campaign: string | null;
  lt_interest_status: number | null;
  status: number;
  timestamp_created: string;
  timestamp_last_contact: string | null;
  [key: string]: unknown;
}

export interface ListLeadsBody {
  search?: string;
  campaign?: string;
  list_id?: string;
  limit?: number;
  starting_after?: string;
}

// POST, not GET — search/filter/pagination all live in the request body
// per the spec, unlike every other list endpoint here.
export function listLeads(body: ListLeadsBody, apiKey: string) {
  return callInstantly<InstantlyPage<InstantlyLead>>('/leads/list', { method: 'POST', body }, apiKey);
}

export interface CreateLeadBody {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  job_title?: string;
  phone?: string;
  website?: string;
  campaign?: string;
  list_id?: string;
}

export function createLead(body: CreateLeadBody, apiKey: string) {
  return callInstantly<InstantlyLead>('/leads', { method: 'POST', body }, apiKey);
}

export function updateLead(id: string, body: Partial<CreateLeadBody>, apiKey: string) {
  return callInstantly<InstantlyLead>(`/leads/${encodeURIComponent(id)}`, { method: 'PATCH', body }, apiKey);
}

export function deleteLead(id: string, apiKey: string) {
  return callInstantly<{ status: string }>(`/leads/${encodeURIComponent(id)}`, { method: 'DELETE' }, apiKey);
}

// --- Block list (the real "unsubscribe" mechanism) ---
//
// lt_interest_status/update-interest-status (see Lead above) is a
// SEPARATE, unrelated interest-tracking field ("Interested"/"Meeting
// Booked"/"Not Interested"/...) — confirmed directly against the spec,
// it has nothing to do with opting someone out of future sends. Adding an
// email (or a whole domain) to the block list is what Instantly's own web
// app calls "Unsubscribe" — future campaigns skip anyone matching an
// entry here.

export interface InstantlyBlockListEntry {
  id: string;
  bl_value: string;
  timestamp_created: string;
  [key: string]: unknown;
}

export function addToBlockList(bl_value: string, apiKey: string) {
  return callInstantly<InstantlyBlockListEntry>('/block-lists-entries', { method: 'POST', body: { bl_value } }, apiKey);
}

export function listBlockList(params: { limit?: number; starting_after?: string; search?: string }, apiKey: string) {
  return callInstantly<InstantlyPage<InstantlyBlockListEntry>>('/block-lists-entries', { query: params }, apiKey);
}

export function removeFromBlockList(id: string, apiKey: string) {
  return callInstantly<{ status: string }>(`/block-lists-entries/${encodeURIComponent(id)}`, { method: 'DELETE' }, apiKey);
}

// --- Email accounts ("mailboxes") ---

export interface InstantlyAccount {
  email: string;
  first_name: string | null;
  last_name: string | null;
  status: number;
  provider_code: number;
  warmup_status: number;
  stat_warmup_score: number | null;
  daily_limit: number;
  timestamp_created: string;
  [key: string]: unknown;
}

export function listAccounts(
  params: { limit?: number; starting_after?: string; search?: string; status?: number },
  apiKey: string,
) {
  return callInstantly<InstantlyPage<InstantlyAccount>>('/accounts', { query: params }, apiKey);
}

/** SMTP/IMAP-only — provider_code 1 ("Custom IMAP/SMTP"), confirmed as a
 * fully API-supported connection path directly against the CreateAccount
 * schema. Gmail/Outlook accounts (provider_code 2/3) go through
 * Instantly's own hosted OAuth flow, which isn't built here — on request,
 * since those just show up in listAccounts() automatically once added
 * through Instantly's own dashboard (same workspace, same API key). */
export interface CreateAccountBody {
  email: string;
  first_name?: string;
  last_name?: string;
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  smtp_password: string;
  imap_host: string;
  imap_port: number;
  imap_username: string;
  imap_password: string;
  daily_limit?: number;
}

export function createAccount(body: CreateAccountBody, apiKey: string) {
  return callInstantly<InstantlyAccount>('/accounts', { method: 'POST', body: { ...body, provider_code: 1 } }, apiKey);
}

// Accounts have no `id` field at all — confirmed directly against the
// spec, they're identified by email address everywhere, including these
// action paths (NOT /accounts/{id}/... as the docs site's own summary
// claimed).
export function pauseAccount(email: string, apiKey: string) {
  return callInstantly<{ status: string }>(`/accounts/${encodeURIComponent(email)}/pause`, { method: 'POST' }, apiKey);
}

export function resumeAccount(email: string, apiKey: string) {
  return callInstantly<{ status: string }>(`/accounts/${encodeURIComponent(email)}/resume`, { method: 'POST' }, apiKey);
}

export function enableWarmup(emails: string[], apiKey: string) {
  return callInstantly<{ status: string }>('/accounts/warmup/enable', { method: 'POST', body: { emails } }, apiKey);
}

export function disableWarmup(emails: string[], apiKey: string) {
  return callInstantly<{ status: string }>('/accounts/warmup/disable', { method: 'POST', body: { emails } }, apiKey);
}

// --- Unibox ---

export interface InstantlyEmail {
  id: string;
  timestamp_email: string;
  subject: string;
  from_address_email: string;
  to_address_email_list: string;
  body: { text?: string; html?: string } | null;
  campaign_id: string | null;
  lead_id: string | null;
  lead: string | null;
  eaccount: string;
  is_unread: boolean;
  // The lead's interest status (Interested/Meeting Booked/Won/...) as of
  // this email — same enum as Lead.lt_interest_status, carried directly
  // on the email object itself (no separate per-lead lookup needed). null
  // means plain "Lead" (no status set yet).
  i_status: number | null;
  // 1 = Instantly's own "Primary" Unibox tab, 0/null = "Others" — the
  // same split Instantly's own UI shows as two tabs above the thread list.
  is_focused: number | null;
  is_auto_reply: boolean | null;
  reminder_ts: string | null;
  thread_id: string | null;
  content_preview: string | null;
  [key: string]: unknown;
}

export function listEmails(
  params: {
    limit?: number;
    starting_after?: string;
    search?: string;
    campaign_id?: string;
    // Confirmed live against the real API: both silently no-op (return the
    // exact same results with or without them) rather than actually
    // filtering — kept here anyway since they're documented, real query
    // params and passing them is harmless, but the frontend's own "More"
    // menu (UniboxPanel.tsx) does NOT rely on either of these alone; it
    // re-filters client-side using reminder_ts for "Reminders only" (a
    // field that does come back reliably), and has no reliable client-side
    // signal at all for "Scheduled emails" — that one is genuinely
    // best-effort/unverified in this account (zero scheduled emails to
    // test against).
    has_reminder?: boolean;
    scheduled_only?: boolean;
    is_unread?: boolean;
    eaccount?: string;
  },
  apiKey: string,
) {
  return callInstantly<InstantlyPage<InstantlyEmail>>('/emails', { query: params }, apiKey);
}

export interface ReplyToEmailBody {
  reply_to_uuid: string;
  eaccount: string;
  subject: string;
  body: { html?: string; text?: string };
}

/** Sends a real email to a real prospect the instant it succeeds — same
 * category of irreversible side effect as click-to-call/SMS elsewhere in
 * this app. Only ever call this from an explicit, already-confirmed user
 * action. */
export function replyToEmail(body: ReplyToEmailBody, apiKey: string) {
  return callInstantly<InstantlyEmail>('/emails/reply', { method: 'POST', body }, apiKey);
}

export interface ForwardEmailBody {
  reply_to_uuid: string;
  eaccount: string;
  to_address_email_list: string;
  subject: string;
  body?: { html?: string; text?: string };
}

/** Same real-side-effect caveat as replyToEmail above. */
export function forwardEmail(body: ForwardEmailBody, apiKey: string) {
  return callInstantly<InstantlyEmail>('/emails/forward', { method: 'POST', body }, apiKey);
}

export function markThreadRead(threadId: string, apiKey: string) {
  return callInstantly<{ status: string }>(`/emails/threads/${encodeURIComponent(threadId)}/mark-as-read`, { method: 'POST' }, apiKey);
}

/** PATCH /emails/{id} — the one *single-message* update endpoint, confirmed
 * directly against the real API reference (not guessed from prose): the
 * request body accepts only `is_unread` (number, 1/0) and `reminder_ts`,
 * `additionalProperties: false`. There is no symmetric "mark thread as
 * unread" endpoint the way markThreadRead above has a whole-thread one —
 * this only ever flips a single message, so "mark this thread unread"
 * (UniboxPanel.tsx) applies it to that thread's *latest* message
 * specifically, which is enough to flip the thread's own hasUnread
 * computation back to true (see useInstantlyInboxStore.ts's
 * groupIntoThreads: `messages.some(m => m.is_unread)`). */
export function updateEmail(id: string, patch: { is_unread?: 0 | 1; reminder_ts?: string | null }, apiKey: string) {
  return callInstantly<InstantlyEmail>(`/emails/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }, apiKey);
}

export function getUnreadCount(apiKey: string) {
  return callInstantly<{ count: number }>('/emails/unread/count', {}, apiKey);
}

/** Sets a lead's interest status (Interested/Meeting Booked/Won/...) — the
 * editable status pill shown at the top of an open Unibox conversation in
 * Instantly's own UI. `interestValue: null` resets it back to plain
 * "Lead" (Instantly's own semantics, per the API's own doc comment on this
 * field). Distinct from the block-list "unsubscribe" mechanism elsewhere
 * in this file — this is a CRM-style status tag, not an opt-out. */
export function updateLeadInterestStatus(
  params: { leadEmail: string; interestValue: number | null; campaignId?: string },
  apiKey: string,
) {
  return callInstantly<{ status: string }>(
    '/leads/update-interest-status',
    { method: 'POST', body: { lead_email: params.leadEmail, interest_value: params.interestValue, campaign_id: params.campaignId } },
    apiKey,
  );
}
