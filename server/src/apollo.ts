const API_BASE = 'https://api.apollo.io/api/v1';

export class ApolloApiError extends Error {
  raw: unknown;
  status: number;
  constructor(message: string, status: number, raw: unknown) {
    super(message);
    this.status = status;
    this.raw = raw;
  }
}

function getApiKey(): string {
  const key = process.env.APOLLO_API_KEY;
  if (!key) {
    throw new Error('APOLLO_API_KEY is not set — check server/.env');
  }
  return key;
}

async function callApollo<T>(path: string, body: Record<string, unknown>): Promise<T> {
  // Undefined values are dropped by JSON.stringify automatically — unlike
  // Zadarma's hand-signed query strings elsewhere in this server, there's
  // no separate "build the params string" step here to accidentally filter
  // by truthiness instead, so 0/false-valued filters (e.g. a revenue_range
  // min of 0) pass through correctly with no special handling needed.
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'x-api-key': getApiKey(),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApolloApiError('Could not reach Apollo API', 0, null);
  }

  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (json && typeof json === 'object' && 'error' in json && typeof (json as { error: unknown }).error === 'string'
        ? (json as { error: string }).error
        : null) ?? `Apollo request failed (HTTP ${res.status})`;
    throw new ApolloApiError(message, res.status, json);
  }
  return json as T;
}

/** A range filter — Apollo's docs write these as bracket-suffixed query
 * keys (`revenue_range[min]`), which is just their documentation's way of
 * describing a nested object; the JSON API (what this proxy actually
 * calls, confirmed against a real account) takes a plain nested object. */
export interface RangeFilter {
  min?: number;
  max?: number;
}

/** Every documented filter for POST /mixed_people/api_search, passed
 * through close to verbatim — this is deliberately NOT trimmed down to
 * "the common ones": the whole point of exposing this from the Search tab
 * is letting the filter panel offer everything Apollo itself offers, not
 * a curated subset. Free to call — 0 credits — but still rate-limited
 * (confirmed against a real $59/mo account: 200/min, 6000/hr, 50000/day;
 * check current usage via x-*-requests-left response headers if this
 * ever needs surfacing in the UI). */
export interface PeopleSearchParams {
  person_titles?: string[];
  include_similar_titles?: boolean;
  person_locations?: string[];
  person_seniorities?: string[];
  q_keywords?: string;
  organization_locations?: string[];
  q_organization_domains_list?: string[];
  organization_ids?: string[];
  organization_num_employees_ranges?: string[];
  revenue_range?: RangeFilter;
  currently_using_all_of_technology_uids?: string[];
  currently_using_any_of_technology_uids?: string[];
  currently_not_using_any_of_technology_uids?: string[];
  q_organization_job_titles?: string[];
  organization_job_locations?: string[];
  organization_num_jobs_range?: RangeFilter;
  organization_job_posted_at_range?: { min?: string; max?: string };
  contact_email_status?: string[];
  page?: number;
  per_page?: number;
}

/** A person record from search results — deliberately does NOT include
 * email/phone (Apollo never returns those from search, regardless of
 * plan or credits — see enrichPerson below for the only way to get
 * them). last_name is obfuscated ("Ma***x") until enriched. The known
 * common fields are typed explicitly for IntelliSense; the index
 * signature keeps everything else Apollo returns (and there's more than
 * the docs list) reachable from the frontend instead of silently
 * clipped at this type boundary — matching "expose everything Apollo
 * gives," not a curated subset. */
