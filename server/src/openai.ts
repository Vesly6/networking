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
