import { localApiRequest } from './localApi';

/** Range filter shape shared by several Apollo params below (revenue,
 * headcount, funding, job-posting counts). */
export interface ApolloRange {
  min?: number;
  max?: number;
}

/** Every documented filter for POST /mixed_people/api_search — free to
 * call (0 credits), but rate-limited (confirmed against a real $59/mo
 * account: 200/min, 6000/hr, 50000/day). */
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
  revenue_range?: ApolloRange;
  currently_using_all_of_technology_uids?: string[];
  currently_using_any_of_technology_uids?: string[];
  currently_not_using_any_of_technology_uids?: string[];
  q_organization_job_titles?: string[];
  organization_job_locations?: string[];
  organization_num_jobs_range?: ApolloRange;
  organization_job_posted_at_range?: { min?: string; max?: string };
  contact_email_status?: string[];
  page?: number;
  per_page?: number;
}

/** A person result — email/phone are never present here regardless of
 * plan; only enrichPerson() below can reveal them (and it costs credits).
 * The index signature keeps every field Apollo actually returns reachable
 * — the account carries more than the public docs list. */
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
  organization: { name: string | null; [key: string]: unknown } | null;
  [key: string]: unknown;
}

/** Every documented filter for POST /mixed_companies/search — unlike
 * people search, this one costs Apollo credits: "1 credit per page" (up
 * to 100 results). */
export interface CompanySearchParams {
  q_organization_domains_list?: string[];
  q_organization_name?: string;
  organization_num_employees_ranges?: string[];
  organization_locations?: string[];
  organization_not_locations?: string[];
  revenue_range?: ApolloRange;
  currently_using_all_of_technology_uids?: string[];
  currently_using_any_of_technology_uids?: string[];
  currently_not_using_any_of_technology_uids?: string[];
  q_organization_keyword_tags?: string[];
  latest_funding_amount_range?: ApolloRange;
  total_funding_range?: ApolloRange;
  latest_funding_date_range?: { min?: string; max?: string };
  organization_job_posted_at_range?: { min?: string; max?: string };
  q_organization_job_titles?: string[];
  organization_job_locations?: string[];
  page?: number;
  per_page?: number;
}

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

/** Identifying fields for POST /people/match — give it as many as you
 * have; `id` from a prior search result is the most reliable. Costs real
 * credits: 1 if an email is found, +8 more if a phone number is found (0
 * if neither). Server fills in webhook_url automatically whenever
 * reveal_phone_number is set — see server/src/index.ts. */
export interface PeopleEnrichParams {
  id?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  domain?: string;
  organization_name?: string;
  linkedin_url?: string;
  reveal_personal_emails?: boolean;
  reveal_phone_number?: boolean;
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
  contact?: {
    email: string | null;
    phone_numbers?: ApolloPhoneNumber[];
    [key: string]: unknown;
  };
  organization?: { name: string | null; domain: string | null; [key: string]: unknown };
  [key: string]: unknown;
}

/** Apollo tags every phone number it returns with a `type` (the
 * synchronous person.contact.phone_numbers shape) or `type_cd` (the async
 * webhook_result shape) field — real observed values include "mobile" and
 * "work_hq" (the company's own switchboard, not anything specific to this
 * person), confirmed live against Apollo's actual API for a real contact.
 * Neither shape's array order is a documented "most personal first"
 * contract, and for that same real contact "work_hq" sat ahead of
 * "mobile" — this is what caused a real, reported bug (a saved contact's
 * phone ending up as the company's front-desk number instead of their own
 * mobile) when the code simply took phoneNumbers[0]. See
 * pickBestPhoneNumber below, which every phone-selecting call site should
 * go through instead of indexing the array directly. */
export interface ApolloPhoneNumber {
  sanitized_number: string;
  raw_number?: string;
  type?: string | null;
  type_cd?: string | null;
  [key: string]: unknown;
}

// Lower tier = preferred. A personal mobile number is what "this
// person's phone number" should mean; a company switchboard (work_hq) is
// the least specific answer to that question, so it's ranked last rather
// than excluded outright — still better than no number at all. Missing/
// unrecognized type values sit in the middle: no better than a known
// personal number, no worse than a known company one.
const PHONE_TYPE_TIER: Record<string, number> = {
  mobile: 0,
  cell: 0,
  work_direct: 1,
  direct_dial: 1,
  home: 2,
  other: 2,
  work_hq: 3,
};

function phoneTypeTier(entry: ApolloPhoneNumber): number {
  const key = (entry.type ?? entry.type_cd ?? '').toLowerCase();
  return PHONE_TYPE_TIER[key] ?? 2;
}

/** Picks the single best phone number out of an Apollo phone_numbers
 * array, ranked by type (see PHONE_TYPE_TIER above) rather than by
 * whatever position Apollo happened to return it in. Ties keep the
 * earlier entry, so array order still acts as a tiebreaker between two
 * numbers of the same tier — it's only trusted as the sole signal when
 * genuinely nothing else distinguishes them. */
export function pickBestPhoneNumber<T extends ApolloPhoneNumber>(entries: T[] | undefined | null): T | undefined {
  if (!entries || entries.length === 0) return undefined;
  let best = entries[0];
  let bestTier = phoneTypeTier(best);
  for (let i = 1; i < entries.length; i++) {
    const tier = phoneTypeTier(entries[i]);
    if (tier < bestTier) {
      best = entries[i];
      bestTier = tier;
    }
  }
  return best;
}

export interface PhoneEnrichmentInfo {
  request_id?: string;
  status: string;
  message?: string;
}

/** GET /api/apollo/webhook/:requestId — polled after enrichPerson() with
 * reveal_phone_number:true, using the response's own top-level
 * `request_id` — NOT `phone_enrichment.request_id`, which looks like it
 * should be the right one but is a different, unrelated id that this
 * endpoint always rejects. See server/src/apollo.ts's pollWebhookResult
 * for how this was confirmed (a real JS number-precision bug, not an
 * Apollo-side permission issue as first suspected) and enrichPerson for
 * why the top-level id is the correct one to use. */
export type PhonePollResult =
  | { status: 'processing'; retryAfterSeconds: number }
  | { status: 'ready'; phoneNumbers: Array<ApolloPhoneNumber & { status_cd?: string; confidence_cd?: string | null }> }
  | { status: 'error'; message: string };

export function pollPhoneReveal(requestId: string): Promise<PhonePollResult> {
  return localApiRequest(`/api/apollo/webhook/${encodeURIComponent(requestId)}`);
}

/** Not actually an Apollo call (goes through server/src/openai.ts) — kept
 * here since it exists purely to make the "Pareigos" filter's free-typed
 * entries match better against Apollo's English-indexed database
 * (PeopleFilterForm.tsx). Always resolves (never rejects) — the server
 * route falls back to the original text on any translation failure, so
 * this never blocks a filter chip from being added. */
export function translateJobTitle(title: string): Promise<{ title: string }> {
  return localApiRequest('/api/search/translate-title', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
}

export function searchPeople(
  params: PeopleSearchParams,
): Promise<{ people: ApolloSearchPerson[]; total_entries: number; page: number }> {
  return localApiRequest('/api/apollo/people/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export function searchCompanies(
  params: CompanySearchParams,
): Promise<{ companies: ApolloCompany[]; total_entries: number; page: number }> {
  return localApiRequest('/api/apollo/companies/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}

export function enrichPerson(
  params: PeopleEnrichParams,
): Promise<{ person: ApolloEnrichedPerson | null; request_id?: string; phone_enrichment?: PhoneEnrichmentInfo }> {
  return localApiRequest('/api/apollo/people/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}
