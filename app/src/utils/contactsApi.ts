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

/** Real Google search results (server/src/serper.ts's searchSocialProfiles,
 * via serper.dev) for candidate Instagram/Facebook profile URLs for a
 * person — up to 5 per platform, never auto-saved; the user opens and
 * visually verifies each one before confirming (SocialLookupModal). Not
 * AI-guessed — see serper.ts's own doc comment for why that approach was
 * replaced. `company` is still accepted here for the modal's own display
 * text but is no longer sent on to narrow the search itself. A real,
 * per-call cost (billed search credits), so this should only ever be
 * called from an explicit user click (the 🔍 button on a contact entry),
 * never automatically. */
export function findSocialProfiles(firstName: string, lastName: string, company?: string): Promise<SocialLookupResult> {
  return localApiRequest('/api/contacts/social-lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName, lastName, company }),
  });
}
