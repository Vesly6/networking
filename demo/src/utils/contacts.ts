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
}

/** Same "Name, Position, company, email, phone" comma-joined shape the
 * real app's joinContactFields produces — empty fields omitted. */
export function joinContactFields(fields: ContactFormFields): string {
  const name = `${fields.firstName} ${fields.lastName}`.trim();
  return [name, fields.position, fields.company, fields.email, fields.phone].filter((v) => v.trim()).join(', ');
}

/** Best-effort reverse of joinContactFields — same "not a lossless parse"
 * caveat as the production version. */
export function contactTextToFields(text: string): ContactFormFields {
  const parts = text.split(',').map((p) => p.trim());
  const [name = '', position = '', company = '', email = '', phone = ''] = parts;
  const spaceIdx = name.indexOf(' ');
  const firstName = spaceIdx === -1 ? name : name.slice(0, spaceIdx);
  const lastName = spaceIdx === -1 ? '' : name.slice(spaceIdx + 1);
  return { firstName, lastName, position, company, email, phone };
}

// Copied verbatim from app/src/utils/contacts.ts — requires 7+ digits so
// a short junk value (a bare "+1" placeholder, an extension) doesn't get
// mistaken for a real number.
const PHONE_PATTERN = /\+?\d[\d\s().-]{6,}\d/;

/** Pulls a callable number out of a contact entry's freeform text, or
 * null if nothing phone-shaped is in there — used by the next-action-date
 * cell's 👤 picker to resolve "who does this row's call number belong to." */
export function extractPhoneNumber(text: string): string | null {
  const match = PHONE_PATTERN.exec(text);
  return match ? match[0].trim() : null;
}
