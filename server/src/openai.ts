export class ContactParseError extends Error {}

const CONTACT_PARSE_MODEL = 'gpt-4o-mini';

const CONTACT_PARSE_SYSTEM_PROMPT = `You clean up contact info pasted from lead databases (Apollo, LinkedIn, etc.) into one tidy line.
Extract: full name, job title, company, email, and the one real phone number.
Ignore placeholder/masked values that aren't real phone numbers (e.g. a bare "+1" with no other digits, repeated meaningless short codes).
Output ONLY the cleaned line as: Name, Title, Company, email, phone — omit any field that's genuinely missing. No explanation, no extra text, just the one line.`;

/** Cheap ($0.15/1M input tokens as of writing — a pasted contact blob is a
 * few dozen tokens) chat-completion call, not the transcription model. */
export async function parseContactText(rawText: string, apiKey: string): Promise<{ text: string }> {
  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
    throw new ContactParseError('Could not reach the AI service');
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) {
    throw new ContactParseError(json?.error?.message ?? `AI service request failed (HTTP ${res.status})`);
  }
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new ContactParseError('AI service returned an empty result');
  return { text };
}

export class DiacriticGuessError extends Error {}

const DIACRITIC_GUESS_MODEL = 'gpt-4o-mini';

const DIACRITIC_GUESS_SYSTEM_PROMPT = `You restore Lithuanian diacritics (ą č ę ė į š ų ū ž) in a personal name typed without them.
Plain "s"/"c"/"z" could come from "š"/"č"/"ž"; plain "u"/"e"/"i"/"a" could come from "ų"/"ū"/"ė"/"į"/"ą" — use your knowledge of real, common Lithuanian name spellings to restore the single most likely correct form.
If the name doesn't look Lithuanian, already has diacritics, or you are not genuinely confident of the correct spelling, respond with the exact input unchanged.
Respond with ONLY the name (corrected or unchanged) — no explanation, no quotes, no extra text.`;

/** A narrow, single-purpose text task — NOT a search, and its output is
 * never itself treated as a verified fact about anyone. This exists to
 * fill a real, reported gap in server/src/serper.ts's social-profile
 * search: a contact's name may be stored with no Lithuanian diacritics at
 * all (however it was typed/imported), and a real profile that *does* use
 * them then simply never turns up in a plain-text search — Google's own
 * matching isn't reliably accent-fuzzy in the other direction, confirmed
 * live (searching "Sarunas Marciulionis" found nothing, even though the
 * real profile is "Šarūnas Marčiulionis" and a search for THAT spelling
 * finds it immediately). The reverse direction (stripping diacritics that
 * are already present) is pure, deterministic Unicode normalization
 * (serper.ts's own stripDiacritics) and doesn't need this — only
 * *restoring* missing diacritics is inherently a guess, which is exactly
 * the kind of narrow language task an LLM is well-suited for, as opposed
 * to the profile-finding/verification job this deliberately stays out of.
 * Returns null when the model didn't offer a genuine change (nothing
 * useful to add to the search query) or the call itself fails — a failure
 * here should never block the real search from still running with
 * whatever spelling was actually given. */
export async function guessLithuanianDiacritics(name: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: DIACRITIC_GUESS_MODEL,
        messages: [
          { role: 'system', content: DIACRITIC_GUESS_SYSTEM_PROMPT },
          { role: 'user', content: name },
        ],
        temperature: 0,
      }),
    });
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => null);
    const guess = json?.choices?.[0]?.message?.content?.trim();
    if (!guess || guess.toLowerCase() === name.toLowerCase()) return null;
    return guess;
  } catch {
    return null;
  }
}

const TITLE_TRANSLATE_MODEL = 'gpt-4o-mini';

const TITLE_TRANSLATE_SYSTEM_PROMPT = `You translate a job title into English, for use as a search filter against a database indexed in English.
If the input is already in English, respond with it unchanged (only fix obvious casing, e.g. "ceo" -> "CEO").
Respond with ONLY the translated title — no explanation, no quotes, no extra text.`;

/** Same narrow, fail-soft shape as guessLithuanianDiacritics() above (null
 * on any failure, never throws) — this backs the "Pareigos" job-title
 * filter's free-typed entries (PeopleFilterForm.tsx's ComboBoxMultiInput):
 * picking from the suggestion list already sends Apollo's own English
 * `value`, but a custom-typed Lithuanian title (e.g. "Pardavimų vadovas")
 * went straight to Apollo's person_titles param as-is, which matches far
 * worse against a database indexed in English — real, reported feedback
 * ("сделать пойск на англиском, так намного точнее будет"). A failed
 * translation call falls back to the original typed text rather than
 * blocking the filter from being added at all. */
export async function translateJobTitleToEnglish(title: string, apiKey: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TITLE_TRANSLATE_MODEL,
        messages: [
          { role: 'system', content: TITLE_TRANSLATE_SYSTEM_PROMPT },
          { role: 'user', content: title },
        ],
        temperature: 0,
      }),
    });
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => null);
    const translated = json?.choices?.[0]?.message?.content?.trim();
    return translated || null;
  } catch {
    return null;
  }
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
export async function summarizeCall(transcriptText: string, apiKey: string): Promise<{ summary: string }> {
  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
    throw new SummarizeError('Could not reach the AI service');
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) {
    throw new SummarizeError(json?.error?.message ?? `AI service request failed (HTTP ${res.status})`);
  }
  const summary = json.choices?.[0]?.message?.content?.trim();
  if (!summary) throw new SummarizeError('AI service returned an empty result');
  return { summary };
}

export class LinkedInPersonalizeError extends Error {}

const LINKEDIN_PERSONALIZE_MODEL = 'gpt-4o-mini';

