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
  linkedinUrl: string;
}

export interface ExportSenderRecord {
  email: string;
  date: string;
}

export interface ParsedContactEntry {
  text: string;
  /** How many times "Pridėti išsiųstus"/the ✉️ mark-as-sent action has
   * bumped this entry (app/src/utils/contacts.ts's ContactEntry.sentCount)
   * — surfaced in the "with contacts" export as its own column, on
   * explicit request, mirroring the same count the in-app contact editor
   * already shows next to a contact ("išsiuntėme jam/jai laiškus N").
   * Absent in storage means never sent; normalized to 0 here rather than
   * left undefined, since an export column reads better as a plain
   * number than a sometimes-blank cell. */
  sentCount: number;
  /** Every mailbox that has sent to this contact, newest-first, mirroring
   * ContactEntry.senders (contacts.ts's addContactSender prepends) — the
   * export gets one dynamic "Siuntėjas N" column per position across the
   * whole export's widest list, not just this one entry's own count (see
   * buildExportRows.ts's own doc comment on the two-pass reason why). */
  senders: ExportSenderRecord[];
}

/** Mirrors contacts.ts's normalizeSenders — tolerates both the current
 * `{email,date}[]` shape and the very first shipped version's plain
 * `string[]` (a real, already-written batch of entries exists in that
 * older shape). */
function normalizeSenders(v: unknown): ExportSenderRecord[] {
  if (!Array.isArray(v)) return [];
  const result: ExportSenderRecord[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.trim()) {
      result.push({ email: item.trim(), date: '' });
    } else if (item && typeof item === 'object' && typeof (item as { email?: unknown }).email === 'string') {
      const email = (item as { email: string }).email.trim();
      if (!email) continue;
      const date = typeof (item as { date?: unknown }).date === 'string' ? (item as { date: string }).date : '';
      result.push({ email, date });
    }
  }
  return result;
}

/** Mirrors parseContacts()'s JSON-array-with-legacy-fallback shape — a
 * contact-type cell's raw value is either the current `{id,text,...}[]`
 * JSON array or, for data written before this feature existed, a bare
 * legacy string treated as one entry. */
export function parseContactEntries(raw: string): ParsedContactEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((e) => e && typeof e === 'object')) {
      return parsed.map((e) => {
        const entry = e as { text?: unknown; sentCount?: unknown; senders?: unknown };
        return {
          text: typeof entry.text === 'string' ? entry.text : '',
          sentCount: typeof entry.sentCount === 'number' && Number.isFinite(entry.sentCount) ? entry.sentCount : 0,
          senders: normalizeSenders(entry.senders),
        };
      });
    }
  } catch {
    // Not JSON — legacy plain text falls through below.
  }
  const trimmed = raw.trim();
  return trimmed ? [{ text: trimmed, sentCount: 0, senders: [] }] : [];
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

  let linkedinUrl = '';
  const linkedinMatch = LINKEDIN_PATTERN.exec(remaining);
  if (linkedinMatch) {
    linkedinUrl = linkedinMatch[0];
    remaining = remaining.slice(0, linkedinMatch.index) + remaining.slice(linkedinMatch.index + linkedinMatch[0].length);
  }

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

  return { firstName, lastName: rest.join(' '), position: positionSegment ?? '', email, phone, linkedinUrl };
}
