// Real Google search results (via serper.dev, a Google-SERP-as-JSON proxy)
// for the Instagram/Facebook lookup feature — replaces the earlier
// approach of asking an LLM (even one with OpenAI's own web_search tool)
// to search and then report back what it found. That approach still
// produced real, reported failures: company pages instead of the person,
// or confidently-returned URLs that turned out not to exist. The
// difference here is architectural, not just "a better prompt": this
// module does zero judgment about *which* result is the right person — it
// runs a real search, keeps only URLs that are structurally actual
// profile pages (not posts/photos/groups/directory pages), and returns up
// to 5 real, freshly-fetched candidates per platform for a human to look
// at and pick from themselves. Same "AI/automation drafts, human reviews"
// pattern already used everywhere else in this app that touches something
// a person has to trust (contact-paste cleanup, LinkedIn message
// personalization) — here taken a step further: not even AI judgment is
// in the loop for *finding or picking* a profile, only real search +
// structural filtering. The one narrow exception is restoring likely
// Lithuanian diacritics in a plain-ASCII name before searching (see
// guessLithuanianDiacritics, imported below) — a language/spelling task,
// not a "who is this person" judgment call, and its output only ever
// feeds a search query, never gets treated as a verified fact.

import { guessLithuanianDiacritics } from './openai.js';

export class SerperError extends Error {}

