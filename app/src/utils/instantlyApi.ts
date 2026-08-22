import { localApiRequest } from './localApi';

// Cursor pagination — every list endpoint on server/src/instantly.ts's
// proxy shares this same envelope (confirmed against Instantly's real
// OpenAPI spec), so one generic page type covers all of them.
export interface InstantlyPage<T> {
  items: T[];
  next_starting_after?: string;
}

// --- Campaigns ---

export const CAMPAIGN_STATUS_LABELS: Record<number, string> = {
  0: 'Juodraštis',
  1: 'Aktyvi',
  2: 'Pristabdyta',
  3: 'Baigta',
  4: 'Vykdo papildomą seką',
  '-99': 'Paskyra sustabdyta',
  '-1': 'Pašto dėžutės nesveikos',
  '-2': 'Bounce Protect',
};

export interface InstantlyCampaign {
  id: string;
  name: string;
  status: number;
  timestamp_created: string;
  timestamp_updated: string;
  daily_limit?: number;
  pl_value?: number;
  [key: string]: unknown;
}

export function fetchInstantlyCampaigns(params: { limit?: number; starting_after?: string; search?: string } = {}) {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  if (params.starting_after) q.set('starting_after', params.starting_after);
  if (params.search) q.set('search', params.search);
  const qs = q.toString();
  return localApiRequest<InstantlyPage<InstantlyCampaign>>(`/api/instantly/campaigns${qs ? `?${qs}` : ''}`);
}

export function fetchInstantlyCampaign(id: string) {
  return localApiRequest<InstantlyCampaign>(`/api/instantly/campaigns/${encodeURIComponent(id)}`);
}

/** Real, live effect on the account's actual sending. */
export function activateInstantlyCampaign(id: string) {
  return localApiRequest<{ status: string }>(`/api/instantly/campaigns/${encodeURIComponent(id)}/activate`, { method: 'POST' });
}

export function pauseInstantlyCampaign(id: string) {
  return localApiRequest<{ status: string }>(`/api/instantly/campaigns/${encodeURIComponent(id)}/pause`, { method: 'POST' });
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

export function fetchInstantlyCampaignAnalytics(params: { id?: string; start_date?: string; end_date?: string } = {}) {
  const q = new URLSearchParams();
  if (params.id) q.set('id', params.id);
  if (params.start_date) q.set('start_date', params.start_date);
  if (params.end_date) q.set('end_date', params.end_date);
  const qs = q.toString();
  return localApiRequest<InstantlyCampaignAnalyticsOverview>(`/api/instantly/campaigns/analytics/overview${qs ? `?${qs}` : ''}`);
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

export function fetchInstantlyCampaignAnalyticsDaily(params: { start_date?: string; end_date?: string } = {}) {
  const q = new URLSearchParams();
  if (params.start_date) q.set('start_date', params.start_date);
  if (params.end_date) q.set('end_date', params.end_date);
  const qs = q.toString();
  return localApiRequest<InstantlyCampaignDailyAnalytics[]>(`/api/instantly/campaigns/analytics/daily${qs ? `?${qs}` : ''}`);
}

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

export function fetchInstantlyCampaignsAnalyticsList(params: { start_date?: string; end_date?: string } = {}) {
  const q = new URLSearchParams();
  if (params.start_date) q.set('start_date', params.start_date);
  if (params.end_date) q.set('end_date', params.end_date);
  const qs = q.toString();
  return localApiRequest<InstantlyCampaignAnalyticsRow[]>(`/api/instantly/campaigns/analytics/list${qs ? `?${qs}` : ''}`);
}

// --- Leads ("companies") ---

export const LEAD_STATUS_LABELS: Record<number, string> = {
  1: 'Aktyvus',
  2: 'Pristabdytas',
  3: 'Baigtas',
  '-1': 'Atmestas (bounced)',
  '-2': 'Atsisakė (unsubscribed)',
  '-3': 'Praleistas',
};

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
  status: number;
  lt_interest_status: number | null;
  timestamp_created: string;
  timestamp_last_contact: string | null;
  [key: string]: unknown;
}

export function fetchInstantlyLeads(body: { search?: string; campaign?: string; limit?: number; starting_after?: string }) {
  return localApiRequest<InstantlyPage<InstantlyLead>>('/api/instantly/leads/list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Adds the lead's email to Instantly's block list — the real
 * "unsubscribe" mechanism (see server/src/instantly.ts's own doc comment
 * on why this, not lt_interest_status). Close to permanent — the caller
 * must have already shown a confirmDialog. */
export function unsubscribeInstantlyLead(email: string) {
  return localApiRequest<{ id: string; bl_value: string }>('/api/instantly/block-list', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bl_value: email }),
  });
}

