import { localApiRequest } from './localApi';

/** Sends a raw multi-line paste (e.g. an Apollo/LinkedIn export) to OpenAI
 * and gets back one cleaned "Name, Title, Company, email, phone" line,
 * with placeholder/masked values (a bare "+1", etc.) stripped out. */
export function parseContactText(rawText: string): Promise<{ text: string }> {
  return localApiRequest('/api/contacts/parse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: rawText }),
  });
}