interface SerperOrganicResult {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

interface SerperSearchResponse {
  organic?: SerperOrganicResult[];
}

export interface SerperNewsResult {
  title?: string;
  link?: string;
  snippet?: string;
  // serper.dev's own relative/absolute date string (e.g. "2 hours ago"),
  // not a parsed Date — kept as-is since it's display-only here (the news
  // feature sorts by this raw string only insofar as serper.dev's own News
  // ranking already orders results by recency/relevance; no parsing is
  // attempted).
  date?: string;
  source?: string;
  imageUrl?: string;
}

interface SerperNewsResponse {
  news?: SerperNewsResult[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A real, reported problem: a bare fetch() with no retry meant any
// transient network blip (a DNS hiccup, a dropped connection — confirmed
// separately that serper.dev itself and this account's API key both work
// fine under normal conditions) surfaced immediately as a hard failure,
// with the technical "Could not reach serper.dev" message shown directly
// to the user ("это просто писать эрор" — asked for something that
// doesn't read like the app itself is broken). Two quick retries with a
// short backoff absorb a one-off blip without meaningfully slowing down
// the common case where the first attempt just works; the user-facing
// message on final failure is now a plain, non-technical Lithuanian
// sentence, with the real cause still logged server-side (index.ts's
// error-mapping middleware) for actual debugging.
const MAX_ATTEMPTS = 3;
// fetch() has no default timeout — a request that hangs (rather than
// erroring outright) would previously wait indefinitely, with no retry
// ever kicking in since the catch block only sees actual failures, not
// slowness. A real, reported problem ("почему serpdev дает постоянно
// сбой системы") that couldn't be reproduced locally (this same key/
// endpoint responded cleanly in ~1.3s when tested directly) — pointing at
// something environment-specific to where the server actually runs
// (Render), which a hang-without-error would look like from the user's
// side: not a normal timeout message, just "it never works." An explicit
// 10s cap turns a silent hang into the same retried failure path every
// other network error already goes through.
const REQUEST_TIMEOUT_MS = 10_000;

// Shared by every serper.dev endpoint this file calls (plain web search,
// news search, ...) — same retry/timeout/error handling regardless of
// which one, so a new endpoint never has to re-derive this scaffolding.
async function serperRequest<T>(endpoint: string, query: string, apiKey: string): Promise<T> {
  let res: Response | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(`https://google.serper.dev/${endpoint}`, {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      break;
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        console.error(`serper.dev/${endpoint} unreachable after retries:`, err);
        throw new SerperError('Nepavyko pasiekti paieškos paslaugos — pabandykite dar kartą');
      }
      await sleep(attempt * 500);
    }
  }
  // A non-ok HTTP response (bad key, rate limit, malformed query) is a
  // real answer from serper.dev, not a transient blip — surfaced
  // immediately rather than retried, since retrying a permanent failure
  // three times would only add latency for nothing.
  const json = (await res!.json().catch(() => null)) as (T & { message?: string }) | null;
  if (!res!.ok || !json) {
    throw new SerperError((json as { message?: string } | null)?.message ?? `Search service request failed (HTTP ${res!.status})`);
  }
  return json;
}

async function serperSearch(query: string, apiKey: string): Promise<SerperOrganicResult[]> {
  const json = await serperRequest<SerperSearchResponse>('search', query, apiKey);
  return Array.isArray(json.organic) ? json.organic : [];
}

// Lithuanian/Baltic diacritics (Ą Č Ę Ė Į Š Ų Ū Ž and lowercase) all
// decompose under Unicode NFD into a plain ASCII base letter + a separate
// combining mark — stripping every combining mark in the U+0300–U+036F
// block after NFD-normalizing is a correct, general transliteration for
// this alphabet without a hand-written per-letter table. Same helper this
// codebase's earlier OpenAI-based lookup already used and verified.
function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// A real, reported accuracy gap this exists to close: a contact's stored
// name may or may not carry Lithuanian diacritics depending entirely on
// how it was typed/imported, but the person's actual social profile could
// be registered under *either* spelling. Rather than pick one, search both
// in a single query via an OR of quoted phrases — confirmed live this
// correctly finds a profile that only matches one of the two spellings,
// while still costing only one serper.dev credit (not two separate calls).
//
// This only covers the diacritics-present -> ASCII direction, which is
// pure deterministic Unicode normalization. The reverse — a name typed
// with NO diacritics at all, even though the real person's profile has
// them — is NOT something string manipulation alone can fix (plain "s"
// could come from "š" or genuinely be "s"), and confirmed live this is a
// real, common failure case, not a hypothetical: searching the plain-ASCII
// "Sarunas Marciulionis" found nothing at all, while the correctly-
// accented "Šarūnas Marčiulionis" immediately found the real profile. See
// guessLithuanianDiacritics() below for how that direction is covered.
function nameQueryClause(name: string, diacriticGuess: string | null): string {
  const variants = new Set([name]);
  const ascii = stripDiacritics(name);
  if (ascii !== name) variants.add(ascii);
  if (diacriticGuess) variants.add(diacriticGuess);
  if (variants.size === 1) return `"${name}"`;
  return `(${Array.from(variants)
    .map((v) => `"${v}"`)
    .join(' OR ')})`;
}

// Instagram/Facebook path segments that are never a person's own username
// — a search scoped to site:instagram.com/site:facebook.com still returns
// posts, reels, photos, and (on Facebook specifically) directory/"people
// named X" pages mixed in with real profiles, confirmed directly against
// live search results during development. Filtering these out is what
// keeps "up to 5 candidates" meaning "5 actual profiles to look at," not 5
// random pieces of content that happen to mention the name.
const INSTAGRAM_NON_PROFILE_SEGMENTS = new Set([
  'p', 'reel', 'reels', 'tv', 'stories', 'explore', 'direct', 'accounts', 'about', 'developer', 'legal', 'directory',
]);
const FACEBOOK_NON_PROFILE_SEGMENTS = new Set([
  'public', 'photo', 'photo.php', 'photos', 'posts', 'post', 'videos', 'video.php', 'story.php', 'permalink.php',
  'groups', 'pages', 'events', 'marketplace', 'watch', 'help', 'policies', 'business', 'ads', 'login', 'sharer',
  'plugins', 'media', 'notes', 'search',
]);

/** True only for a URL shaped like an actual Instagram profile page —
 * `instagram.com/{username}` (one path segment, not one of the reserved
 * non-profile words above). */
function isInstagramProfileUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^(www\.)?instagram\.com$/i.test(u.hostname)) return false;
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return false;
  return !INSTAGRAM_NON_PROFILE_SEGMENTS.has(segments[0].toLowerCase());
}

/** True for an actual Facebook profile/page URL — `facebook.com/{username}`
 * (one segment, not reserved) or the numeric-id form
 * `facebook.com/profile.php?id=...`. Facebook Pages (businesses) use the
 * exact same URL shape as personal profiles, so this can't structurally
 * tell a company page from a person — that ambiguity is real and is why
 * results are shown as candidates for a human to check, not auto-picked. */
function isFacebookProfileUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^(www\.)?facebook\.com$/i.test(u.hostname)) return false;
  if (u.pathname.toLowerCase() === '/profile.php' && u.searchParams.has('id')) return true;
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return false;
  return !FACEBOOK_NON_PROFILE_SEGMENTS.has(segments[0].toLowerCase());
}

function dedupeProfileUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    // Normalize away a trailing slash / query string for dedup purposes
    // only — the original URL (not this normalized form) is what's kept.
    const key = url.replace(/\/$/, '').split('?')[0].toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(url);
  }
  return result;
}

export interface SocialSearchResult {
  instagram: string[];
  facebook: string[];
}

const MAX_CANDIDATES_PER_PLATFORM = 5;

/** Real search, not AI guessing — see this file's own top-of-file doc
 * comment for the full reasoning. Two serper.dev calls total (one per
 * platform), each searching every spelling variant of the given name in a
 * single OR query: as typed, its diacritic-stripped ASCII form, and (when
 * the input has no diacritics at all) an LLM's best-guess restoration of
 * them — see guessLithuanianDiacritics()/nameQueryClause() above for why
 * that third variant matters; without it, a name typed without Lithuanian
 * diacritics found real profiles that ARE registered under them roughly
 * never, confirmed live. Deliberately does NOT take a `company` parameter
 * to narrow the query — a personal bio rarely mentions an employer, and
 * over-narrowing the query was a more likely cause of "finds nothing" than
 * a benefit; a human reviewing up to 5 named candidates can use company
 * context themselves far better than a search query string can. */
export async function searchSocialProfiles(
  params: { firstName: string; lastName: string },
  serperApiKey: string,
  // Optional — the diacritic-guess step is a best-effort accuracy
  // enhancement (see nameQueryClause's own doc comment), not a hard
  // requirement for this search to work at all, so a company that's
  // configured Serper but not OpenAI just skips it rather than failing
  // the whole lookup.
  openaiApiKey?: string,
): Promise<SocialSearchResult> {
  const name = [params.firstName, params.lastName].filter((s) => s?.trim()).join(' ').trim();
  if (!name) throw new SerperError('Reikia bent vardo, kad būtų galima ieškoti');

  // Only worth asking for when the name has no diacritics to begin with —
  // stripping (the other direction) is already free, deterministic string
  // manipulation with nothing to gain from an LLM call.
  const diacriticGuess =
    stripDiacritics(name) === name && openaiApiKey ? await guessLithuanianDiacritics(name, openaiApiKey) : null;

  const clause = nameQueryClause(name, diacriticGuess);
  const [instagramResults, facebookResults] = await Promise.all([
    serperSearch(`site:instagram.com ${clause}`, serperApiKey),
    serperSearch(`site:facebook.com ${clause}`, serperApiKey),
  ]);

  const instagram = dedupeProfileUrls(
    instagramResults.map((r) => r.link).filter((l): l is string => !!l && isInstagramProfileUrl(l)),
  ).slice(0, MAX_CANDIDATES_PER_PLATFORM);
  const facebook = dedupeProfileUrls(
    facebookResults.map((r) => r.link).filter((l): l is string => !!l && isFacebookProfileUrl(l)),
  ).slice(0, MAX_CANDIDATES_PER_PLATFORM);

  return { instagram, facebook };
}

/** One serper.dev `/news` call per topic (parallelized by the caller, same
 * "Promise.all, not sequential" shape as searchSocialProfiles' own two
 * platform calls above) — mirrors Google's own News tab for the given
 * query. No trend/virality scoring happens here or anywhere in this app:
 * "hottest" in the News tab just means Google's own News relevance
 * ranking for the topic, freshest-first once combined across topics by
 * the caller. A real trend signal (what people are actually searching for
 * right now, not just what's been published) would need a different
 * product (e.g. SerpApi's Google Trends engine) — deliberately not
 * integrated; Serper alone doesn't offer it. */
export async function searchNews(query: string, apiKey: string): Promise<SerperNewsResult[]> {
  const json = await serperRequest<SerperNewsResponse>('news', query, apiKey);
  return Array.isArray(json.news) ? json.news : [];
}