// --- Email accounts ("mailboxes") ---

export const ACCOUNT_STATUS_LABELS: Record<number, string> = {
  1: 'Aktyvi',
  2: 'Pristabdyta',
  3: 'Laikinai sustabdyta (priežiūra)',
  '-1': 'Prisijungimo klaida',
  '-2': 'Soft bounce klaida',
  '-3': 'Siuntimo klaida',
};

export const WARMUP_STATUS_LABELS: Record<number, string> = {
  0: 'Išjungtas',
  1: 'Įjungtas',
  '-1': 'Užblokuotas',
  '-2': 'Spam aplankas nežinomas',
  '-3': 'Visam laikui sustabdytas',
};

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

export function fetchInstantlyAccounts(params: { limit?: number; starting_after?: string; search?: string } = {}) {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  if (params.starting_after) q.set('starting_after', params.starting_after);
  if (params.search) q.set('search', params.search);
  const qs = q.toString();
  return localApiRequest<InstantlyPage<InstantlyAccount>>(`/api/instantly/accounts${qs ? `?${qs}` : ''}`);
}

/** SMTP/IMAP only — see server/src/instantly.ts's own doc comment on why
 * Gmail/Outlook OAuth isn't offered here (add those through Instantly's
 * own dashboard instead; they'll show up in the list above automatically,
 * same workspace/API key). */
