import { localApiRequest } from './localApi';

export type EmailMode = 'new' | 'reply' | 'reminder';
export type EmailLang = 'lt' | 'en';
export type EmailModel = 'claude-opus-5' | 'claude-sonnet-5' | 'claude-haiku-4-5-20251001';

export interface GenerateEmailParams {
  mode: EmailMode;
  lang: EmailLang;
  model: EmailModel;
  instructions: string;
  clientEmail?: string;
  clientHistory?: string;
}

/** Ported from a standalone Chrome extension (Desktop/Email-Extention) —
 * see server/src/anthropic.ts's own doc comment for why the actual
 * Anthropic call now happens server-side instead of straight from the
 * browser with a user-stored key. */
export function generateEmail(params: GenerateEmailParams): Promise<{ text: string }> {
  return localApiRequest('/api/email/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
}
