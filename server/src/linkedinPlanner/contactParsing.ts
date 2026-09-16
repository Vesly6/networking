/** Server-side port of app/src/utils/contacts.ts's LinkedIn-detection
 * logic — duplicated, not imported, since this codebase has no shared
 * module across the frontend/server boundary (every other small
 * cross-boundary utility here is copied the same way, e.g.
 * instantlyReplySync.ts's own copy of INTEREST_STATUS_LABELS). Keep this
 * in sync by hand if the client's own LINKEDIN_PATTERN ever changes. */

// Identical to contacts.ts's own LINKEDIN_PATTERN — matches a LinkedIn
// profile/company URL anywhere in a contact's freeform text.
const LINKEDIN_PATTERN = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s,"{}[\]]*/i;

export type LinkedinProfileType = 'person' | 'company' | 'unrecognized';

/** Finds the first LinkedIn-shaped URL in a piece of text (a contact
 * entry's freeform `text`, or a `link`-type column's raw cell value), or
 * null if there isn't one. Only the first match matters — a `contact`
 * entry describes exactly one person, and a `link` column holds exactly
 * one URL. */
export function findLinkedinUrl(text: string): string | null {
  const match = LINKEDIN_PATTERN.exec(text);
  return match ? match[0] : null;
}

/** Normalizes a raw LinkedIn URL into the stable dedup key used across
 * `planner_tasks.normalized_linkedin_url` — lowercased, no protocol, no
 * `www.`/two-letter-locale subdomain, no trailing slash, no query string
 * (tracking/UTM params). Two URLs that only differ in exactly those ways
 * ("https://www.linkedin.com/in/jonas/?utm_source=x" vs.
 * "linkedin.com/in/jonas") must normalize identically, or the same real
 * person could end up as two separate tasks. */
export function normalizeLinkedinUrl(rawUrl: string): string {
  let url = rawUrl.trim().toLowerCase();
  url = url.replace(/^https?:\/\//, '');
  url = url.replace(/^(?:[a-z]{2,3}\.)?linkedin\.com/, 'linkedin.com');
  url = url.replace(/^linkedin\.com\/(?:www\.)?/, 'linkedin.com/');
  const queryIndex = url.indexOf('?');
  if (queryIndex !== -1) url = url.slice(0, queryIndex);
  url = url.replace(/\/+$/, '');
  return url;
}

/** A normalized URL's path segment right after "linkedin.com/" decides
 * whether this is a real person (the only type that ever enters the
 * active send queue — you can't send a connection request to a company),
 * a company page (recorded and filterable, excluded from the funnel/
 * daily-limit counters), or something else entirely (routed to "Requires
 * review," never auto-entering the queue). */
export function classifyLinkedinUrl(normalizedUrl: string): LinkedinProfileType {
  const path = normalizedUrl.replace(/^linkedin\.com\//, '');
  if (/^in\//.test(path)) return 'person';
  if (/^company\//.test(path)) return 'company';
  return 'unrecognized';
}

/** Minimal server-side mirror of contacts.ts's ContactEntry shape — only
 * the two fields the Planner's sync logic actually needs. A `contact`-
 * type column's cell value is a JSON array of these (or, for pre-JSON
 * legacy data, a bare string treated as one entry — same fallback
 * contacts.ts's own parseContacts uses). */
export interface PlannerContactEntry {
  id: string;
  text: string;
}

// Same shape/order as app/src/utils/contacts.ts's own field-extraction
// regexes — ported here only for the Planner's own display purposes (a
// person's name/title/company from their contact entry's freeform text),
// not full fidelity with every edge case the client's own editor UI
// handles.
const EMAIL_SEARCH_PATTERN = /[^\s,"{}[\]]+@[^\s,"{}[\]]+\.[^\s,"{}[\]]+/;
const PHONE_PATTERN = /\+?\d[\d\s().-]{6,}\d/;
const INSTAGRAM_PATTERN = /https?:\/\/(?:www\.)?instagram\.com\/[^\s,"{}[\]]*/i;
const FACEBOOK_PATTERN = /https?:\/\/(?:www\.)?facebook\.com\/[^\s,"{}[\]]*/i;

export interface PlannerPersonFields {
  name: string;
  title: string | null;
  company: string | null;
}

/** Strips every detectable link/email/phone out of a contact entry's
 * freeform text, then reads the name/title/company off whatever's left,
 * in that order — mirrors contacts.ts's splitContactDisplayFields just
 * enough for the Planner's own read-only display, never written back
 * anywhere. */
export function splitPersonFields(text: string): PlannerPersonFields {
  let remaining = text;
  for (const pattern of [LINKEDIN_PATTERN, INSTAGRAM_PATTERN, FACEBOOK_PATTERN, EMAIL_SEARCH_PATTERN, PHONE_PATTERN]) {
    const m = pattern.exec(remaining);
    if (m) remaining = remaining.slice(0, m.index) + remaining.slice(m.index + m[0].length);
  }
  const parts = remaining
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return { name: parts[0] ?? '', title: parts[1] ?? null, company: parts[2] ?? null };
}

export function parseContactEntriesForPlanner(raw: string): PlannerContactEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((e) => e && typeof e === 'object')) {
      return parsed.map((e) => ({
        id: typeof e.id === 'string' ? e.id : '',
        text: typeof e.text === 'string' ? e.text : '',
      }));
    }
  } catch {
    // Not JSON — legacy plain text falls through below.
  }
  const trimmed = raw.trim();
  return trimmed ? [{ id: 'legacy', text: trimmed }] : [];
}
