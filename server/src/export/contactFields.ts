// A trimmed server-side port of app/src/utils/contacts.ts's parseContacts()/
// contactTextToFields() — this app has no module shared across the
// frontend/backend boundary (same constraint as permissions/registry.ts's
// own hand-mirrored PERMISSIONS), and the export route needs to expand a
// contact-type cell's raw JSON into First/Last/Position/Email/Phone
// server-side. Only the subset of the client's logic actually needed for
// that is ported here — display-formatting helpers (splitContactDisplayFields'
// full field list, senders, social-lookup bookkeeping) are deliberately left
// out.

export interface ExtractedContactFields {
  firstName: string;
  lastName: string;
  position: string;
  email: string;
  phone: string;
}

/** Mirrors parseContacts()'s JSON-array-with-legacy-fallback shape — a
 * contact-type cell's raw value is either the current `{id,text,...}[]`
 * JSON array or, for data written before this feature existed, a bare
 * legacy string treated as one entry. Only `text` is needed here (every
 * other ContactEntry field — sentCount, senders, socialLookup — has no
 * bearing on an export). */
export function parseContactEntryTexts(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((e) => e && typeof e === 'object')) {
      return parsed.map((e) => (typeof (e as { text?: unknown }).text === 'string' ? (e as { text: string }).text : ''));
    }
  } catch {
    // Not JSON — legacy plain text falls through below.
  }
  const trimmed = raw.trim();
  return trimmed ? [trimmed] : [];
}

// Copied verbatim from app/src/utils/contacts.ts — keep both copies
// byte-identical if either ever changes. Order matters: LinkedIn/Instagram/
// Facebook URLs are stripped *before* the phone pattern runs, since a
// profile URL's trailing numeric id (e.g. "linkedin.com/in/jonas-84719203")
// is 7+ digits and would otherwise be misdetected as a phone number.
const LINKEDIN_PATTERN = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s,"{}[\]]*/i;
const INSTAGRAM_PATTERN = /https?:\/\/(?:www\.)?instagram\.com\/[^\s,"{}[\]]*/i;
const FACEBOOK_PATTERN = /https?:\/\/(?:www\.)?facebook\.com\/[^\s,"{}[\]]*/i;
const EMAIL_SEARCH_PATTERN = /[^\s,"{}[\]]+@[^\s,"{}[\]]+\.[^\s,"{}[\]]+/;
const PHONE_PATTERN = /\+?\d[\d\s().-]{6,}\d/;

/** Mirrors contactTextToFields() — same best-effort, not-lossless
 * extraction: strip LinkedIn/Instagram/Facebook/email/phone in that order,
 * then split whatever's left on commas; the first segment's first word is
 * firstName, the rest of that segment is lastName, and the first remaining
 * generic segment is position. Does NOT port formatLegacyEntryText's
 * recovery of the older 5-field structured shape (no `.text` field) — an
 * accepted, vanishingly rare gap for contact entries that predate the
 * freeform-text convention and have never been re-saved since. */
export function extractContactFields(text: string): ExtractedContactFields {
  let remaining = text;

  const linkedinMatch = LINKEDIN_PATTERN.exec(remaining);
  if (linkedinMatch) remaining = remaining.slice(0, linkedinMatch.index) + remaining.slice(linkedinMatch.index + linkedinMatch[0].length);

  const instagramMatch = INSTAGRAM_PATTERN.exec(remaining);
  if (instagramMatch) remaining = remaining.slice(0, instagramMatch.index) + remaining.slice(instagramMatch.index + instagramMatch[0].length);

  const facebookMatch = FACEBOOK_PATTERN.exec(remaining);
  if (facebookMatch) remaining = remaining.slice(0, facebookMatch.index) + remaining.slice(facebookMatch.index + facebookMatch[0].length);

  let email = '';
  const emailMatch = EMAIL_SEARCH_PATTERN.exec(remaining);
  if (emailMatch) {
    email = emailMatch[0];
    remaining = remaining.slice(0, emailMatch.index) + remaining.slice(emailMatch.index + email.length);
  }

  let phone = '';
  const phoneMatch = PHONE_PATTERN.exec(remaining);
  if (phoneMatch) {
    phone = phoneMatch[0].trim();
    remaining = remaining.slice(0, phoneMatch.index) + remaining.slice(phoneMatch.index + phoneMatch[0].length);
  }

  const segments = remaining
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const [nameSegment, positionSegment] = segments;
  const [firstName = '', ...rest] = (nameSegment ?? '').split(' ').filter(Boolean);

  return { firstName, lastName: rest.join(' '), position: positionSegment ?? '', email, phone };
}