export interface NewInstantlyMailbox {
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

export function createInstantlyAccount(body: NewInstantlyMailbox) {
  return localApiRequest<InstantlyAccount>('/api/instantly/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function pauseInstantlyAccount(email: string) {
  return localApiRequest<{ status: string }>(`/api/instantly/accounts/${encodeURIComponent(email)}/pause`, { method: 'POST' });
}

export function resumeInstantlyAccount(email: string) {
  return localApiRequest<{ status: string }>(`/api/instantly/accounts/${encodeURIComponent(email)}/resume`, { method: 'POST' });
}

export function setInstantlyWarmup(email: string, enabled: boolean) {
  return localApiRequest<{ status: string }>(`/api/instantly/accounts/warmup/${enabled ? 'enable' : 'disable'}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emails: [email] }),
  });
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
  // Real display names, not just addresses — a message's own headers
  // already carry these, so showing them is free (no extra lookup against
  // the Leads list needed) and reads far better than a raw email in a
  // thread list.
  from_address_json?: Array<{ name?: string; address: string }>;
  to_address_json?: Array<{ name?: string; address: string }>;
  // The API sends this as a 0/1 number despite the docs implying a
  // boolean — same class of "type lies at the wire boundary" gotcha
  // already documented in this codebase for Zadarma's destination field;
  // normalized to a real boolean below in fetchInstantlyEmails rather
  // than trusting the raw value.
  is_unread: number | boolean;
  // The lead's CRM-style status (Interested/Meeting Booked/Won/...) as of
  // this email — same enum as a Lead's own lt_interest_status, carried
  // directly on the email object so no separate per-lead lookup is
  // needed. null/undefined = plain "Lead" (no status set).
  i_status?: number | null;
  // 1 = Instantly's own "Primary" Unibox tab, 0/null = "Others".
  is_focused?: number | null;
  is_auto_reply?: boolean | null;
  // Non-null when a reminder was set on this specific message. Confirmed
  // live that this account has none set right now — used for a
  // client-side "Reminders only" filter (UniboxPanel.tsx) rather than
  // trusting the API's own has_reminder query param, which was confirmed
  // to silently no-op (returns the exact same results with or without
  // it) rather than actually filtering.
  reminder_ts?: string | null;
  thread_id: string | null;
  content_preview: string | null;
  [key: string]: unknown;
}

/** Same enum as Lead.lt_interest_status/LEAD_STATUS_LABELS above, but this
 * is the CRM-style status pill shown at the top of an open Unibox
 * conversation in Instantly's own UI (the sidebar filter list there:
 * Lead/Interested/Meeting booked/Meeting completed/Won/...) — distinct
 * from LEAD_STATUS_LABELS' own set, which describes a lead's *sequence*
 * state (active/paused/bounced/unsubscribed), not this. `null` is the
 * default "Lead" bucket (no status set yet).
 */
export const INTEREST_STATUS_LABELS: Record<string, string> = {
  null: 'Lead',
  0: 'Out of office',
  1: 'Interested',
  2: 'Meeting booked',
  3: 'Meeting completed',
  4: 'Won',
  '-1': 'Not interested',
  '-2': 'Wrong person',
  '-3': 'Lost',
  '-4': 'No show',
};

export const INTEREST_STATUS_COLORS: Record<string, string> = {
  null: '#5b8def',
  0: '#8a8f98',
  1: '#2fae5c',
  2: '#8a5cf6',
  3: '#e08a2b',
  4: '#d4b106',
  '-1': '#e5484d',
  '-2': '#8a8f98',
  '-3': '#e5484d',
  '-4': '#8a8f98',
};

/** The core "which statuses show as their own top-level sidebar row"
 * list, matching Instantly's own Unibox sidebar exactly — everything else
 * (Out of office/Not interested/Wrong person/Lost/No show) collapses
 * under a "More" toggle there, same as the real product. */
export const PRIMARY_INTEREST_STATUSES: Array<number | null> = [null, 1, 2, 3, 4];
export const MORE_INTEREST_STATUSES: Array<number | null> = [0, -1, -2, -3, -4];

// Deliberately an intersection, not `Omit<InstantlyEmail, 'is_unread'> &
// {...}` — Omit/Pick don't preserve explicitly-declared field types on an
// interface that also has a `[key: string]: unknown` index signature (a
// real TS resolution quirk: every field silently widens back to
// `unknown`), confirmed directly when tsc flagged timestamp_email as
// `unknown` here despite InstantlyEmail declaring it `string`. A plain
// intersection narrows is_unread's `number | boolean` down to `boolean`
// without touching how the other fields resolve.
export type UniboxThreadEmail = InstantlyEmail & { is_unread: boolean };

export async function fetchInstantlyEmails(params: {
  limit?: number;
  starting_after?: string;
  is_unread?: boolean;
  eaccount?: string;
  campaign_id?: string;
  // See InstantlyEmail.reminder_ts's own doc comment — both confirmed
  // live to silently no-op server-side; passed through anyway (harmless,
  // real documented params) but UniboxPanel.tsx's "More" menu doesn't
  // rely on either alone for correctness.
  has_reminder?: boolean;
  scheduled_only?: boolean;
} = {}): Promise<InstantlyPage<UniboxThreadEmail>> {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  if (params.starting_after) q.set('starting_after', params.starting_after);
  if (params.is_unread !== undefined) q.set('is_unread', String(params.is_unread));
  if (params.eaccount) q.set('eaccount', params.eaccount);
  if (params.campaign_id) q.set('campaign_id', params.campaign_id);
  if (params.has_reminder) q.set('has_reminder', 'true');
  if (params.scheduled_only) q.set('scheduled_only', 'true');
  const qs = q.toString();
  const page = await localApiRequest<InstantlyPage<InstantlyEmail>>(`/api/instantly/emails${qs ? `?${qs}` : ''}`);
  return { ...page, items: page.items.map((e) => ({ ...e, is_unread: Boolean(Number(e.is_unread)) })) };
}

export function fetchInstantlyUnreadCount() {
  return localApiRequest<{ count: number }>('/api/instantly/emails/unread/count');
}

/** Sends a real email to a real prospect the instant it succeeds — no
 * confirmDialog gate (removed on explicit request, see useInstantlyInboxStore's
 * sendReply for the full reasoning). */
export function replyToInstantlyEmail(body: {
  reply_to_uuid: string;
  eaccount: string;
  subject: string;
  body: { html?: string; text?: string };
  additional_recipients?: string[];
}) {
  return localApiRequest<InstantlyEmail>('/api/instantly/emails/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function markInstantlyThreadRead(threadId: string) {
  return localApiRequest<{ status: string }>(`/api/instantly/emails/threads/${encodeURIComponent(threadId)}/mark-as-read`, {
    method: 'POST',
  });
}

/** Same real-side-effect caveat as replyToInstantlyEmail above. */
export function forwardInstantlyEmail(body: {
  reply_to_uuid: string;
  eaccount: string;
  to_address_email_list: string;
  subject: string;
  body?: { html?: string; text?: string };
}) {
  return localApiRequest<InstantlyEmail>('/api/instantly/emails/forward', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The editable status pill at the top of an open conversation. */
export function updateInstantlyLeadInterestStatus(params: { leadEmail: string; interestValue: number | null; campaignId?: string }) {
  return localApiRequest<{ status: string }>('/api/instantly/leads/interest-status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}
