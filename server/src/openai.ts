function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OPENAI_API_KEY is not set — check server/.env');
  }
  return key;
}

export class ContactParseError extends Error {}

const CONTACT_PARSE_MODEL = 'gpt-4o-mini';

const CONTACT_PARSE_SYSTEM_PROMPT = `You clean up contact info pasted from lead databases (Apollo, LinkedIn, etc.) into one tidy line.
Extract: full name, job title, company, email, and the one real phone number.
Ignore placeholder/masked values that aren't real phone numbers (e.g. a bare "+1" with no other digits, repeated meaningless short codes).
Output ONLY the cleaned line as: Name, Title, Company, email, phone — omit any field that's genuinely missing. No explanation, no extra text, just the one line.`;

/** Cheap ($0.15/1M input tokens as of writing — a pasted contact blob is a
 * few dozen tokens) chat-completion call, not the transcription model. */
export async function parseContactText(rawText: string): Promise<{ text: string }> {
  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CONTACT_PARSE_MODEL,
        messages: [
          { role: 'system', content: CONTACT_PARSE_SYSTEM_PROMPT },
          { role: 'user', content: rawText },
        ],
        temperature: 0,
      }),
    });
  } catch {
    throw new ContactParseError('Could not reach OpenAI');
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) {
    throw new ContactParseError(json?.error?.message ?? `OpenAI request failed (HTTP ${res.status})`);
  }
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new ContactParseError('OpenAI returned an empty result');
  return { text };
}

export class SummarizeError extends Error {}

const SUMMARIZE_MODEL = 'gpt-4o-mini';

// Lithuanian output, matching the source transcript's language — an
// earlier version summarized in English (matching this app's own UI
// language) on the reasoning that a short English gloss is a faster skim
// than the full Lithuanian transcript. Reversed on explicit request: the
// person reading this is working the account in Lithuanian day to day,
// so a summary in a different language than the call itself is a worse
// fit than the original "faster skim" reasoning assumed.
//
// The fixed "3-5 sentences" cap this used to have was a real, reported
// problem: on a genuinely long, detail-dense call it compressed down to a
// few generic sentences — "summary came out to 5-10% of what was actually
// discussed," in the user's own words. Removing the cap and switching to
// one-bullet-per-topic (below) helped a lot, but wasn't the whole fix: a
// second round of the exact same real call still silently dropped an
// entire topic (a several-exchange-long tangent about possibly expanding
// into Indonesia/Vietnam/South America) even though everything else was
// covered in good detail. The model was implicitly triaging "important
// vs. skippable" mid-summary and treating an exploratory, hedged tangent
// (the caller couldn't fully answer it, said a sales manager would know
// more) as skippable — reproduced directly, confirmed against the same
// transcript twice. The fix is the "first inventory, then write" structure
// below, plus an explicit instruction that hedged/hypothetical/tangential
// exchanges still count, plus temperature 0 (was 0.3) so this doesn't
// vary run to run on the same input.
const SUMMARIZE_SYSTEM_PROMPT = `You summarize Lithuanian B2B sales/cold-call transcripts for a CRM record. The call may be entirely in Lithuanian, or code-switch into English business jargon mid-sentence — read all of it, start to finish, before writing anything.

Step 1 (internal, do not output): mentally walk through the call in chronological order and list every distinct topic, question, or exchange that came up — including ones that were brief, tangential, speculative/hypothetical, or that the speaker explicitly said they couldn't fully answer (e.g. "would you consider expanding into region X", "I don't have experience there but let me check", a side-question that trailed off). A topic being short, uncertain, or not fully resolved is NOT a reason to leave it out — it still gets its own bullet in step 2. Do not silently triage topics as "important" vs "skippable"; every distinct thing that was actually raised belongs in the summary.

Step 2 (output): write the summary IN LITHUANIAN as bullet points (each starting with "- "), one bullet per topic/exchange from your step-1 list, in the same chronological order they came up in the call. There is no fixed bullet count and no length cap — a short, thin call gets few bullets (or the one-sentence fallback below); a call with 10, 15, or more distinct exchanges should get that many bullets, not a handful that only gesture at the busiest ones. For each bullet, keep every concrete detail exact — names, companies, roles, numbers, percentages, money amounts, dates, named locations/countries/regions — never round a number, generalize a name, or drop a detail that was actually said.

If the call was very short or nothing meaningful was said (e.g. wrong number, immediate hangup, pure voicemail), skip the bullet format and write one plain sentence instead.
Output ONLY the final summary from step 2 (bullets or the one-sentence fallback) — no headers, no preamble, no closing remarks, and none of your step-1 working notes.`;

