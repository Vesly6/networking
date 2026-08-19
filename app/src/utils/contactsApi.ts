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

export interface SocialLookupResult {
  instagram: string[];
  facebook: string[];
}

/** Uses OpenAI's real web-search-grounded lookup (server/src/openai.ts's
 * findSocialProfiles) to find candidate Instagram/Facebook profile URLs
 * for a person — up to 3 per platform, never auto-saved. A real,
 * per-call cost (a live web search), so this should only ever be called
 * from an explicit user click (the 🔍 button on a contact entry), never
 * automatically. */
export function findSocialProfiles(firstName: string, lastName: string, company?: string): Promise<SocialLookupResult> {
  return localApiRequest('/api/contacts/social-lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName, lastName, company }),
  });
}
