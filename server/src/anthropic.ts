// Same "getApiKey() + typed Error subclass + fetch + normalize" pattern as
// every other AI integration in this file's sibling openai.ts. Ported from
// a standalone Chrome extension (Desktop/Email-Extention) that called the
// Anthropic API directly from the browser with a user-supplied key stored
// in chrome.storage.local — moved server-side to match how every other AI
// feature in this app already keeps its key out of the client bundle
// entirely, rather than reintroducing a client-stored-secret pattern this
// codebase doesn't otherwise use.

export class EmailGenerateError extends Error {}

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

export async function generateEmail(params: GenerateEmailParams, apiKey: string): Promise<{ text: string }> {
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
    throw new EmailGenerateError('Could not reach the AI service');
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) {
    const apiMessage = json?.error?.message;
    if (res.status === 401) throw new EmailGenerateError('AI service rejected the configured API key');
    if (res.status === 429) throw new EmailGenerateError('AI service rate limit exceeded — wait and try again');
    throw new EmailGenerateError(apiMessage ?? `AI service request failed (HTTP ${res.status})`);
  }

  const textBlock = (json.content ?? []).find((b: any) => b.type === 'text');
  const text = textBlock?.text?.trim();
  if (!text) throw new EmailGenerateError('AI service returned no email text — try again');
  return { text };
}