export interface ApolloSearchPerson {
  id: string;
  first_name: string | null;
  last_name_obfuscated: string | null;
  title: string | null;
  last_refreshed_at: string | null;
  has_email: boolean;
  has_city: boolean;
  has_state: boolean;
  has_country: boolean;
  has_direct_phone: string | boolean;
  organization: {
    name: string | null;
    has_industry?: boolean;
    has_phone?: boolean;
    has_city?: boolean;
    has_state?: boolean;
    has_country?: boolean;
    has_zip_code?: boolean;
    has_revenue?: boolean;
    has_employee_count?: boolean;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export async function searchPeople(
  params: PeopleSearchParams,
): Promise<{ people: ApolloSearchPerson[]; total_entries: number; page: number }> {
  return callApollo('/mixed_people/api_search', params as Record<string, unknown>);
}

/** Every documented filter for POST /mixed_companies/search. Unlike people
 * search, this one is NOT free — Apollo bills "1 credit per page" (up to
 * 100 companies/page), confirmed by the docs (not directly observable via
 * response headers, which only expose rate-limit counters, not credit
 * balance — check Apollo's own dashboard to see the actual spend). */
export interface CompanySearchParams {
  q_organization_domains_list?: string[];
  q_organization_name?: string;
  organization_num_employees_ranges?: string[];
  organization_locations?: string[];
  organization_not_locations?: string[];
  revenue_range?: RangeFilter;
  currently_using_all_of_technology_uids?: string[];
  currently_using_any_of_technology_uids?: string[];
  currently_not_using_any_of_technology_uids?: string[];
  q_organization_keyword_tags?: string[];
  latest_funding_amount_range?: RangeFilter;
  total_funding_range?: RangeFilter;
  latest_funding_date_range?: { min?: string; max?: string };
  organization_job_posted_at_range?: { min?: string; max?: string };
  q_organization_job_titles?: string[];
  organization_job_locations?: string[];
  page?: number;
  per_page?: number;
}

/** A company/"account" record — Apollo's own field name for this in the
 * response is `accounts`, not `organizations` (confirmed against a real
 * response), which is why searchCompanies below remaps it to the more
 * predictable `companies` for this app's own API shape. The real response
 * carries considerably more than the docs list — revenue estimates,
 * headcount growth percentages, full street address, num_contacts,
 * Apollo CRM stage/ownership fields (this account's own saved accounts
 * surface here too, not just the global database) — all reachable via
 * the index signature rather than clipped to the few fields typed below. */
export interface ApolloCompany {
  id: string;
  name: string | null;
  website_url: string | null;
  primary_domain: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  facebook_url: string | null;
  phone: string | null;
  founded_year: number | null;
  publicly_traded_symbol: string | null;
  publicly_traded_exchange: string | null;
  logo_url: string | null;
  languages: string[] | null;
  organization_revenue?: number | null;
  organization_revenue_printed?: string | null;
  organization_city?: string | null;
  organization_state?: string | null;
  organization_country?: string | null;
  organization_street_address?: string | null;
  organization_postal_code?: string | null;
  num_contacts?: number | null;
  [key: string]: unknown;
}

export async function searchCompanies(
  params: CompanySearchParams,
): Promise<{ companies: ApolloCompany[]; total_entries: number; page: number }> {
  const result = await callApollo<{ accounts: ApolloCompany[]; pagination?: { total_entries: number; page: number } }>(
    '/mixed_companies/search',
    params as Record<string, unknown>,
  );
  return {
    companies: result.accounts ?? [],
    total_entries: result.pagination?.total_entries ?? 0,
    page: result.pagination?.page ?? params.page ?? 1,
  };
}

/** Every documented identifying field for POST /people/match — the only
 * endpoint that actually returns email/phone. Give it as many identifiers
 * as you have (id from a prior search result is the most reliable); more
 * detail improves match accuracy. Costs real credits: 1 if an email is
 * found, +8 more on top if a phone number is found (0 if neither is
 * found). reveal_phone_number specifically requires webhook_url — Apollo
 * delivers the phone number asynchronously via that webhook, sometimes
 * minutes later, rather than in this call's own response. */
export interface PeopleEnrichParams {
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  hashed_email?: string;
  domain?: string;
  organization_name?: string;
  id?: string;
  linkedin_url?: string;
  reveal_personal_emails?: boolean;
  reveal_phone_number?: boolean;
  webhook_url?: string;
}

export interface ApolloEnrichedPerson {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  email_status: string | null;
  linkedin_url: string | null;
  title: string | null;
  headline: string | null;
  organization_id: string | null;
  employment_history?: Array<{
    organization_name: string | null;
    title: string | null;
    start_date: string | null;
    end_date: string | null;
    current: boolean;
    [key: string]: unknown;
  }>;
  contact?: {
    id: string;
    email: string | null;
    phone_numbers?: Array<{ raw_number: string; sanitized_number: string; status: string }>;
    [key: string]: unknown;
  };
  organization?: {
    id: string;
    name: string | null;
    domain: string | null;
    industry: string | null;
    employees: number | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export async function enrichPerson(params: PeopleEnrichParams): Promise<{
  person: ApolloEnrichedPerson | null;
  request_id?: string | number;
  // Only present when reveal_phone_number was requested — its own
  // request_id is what pollWebhookResult()/GET /webhook_result/:id below
  // actually needs, NOT the top-level request_id above (confirmed by
  // testing both against a real account: the top-level id — a large
  // signed int, matching what the polling endpoint's docs describe —
  // consistently comes back "request_id_unknown" even freshly issued and
  // exactly as received with no precision loss; this nested id is a
  // different, Mongo-ObjectId-shaped string that the polling endpoint
  // instead rejects outright as "invalid_request_id". Neither candidate
  // has been made to work end-to-end — see the long comment on
  // pollWebhookResult below).
  phone_enrichment?: { request_id?: string; status: string; message?: string };
}> {
  return callApollo('/people/match', params as Record<string, unknown>);
}

/** GET /webhook_result/{request_id} — the documented way to retrieve a
 * phone number after enrichPerson({reveal_phone_number: true, ...}), as
 * an alternative to actually receiving Apollo's async webhook POST. Used
 * instead of standing up a real webhook payload parser: webhook_url is
 * still a mandatory param when reveal_phone_number is true (so index.ts
 * exposes a trivial public POST /api/apollo/webhook that just 200s and
 * discards the body — Apollo's push still "succeeds" from its side even
 * though nothing reads it), but the *documented, stable* response shape
 * here is what the frontend actually polls against.
 *
 * A 404 means "still processing" (not "not found") — Apollo returns
 * retry_after_seconds alongside it, which the caller should wait before
 * polling again. 400/410 are terminal (bad id / result expired after 30
 * days) and shouldn't be retried.
 *
 * UNRESOLVED as of writing: neither id this app has access to — the
 * top-level enrichPerson() response's `request_id` (a large signed int,
 * matching this endpoint's documented format) nor the nested
 * `phone_enrichment.request_id` (a Mongo-ObjectId-shaped string) — was
 * made to work against a real account. The signed-int one consistently
 * comes back 404 "request_id_unknown" (tested with the exact, unaltered
 * value straight from Apollo's own response — precision loss in transit
 * was ruled out explicitly); the ObjectId one comes back 400
 * "invalid_request_id" outright. Both were tested repeatedly, including
 * waiting several minutes for "still processing" to plausibly resolve.
 * Given this codebase's own precedent (the ElevenLabs speech-to-text
 * permission gap, resolved only by checking scopes on ElevenLabs'
 * dashboard directly — see the Calls tab section of CLAUDE.md), the most
 * likely explanation is a similar per-key scope/permission gap on this
 * Apollo account for webhook_result_read specifically, not a bug in this
 * request. If phone reveal ever needs debugging again, check that before
 * re-suspecting the id/format logic here — it's been ruled out. */
export type WebhookPollResult =
  | { status: 'processing'; retryAfterSeconds: number }
  | { status: 'ready'; phoneNumbers: Array<{ sanitized_number: string; status_cd?: string; confidence_cd?: string | null }> }
  | { status: 'error'; message: string };

export async function pollWebhookResult(requestId: string): Promise<WebhookPollResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/webhook_result/${encodeURIComponent(requestId)}`, {
      headers: { 'x-api-key': getApiKey() },
    });
  } catch {
    throw new ApolloApiError('Could not reach Apollo API', 0, null);
  }

  if (res.status === 404) {
    const json: unknown = await res.json().catch(() => null);
    const retryAfterSeconds =
      json && typeof json === 'object' && 'retry_after_seconds' in json && typeof (json as { retry_after_seconds: unknown }).retry_after_seconds === 'number'
        ? (json as { retry_after_seconds: number }).retry_after_seconds
        : 10;
    return { status: 'processing', retryAfterSeconds };
  }
  if (res.status === 400 || res.status === 410) {
    return { status: 'error', message: res.status === 410 ? 'This phone lookup result has expired (older than 30 days)' : 'Invalid lookup id' };
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) {
    throw new ApolloApiError(`Apollo webhook poll failed (HTTP ${res.status})`, res.status, json);
  }
  if (json.webhook_status === 'failed') {
    return { status: 'error', message: json.failure_reason ?? 'Apollo could not find a phone number' };
  }
  if (json.webhook_status === 'in_progress') {
    return { status: 'processing', retryAfterSeconds: 10 };
  }
  const phoneNumbers = json.webhook_result?.people?.[0]?.phone_numbers ?? [];
  return { status: 'ready', phoneNumbers };
}
