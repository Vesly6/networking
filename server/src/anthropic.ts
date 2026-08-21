// Same "getApiKey() + typed Error subclass + fetch + normalize" pattern as
// every other AI integration in this file's sibling openai.ts. Ported from
// a standalone Chrome extension (Desktop/Email-Extention) that called the
// Anthropic API directly from the browser with a user-supplied key stored
// in chrome.storage.local — moved server-side to match how every other AI
// feature in this app already keeps its key out of the client bundle
// entirely, rather than reintroducing a client-stored-secret pattern this
// codebase doesn't otherwise use.

export class EmailGenerateError extends Error {}

function getApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new EmailGenerateError('ANTHROPIC_API_KEY is not set — check server/.env');
  }
  return key;
}

export type EmailMode = 'new' | 'reply' | 'reminder';
export type EmailLang = 'lt' | 'en';
export type EmailModel = 'claude-opus-5' | 'claude-sonnet-5' | 'claude-haiku-4-5-20251001';

export interface GenerateEmailParams {
  mode: EmailMode;
  lang: EmailLang;
  model: EmailModel;
  /** The instructions field — may be Russian (dictated via the browser's
   * own Web Speech API on the client) regardless of the target language;
   * the model is told this explicitly and always writes in `lang`. */
  instructions: string;
  /** Required (and only meaningful) when mode === 'reply'. */
  clientEmail?: string;
  /** Required (and only meaningful) when mode === 'reminder'. */
  clientHistory?: string;
}

// Verbatim from the original extension's sidepanel.js — already tuned
// (no placeholder brackets, no invented facts, output only the email body)
// against real use, so kept unchanged rather than rewritten from scratch.
const SYSTEM_PROMPT = [
  'You are an assistant that writes professional business emails on behalf of the user, a customer-facing employee.',
  "You will be told the target language, the task type (a brand-new email, a reply to a client's email, or a reminder/follow-up email grounded in client history), and instructions describing what to say and in what manner/tone.",
  'When client context or history is provided, use it only as background to keep the email accurate and consistent — do not dump it verbatim into the email.',
  "The user's instructions may be written or dictated in Russian, regardless of the target language — always write the final email in the requested target language, never in Russian.",
  'Write a complete, polished, ready-to-send email body in the target language, matching the requested tone.',
  'Do not invent facts, prices, or commitments that are not implied by the instructions or the context provided.',
  "Do not use placeholder brackets like [Name] or [Company] — if a detail is unknown, phrase the email so it isn't needed, or use a generic polite form of address appropriate to the target language.",
  'Output ONLY the email text itself (including a greeting and sign-off if appropriate) — no subject line, no markdown formatting, no commentary, no quotation marks around it.',
].join(' ');

function buildUserPrompt(params: GenerateEmailParams): string {
  const langLabel = params.lang === 'lt' ? 'Lithuanian' : 'English';
  const lines = [`Target language: ${langLabel}.`];

  if (params.mode === 'reply') {
    lines.push(
      "Task: write a reply to the client's email below.",
      '',
      "Client's original email:",
      '"""',
      params.clientEmail ?? '',
      '"""',
    );
  } else if (params.mode === 'reminder') {
    lines.push(
      'Task: write a reminder / follow-up email to the client, grounded in the client history and context below.',
      '',
      'Client history / context:',
      '"""',
      params.clientHistory ?? '',
      '"""',
    );
  } else {
    lines.push('Task: write a brand-new email to a client (not a reply to anything).');
  }

  lines.push('', `Instructions on what to say / manner (may be in Russian): ${params.instructions}`);
  return lines.join('\n');
}

export async function generateEmail(params: GenerateEmailParams): Promise<{ text: string }> {
  // Deliberately called before the try/catch below — that catch exists to
  // turn a real fetch() network failure into a clear message, but with
  // getApiKey() called *inside* it (the original shape of this code), a
  // missing ANTHROPIC_API_KEY threw from inside the same try and got
  // caught by the same generic handler, surfacing as the misleading
  // "Could not reach the Anthropic API" instead of the actual, much more
  // actionable "ANTHROPIC_API_KEY is not set" — confirmed live testing
  // this route with no key configured yet.
  const apiKey = getApiKey();
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: params.model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(params) }],
      }),
    });
  } catch {
    throw new EmailGenerateError('Could not reach the Anthropic API');
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) {
    const apiMessage = json?.error?.message;
    if (res.status === 401) throw new EmailGenerateError('Invalid Anthropic API key — check ANTHROPIC_API_KEY in server/.env');
    if (res.status === 429) throw new EmailGenerateError('Anthropic API rate limit exceeded — wait and try again');
    throw new EmailGenerateError(apiMessage ?? `Anthropic API request failed (HTTP ${res.status})`);
  }

  const textBlock = (json.content ?? []).find((b: any) => b.type === 'text');
  const text = textBlock?.text?.trim();
  if (!text) throw new EmailGenerateError('Anthropic returned no email text — try again');
  return { text };
}