/** Same cheap chat-completion model as parseContactText — this is a
 * derived, secondary artifact of an already-paid-for transcript, not a
 * second transcription, so keeping it inexpensive matters: a summary
 * nobody explicitly asked to pay more for. */
export async function summarizeCall(transcriptText: string): Promise<{ summary: string }> {
  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: SUMMARIZE_MODEL,
        messages: [
          { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
          { role: 'user', content: transcriptText },
        ],
        // 0, not 0.3 — this used to visibly vary run to run on the exact
        // same transcript (confirmed: one run covered the Indonesia
        // tangent, a second one on the same input dropped it entirely).
        // Lower variance matters more here than any benefit more
        // "creative" phrasing would add to a factual summary.
        temperature: 0,
      }),
    });
  } catch {
    throw new SummarizeError('Could not reach OpenAI');
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) {
    throw new SummarizeError(json?.error?.message ?? `OpenAI request failed (HTTP ${res.status})`);
  }
  const summary = json.choices?.[0]?.message?.content?.trim();
  if (!summary) throw new SummarizeError('OpenAI returned an empty result');
  return { summary };
}

export class SocialLookupError extends Error {}

// gpt-4o-mini's Chat Completions endpoint (used by everything else in this
// file) has no live web access at all — asked to name someone's Instagram/
// Facebook URL directly, it can only guess from training data, and a wrong
// guess presented as a real profile is worse than finding nothing (this is
// used to actually contact real people). The Responses API's built-in
// web_search tool is a different thing: the model issues a real search,
// gets real result snippets back, and grounds its answer in those — this
// was verified directly against two real, born-with-search-results
// results (Bill Gates' actual public Instagram/Facebook, and a second
// person where it correctly returned an empty array for the platform it
// couldn't confidently find rather than guessing).
const SOCIAL_LOOKUP_MODEL = 'gpt-4o-mini';

const SOCIAL_LOOKUP_SYSTEM_PROMPT = `You search the public web to find a specific person's real Instagram and Facebook profile pages, for a B2B sales CRM contact record. Use the person's name and company/job context to disambiguate from other people who share the same name — prefer profiles whose bio, posts, or connections reference the same company, industry, or location.

The person's name may be Lithuanian (or another Baltic/diacritic-using language) and may be given to you both with and without its native diacritics (e.g. "Ušackas" and its plain-ASCII spelling "Usackas") — real profiles inconsistently use either form (some people register their own profile with the ASCII spelling for an international audience or keyboard convenience; some platforms/exports strip diacritics automatically; some don't). Whenever both spellings are given below, search using BOTH — a profile that only matches the ASCII spelling is just as valid a find as one that only matches the diacritic spelling, and skipping one form is a real, reported way this search misses the correct person entirely.

Only the diacritics-present -> ASCII direction is given to you automatically (a plain, deterministic transliteration). The reverse also happens just as often — a name arrives with NO diacritics at all (e.g. a CRM record typed without a Lithuanian keyboard, or from an English-language export), even though the person's real name and real profile use them. Restoring the correct diacritics isn't mechanical — plain "s"/"c"/"z" could come from "š"/"č"/"ž", plain "u"/"e"/"i"/"a" could come from "ų"/"ū"/"ė"/"į"/"ą" — so use your own knowledge of common Lithuanian name spellings to also try the most plausible diacritic form(s) of an ASCII-only name yourself, the same way a native speaker would recognize "Usackas" as almost certainly "Ušackas". Try more than one restoration if genuinely ambiguous, but don't invent a spelling so unusual it's more likely wrong than right.

A candidate profile's own displayed name must plausibly match BOTH the given first name AND last name — not the surname alone. Surnames are shared by many unrelated people (including, often, close relatives), and a search that's lenient enough to try diacritic variants must NOT become lenient about which person it's willing to call a match: a profile belonging to a *different* first name than the one given is not this person, even if the surname is an exact or diacritic-variant match, and even if that other person is more prominent/easier to find. Only loosen the first-name match for genuinely equivalent forms of the *same* given name (a nickname, an initial, a diacritic variant of the same name) — never for a different name entirely.

Never guess or fabricate a URL: only return a URL you actually found in search results. If you cannot find a confident match on a platform, return an empty array for that platform rather than a low-confidence guess — a human will manually open and visually verify every candidate you return before anything is saved, so returning fewer, more plausible candidates is always better than more, weaker ones.

Return ONLY a JSON object: {"instagram": ["url", ...], "facebook": ["url", ...]} — up to 3 candidates per platform, most likely match first, real instagram.com/facebook.com profile URLs only (no other domains). No explanation, no markdown, just the JSON.`;

