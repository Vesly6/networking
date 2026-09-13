// A trimmed version of app/src/utils/contacts.ts — same JSON-array-of-
// entries storage shape and legacy-string fallback, but without the
// outreach-tracking fields (sentCount/repliedCount/senders/socialLookup)
// that don't apply to a demo with no email-campaign features. Same core
// parse/serialize/add/update/remove contract, so the demo's decision-
// maker cell editor behaves like the real Contacts column.
import { randomUUID } from './uuid';

export interface ContactEntry {
  id: string;
  text: string;
}

export function parseContacts(raw: string): ContactEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((e) => e && typeof e.text === 'string')) {
      return parsed.map((e) => ({ id: typeof e.id === 'string' ? e.id : randomUUID(), text: e.text }));
    }
  } catch {
    // Not JSON — legacy freeform value, fall through to single-entry form.
  }
  return raw.trim() ? [{ id: randomUUID(), text: raw.trim() }] : [];
}

export function serializeContacts(entries: ContactEntry[]): string {
  return JSON.stringify(entries);
}

export function addContact(raw: string, text: string, id: string = randomUUID()): string {
  const entries = parseContacts(raw);
  entries.unshift({ id, text });
  return serializeContacts(entries);
}

export function removeContact(raw: string, id: string): string {
  return serializeContacts(parseContacts(raw).filter((e) => e.id !== id));
}

export function updateContact(raw: string, id: string, text: string): string {
  return serializeContacts(parseContacts(raw).map((e) => (e.id === id ? { ...e, text } : e)));
}

export function getContactsSummary(raw: string): string {
  const entries = parseContacts(raw);
  if (entries.length === 0) return '';
  return entries.length > 1 ? `${entries[0].text} +${entries.length - 1} more` : entries[0].text;
}

export interface ContactFormFields {
  firstName: string;
  lastName: string;
  position: string;
  company: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  // No input in this demo's add/edit form ever sets these two — production's
  // only writes them via a real Instagram/Facebook lookup (SocialLookupModal),
  // which needs a real API key and doesn't exist here. Kept in the type
  // purely so joinContactFields/contactTextToFields round-trip a manually-
  // typed social URL (pasted into the freeform field) without losing it.
  instagramUrl: string;
  facebookUrl: string;
}

const EMPTY_CONTACT_FIELDS: ContactFormFields = {
  firstName: '',
  lastName: '',
  position: '',
  company: '',
  email: '',
  phone: '',
  linkedinUrl: '',
  instagramUrl: '',
  facebookUrl: '',
};

export function emptyContactFields(): ContactFormFields {
  return { ...EMPTY_CONTACT_FIELDS };
}

/** Same "Name, Position, company, email, phone, linkedin, instagram,
 * facebook" comma-joined shape the real app's joinContactFields produces
 * — empty fields omitted. */
export function joinContactFields(fields: ContactFormFields): string {
  const name = `${fields.firstName.trim()} ${fields.lastName.trim()}`.trim();
  return [
    name,
    fields.position.trim(),
    fields.company.trim(),
    fields.email.trim(),
    fields.phone.trim(),
    fields.linkedinUrl.trim(),
    fields.instagramUrl.trim(),
    fields.facebookUrl.trim(),
  ]
    .filter(Boolean)
    .join(', ');
}

export interface ContactDisplayField {
  kind: 'name' | 'text' | 'email' | 'phone' | 'linkedin' | 'instagram' | 'facebook';
  value: string;
}