// Deliberately takes a *template* to rewrite, not a blank "write something
// for this person" prompt — the human already decided what the message
// should say (the campaign's own sequence-step text); this only makes it
// read as written for this specific person instead of a form letter, the
// same "human writes the intent, AI adapts the wording" split this
// codebase already uses for the contact-paste cleanup. Explicitly told to
// keep the template's own language (Lithuanian templates stay Lithuanian)
// rather than translating, since nothing about "personalize" implies a
// language change and an unwanted translation would be a worse output
// than a slightly generic one.
const LINKEDIN_PERSONALIZE_SYSTEM_PROMPT = `You lightly personalize a LinkedIn outreach message template for one specific recipient, using their name/title/company. Keep the template's own structure, tone, and language (do not translate it). Weave in the recipient's first name and, where it fits naturally, their job title or company — do not force in a detail that has nowhere natural to go. Keep it sounding like something a person typed, not a mail-merge. Do not add claims, offers, or specifics the template didn't already contain. Output ONLY the rewritten message text, no explanation, no quotes around it.`;

// LinkedIn hard-caps a connection request's own note at 300 characters —
// enforced separately from just asking nicely in the prompt (a model can
// still overshoot), since a note that gets silently truncated by LinkedIn
// itself at send time is worse than one this function trims to fit first.
const LINKEDIN_CONNECT_NOTE_LIMIT = 300;

export interface LinkedInPersonalizeParams {
  template: string;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  company: string | null;
  /** LinkedIn connect notes have a hard 300-char cap; follow-up messages
   * don't — the prompt and the post-hoc trim both need to know which
   * applies. */
  isConnectNote: boolean;
}

/** Cheap chat-completion, same model/cost tier as everything else in this
 * file. Called from a real "🤖 Personalizuoti" button in the Pending
 * Approval panel — the result lands back in an editable field for the
 * human to review/adjust before approving, never auto-applied straight
 * into a send (same "AI drafts, human reviews" pattern as the contact-
 * paste cleanup and the AI-suggested inbox replies below). */
export async function personalizeLinkedInMessage(
  params: LinkedInPersonalizeParams,
  apiKey: string,
): Promise<{ text: string }> {
  const person = [
    params.firstName && `First name: ${params.firstName}`,
    params.lastName && `Last name: ${params.lastName}`,
    params.title && `Title: ${params.title}`,
    params.company && `Company: ${params.company}`,
  ]
    .filter(Boolean)
    .join('\n');
  const input = `Template:\n${params.template}\n\nRecipient:\n${person || '(no details available — keep the template mostly as-is)'}${
    params.isConnectNote ? `\n\n(This is a LinkedIn connection-request note — it must stay under ${LINKEDIN_CONNECT_NOTE_LIMIT} characters.)` : ''
  }`;

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LINKEDIN_PERSONALIZE_MODEL,
        messages: [
          { role: 'system', content: LINKEDIN_PERSONALIZE_SYSTEM_PROMPT },
          { role: 'user', content: input },
        ],
        temperature: 0.4,
      }),
    });
  } catch {
    throw new LinkedInPersonalizeError('Could not reach the AI service');
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) {
    throw new LinkedInPersonalizeError(json?.error?.message ?? `AI service request failed (HTTP ${res.status})`);
  }
  let text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new LinkedInPersonalizeError('AI service returned an empty result');
  if (params.isConnectNote && text.length > LINKEDIN_CONNECT_NOTE_LIMIT) {
    text = text.slice(0, LINKEDIN_CONNECT_NOTE_LIMIT);
  }
  return { text };
}

export class LinkedInReplyError extends Error {}

const LINKEDIN_REPLY_MODEL = 'gpt-4o-mini';

const LINKEDIN_REPLY_SYSTEM_PROMPT = `You draft one suggested reply in an ongoing LinkedIn B2B outreach conversation, for a human to review and edit before sending. Read the full message history to understand context and tone (match the language the conversation is actually in — Lithuanian, English, or whatever else). Write a natural, appropriately brief reply to the other person's most recent message — advance the conversation (answer their question, propose a concrete next step like a call, or acknowledge what they said) rather than being generic or overly salesy. Do not fabricate facts, prices, dates, or commitments the conversation hasn't already established. Output ONLY the suggested reply text, no explanation, no quotes around it.`;

export interface LinkedInReplyMessage {
  direction: 'in' | 'out';
  content: string;
}

/** Same "draft for human review" role as personalizeLinkedInMessage above,
 * for the Inbox panel's reply box instead of an outbound sequence step —
 * the suggestion lands in the reply textarea already-editable, it never
 * sends on its own. Takes the *whole* visible thread (LinkedIn's DOM gives
 * no cheap way to fetch just "the last few messages" more cheaply than
 * what inbox.ts already scrapes) so the model can pick up on context from
 * earlier in the conversation, not just the single latest message. */
export async function suggestLinkedInReply(
  participantName: string | null,
  messages: LinkedInReplyMessage[],
  apiKey: string,
): Promise<{ text: string }> {
  if (messages.length === 0) throw new LinkedInReplyError('No messages in this conversation yet');
  const transcript = messages.map((m) => `${m.direction === 'out' ? 'Me' : participantName || 'Them'}: ${m.content}`).join('\n');

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LINKEDIN_REPLY_MODEL,
        messages: [
          { role: 'system', content: LINKEDIN_REPLY_SYSTEM_PROMPT },
          { role: 'user', content: transcript },
        ],
        temperature: 0.4,
      }),
    });
  } catch {
    throw new LinkedInReplyError('Could not reach the AI service');
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) {
    throw new LinkedInReplyError(json?.error?.message ?? `AI service request failed (HTTP ${res.status})`);
  }
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new LinkedInReplyError('AI service returned an empty result');
  return { text };
}