export interface SocialLookupResult {
  instagram: string[];
  facebook: string[];
}

const isInstagramUrl = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\/(www\.)?instagram\.com\//i.test(u);
const isFacebookUrl = (u: unknown): u is string => typeof u === 'string' && /^https?:\/\/(www\.)?facebook\.com\//i.test(u);

// Lithuanian/Baltic diacritics (Ą Č Ę Ė Į Š Ų Ū Ž and lowercase) all decompose
// under Unicode NFD into a plain ASCII base letter + a separate combining
// mark (e.g. Š -> S + U+030C COMBINING CARON) — stripping every combining
// mark in the U+0300–U+036F block after NFD-normalizing is a correct,
// general transliteration for this alphabet without needing a hand-written
// per-letter table. Confirmed directly: "Ušackas" -> "Usackas", "Šarūnas"
// -> "Sarunas", etc.
function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// A real, reported accuracy bug: a contact's stored name might carry
// Lithuanian diacritics or might not (depends entirely on how it was
// typed/pasted/imported), but the person's actual social profile could be
// registered under *either* spelling — searching only the one spelling the
// contact happens to be stored under silently misses real matches, or
// worse, matches a different namesake. This gives the model both spellings
// explicitly (when they actually differ) instead of leaving it to guess.
function withDiacriticVariant(value: string): string {
  const ascii = stripDiacritics(value);
  return ascii !== value ? `${value} (also: ${ascii})` : value;
}

/** Uses OpenAI's Responses API (not the Chat Completions endpoint every
 * other function in this file uses) with the built-in web_search tool —
 * the only way this server can ground a search in real, current web
 * results rather than the model's own (possibly wrong, possibly outdated)
 * training data. Real, per-call cost: confirmed live at roughly $0.001–
 * 0.03 depending on how much search context the model pulls in, on top of
 * this account's existing OpenAI usage — small, but not free, which is
 * why this is only ever triggered by an explicit per-contact 🔍 click,
 * never automatically. */
export async function findSocialProfiles(params: {
  firstName: string;
  lastName: string;
  company?: string;
}): Promise<SocialLookupResult> {
  const name = [params.firstName, params.lastName].filter(Boolean).join(' ').trim();
  if (!name) throw new SocialLookupError('Reikia bent vardo, kad būtų galima ieškoti');
  const company = params.company?.trim();
  const input = `Person: ${withDiacriticVariant(name)}${company ? `\nCompany: ${withDiacriticVariant(company)}` : ''}`;

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: SOCIAL_LOOKUP_MODEL,
        instructions: SOCIAL_LOOKUP_SYSTEM_PROMPT,
        input,
        tools: [{ type: 'web_search' }],
      }),
    });
  } catch {
    throw new SocialLookupError('Could not reach OpenAI');
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) {
    throw new SocialLookupError(json?.error?.message ?? `OpenAI request failed (HTTP ${res.status})`);
  }
  if (json.error) throw new SocialLookupError(json.error.message ?? 'OpenAI returned an error');

  // The Responses API returns an `output` array mixing tool-call records
  // (type: "web_search_call") with the actual assistant message — unlike
  // Chat Completions' flat `choices[0].message.content`, the text has to
  // be found by locating the "message" item and its "output_text" content
  // part. Confirmed against real responses during development — there is
  // no top-level `output_text` convenience field on the raw REST response
  // (some SDKs synthesize one client-side; this is a plain fetch call).
  const output: any[] = Array.isArray(json.output) ? json.output : [];
  const message = output.find((item) => item?.type === 'message');
  const textPart = Array.isArray(message?.content)
    ? message.content.find((c: any) => c?.type === 'output_text')
    : null;
  const text = typeof textPart?.text === 'string' ? textPart.text.trim() : '';
  if (!text) throw new SocialLookupError('OpenAI returned an empty result');

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SocialLookupError('Nepavyko apdoroti OpenAI atsakymo');
  }

  // Filtered against the real domain regardless of what the model claims
  // — belt-and-suspenders against a malformed/off-topic result slipping
  // through as if it were a verified profile URL.
  const instagram = (Array.isArray(parsed?.instagram) ? parsed.instagram : []).filter(isInstagramUrl).slice(0, 3);
  const facebook = (Array.isArray(parsed?.facebook) ? parsed.facebook : []).filter(isFacebookUrl).slice(0, 3);
  return { instagram, facebook };
}