// Copied verbatim from app/src/utils/contacts.ts.
const EMAIL_SEARCH_PATTERN = /[^\s,"{}[\]]+@[^\s,"{}[\]]+\.[^\s,"{}[\]]+/;
const PHONE_PATTERN = /\+?\d[\d\s().-]{6,}\d/;
const LINKEDIN_PATTERN = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s,"{}[\]]*/i;
const INSTAGRAM_PATTERN = /https?:\/\/(?:www\.)?instagram\.com\/[^\s,"{}[\]]*/i;
const FACEBOOK_PATTERN = /https?:\/\/(?:www\.)?facebook\.com\/[^\s,"{}[\]]*/i;

/** Ported from production's splitContactDisplayFields (utils/contacts.ts)
 * — pattern-extracts email/phone/linkedin/instagram/facebook out of the
 * raw text via regex (not positional comma-splitting, which breaks the
 * moment a real entry omits a field production's own fixed order
 * assumes — see extractEmail's own doc comment for the exact bug this
 * caused), then splits *whatever's left* by comma into a name field (the
 * first segment) plus any number of plain text lines (title, company,
 * ...). Used both for the per-entry display (one styled line per field)
 * and, via contactTextToFields below, for the edit-form pre-fill. */
export function splitContactDisplayFields(text: string): ContactDisplayField[] {
  let remaining = text;
  let linkedin: string | null = null;
  let instagram: string | null = null;
  let facebook: string | null = null;
  let email: string | null = null;
  let phone: string | null = null;

  const linkedinMatch = LINKEDIN_PATTERN.exec(remaining);
  if (linkedinMatch) {
    linkedin = linkedinMatch[0];
    remaining = remaining.slice(0, linkedinMatch.index) + remaining.slice(linkedinMatch.index + linkedin.length);
  }
  const instagramMatch = INSTAGRAM_PATTERN.exec(remaining);
  if (instagramMatch) {
    instagram = instagramMatch[0];
    remaining = remaining.slice(0, instagramMatch.index) + remaining.slice(instagramMatch.index + instagram.length);
  }
  const facebookMatch = FACEBOOK_PATTERN.exec(remaining);
  if (facebookMatch) {
    facebook = facebookMatch[0];
    remaining = remaining.slice(0, facebookMatch.index) + remaining.slice(facebookMatch.index + facebook.length);
  }
  const emailMatch = EMAIL_SEARCH_PATTERN.exec(remaining);
  if (emailMatch) {
    email = emailMatch[0];
    remaining = remaining.slice(0, emailMatch.index) + remaining.slice(emailMatch.index + email.length);
  }
  const phoneMatch = PHONE_PATTERN.exec(remaining);
  if (phoneMatch) {
    phone = phoneMatch[0].trim();
    remaining = remaining.slice(0, phoneMatch.index) + remaining.slice(phoneMatch.index + phoneMatch[0].length);
  }

  const fields: ContactDisplayField[] = remaining
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((value, i) => ({ kind: i === 0 ? 'name' : 'text', value }) as ContactDisplayField);

  if (email) fields.push({ kind: 'email', value: email });
  if (phone) fields.push({ kind: 'phone', value: phone });
  if (linkedin) fields.push({ kind: 'linkedin', value: linkedin });
  if (instagram) fields.push({ kind: 'instagram', value: instagram });
  if (facebook) fields.push({ kind: 'facebook', value: facebook });

  return fields;
}

/** Best-effort reverse of joinContactFields, built on splitContactDisplayFields
 * — matches production exactly, replacing this demo's earlier positional
 * comma-split version (which mis-parsed any real entry that omitted a
 * field, e.g. no company segment). */
export function contactTextToFields(text: string): ContactFormFields {
  const parsed = splitContactDisplayFields(text);
  const nameField = parsed.find((f) => f.kind === 'name');
  const [firstName = '', ...rest] = (nameField?.value ?? '').split(' ').filter(Boolean);
  const textFields = parsed.filter((f) => f.kind === 'text').map((f) => f.value);
  return {
    firstName,
    lastName: rest.join(' '),
    position: textFields[0] ?? '',
    company: textFields[1] ?? '',
    email: parsed.find((f) => f.kind === 'email')?.value ?? '',
    phone: parsed.find((f) => f.kind === 'phone')?.value ?? '',
    linkedinUrl: parsed.find((f) => f.kind === 'linkedin')?.value ?? '',
    instagramUrl: parsed.find((f) => f.kind === 'instagram')?.value ?? '',
    facebookUrl: parsed.find((f) => f.kind === 'facebook')?.value ?? '',
  };
}

/** Pulls a callable number out of a contact entry's freeform text, or
 * null if nothing phone-shaped is in there — used by the next-action-date
 * cell's 👤 picker to resolve "who does this row's call number belong to." */
export function extractPhoneNumber(text: string): string | null {
  const match = PHONE_PATTERN.exec(text);
  return match ? match[0].trim() : null;
}

/** Pulls an email out of a contact entry's freeform text via pattern
 * match — used for the contact popover's copy-email button. */
export function extractEmail(text: string): string | null {
  const match = EMAIL_SEARCH_PATTERN.exec(text);
  return match ? match[0].trim() : null;
}
