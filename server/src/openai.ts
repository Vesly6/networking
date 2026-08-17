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
const SUMMARIZE_SYSTEM_PROMPT = `You summarize Lithuanian B2B sales/cold-call transcripts for a CRM record. The call may be entirely in Lithuanian, or code-switch into English business jargon mid-sentence — read all of it.
Write a concise summary IN LITHUANIAN, 3-5 sentences: what was discussed, the prospect's reaction/interest level, and any agreed next steps or objections raised. If the call was very short or nothing meaningful was said (e.g. wrong number, immediate hangup), say so plainly in one sentence instead of padding it out.
Output ONLY the summary text, in Lithuanian — no headers, no bullet points, no preamble.`;

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
        temperature: 0.3,
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
