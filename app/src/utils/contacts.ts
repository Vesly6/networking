export interface ContactEntry {
  id: string;
  text: string;
}

/** A `contact`-type cell's stored value is a JSON array of free-text
 * entries, one per person at that company — mirrors how note-type cells
 * store history (utils/noteHistory.ts), but each entry is a single
 * freeform line (name/phone/email all together) instead of a dated log.
 * A bare pre-existing string (typed before this feature existed, or
 * written by CSV import) is kept visible as a single legacy entry rather
 * than losing it. Entries from the older structured (last/first/middle
 * name + phone + email) shape are also still readable — they're folded
 * into one line the first time the cell is parsed. */
export function parseContacts(raw: string): ContactEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((e) => e && typeof e === 'object')) {
      return parsed.map((e) => ({
        id: typeof e.id === 'string' ? e.id : crypto.randomUUID(),
        text: typeof e.text === 'string' ? e.text : formatLegacyEntryText(e),
      }));
    }
  } catch {
    // Not JSON — legacy plain text falls through below.
  }
  const trimmed = raw.trim();
  return trimmed ? [{ id: 'legacy', text: trimmed }] : [];
}

function formatLegacyEntryText(e: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const name = [str(e.lastName), str(e.firstName), str(e.middleName)].filter(Boolean).join(' ');
  return [name, str(e.phone), str(e.email)].filter(Boolean).join(', ');
}

export function serializeContacts(entries: ContactEntry[]): string {
  return JSON.stringify(entries);
}

export function addContact(raw: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return raw;
  const existing = parseContacts(raw);
  return serializeContacts([...existing, { id: crypto.randomUUID(), text: trimmed }]);
}

export function removeContact(raw: string, id: string): string {
  return serializeContacts(parseContacts(raw).filter((c) => c.id !== id));
}

/** Overwrites one existing entry's text in place (keeping its id, so
 * anything keyed off it — React's own list keys included — stays stable
 * across an edit) rather than removing and re-adding. Silently no-ops on
 * an empty result, same "don't let a save wipe the entry" guard as
 * addContact() has for adding one. */
export function updateContact(raw: string, id: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return raw;
  return serializeContacts(parseContacts(raw).map((c) => (c.id === id ? { ...c, text: trimmed } : c)));
}

/** For the collapsed (non-hovering) cell preview. */
export function getContactsSummary(raw: string): string {
  const contacts = parseContacts(raw);
  if (contacts.length === 0) return '';
  const first = contacts[0].text || 'Contact';
  return contacts.length > 1 ? `${first} +${contacts.length - 1} more` : first;
}

// Matches the first phone-number-looking run of digits in a contact's
// freeform text: requires 7+ digits so a short junk value (a bare "+1"
// placeholder, an extension) doesn't get mistaken for a real number.
const PHONE_PATTERN = /\+?\d[\d\s().-]{6,}\d/;

/** Pulls a callable number out of a contact entry's freeform text, or null
 * if nothing phone-shaped is in there — click-to-call uses this since
 * contacts don't have a dedicated phone field (see CLAUDE.md on why). */
export function extractPhoneNumber(text: string): string | null {
  const match = PHONE_PATTERN.exec(text);
  return match ? match[0].trim() : null;
}

export interface ContactDisplayField {
  kind: 'name' | 'email' | 'phone' | 'text';
  value: string;
}

// Searches for an email shape anywhere in a longer string, not just a
// whole comma-split piece — a hand-typed contact often has no commas at
// all ("John Doe +37061234567 john@x.com"). Excludes quote/brace/bracket
// characters (on top of the usual whitespace/comma boundary) so a match
// doesn't drag along trailing punctuation if the text happens to contain
// JSON-ish syntax (e.g. someone pasting this module's own stored shape,
// `[{"id":...,"text":"..."}]`, back in as literal text).
const EMAIL_SEARCH_PATTERN = /[^\s,"{}[\]]+@[^\s,"{}[\]]+\.[^\s,"{}[\]]+/;

/** Splits one contact entry's freeform text into typed fields for display,
 * one per line. Handles both the AI-cleaned "Name, Title, Company, email,
 * phone" comma-separated shape (server's CONTACT_PARSE_SYSTEM_PROMPT) and
 * plain hand-typed/pasted text with no commas at all: email and phone are
 * matched *anywhere* in the text (not just as a standalone comma-split
 * piece) and pulled out first, in that order; whatever's left is split on
 * commas (if any) into a name plus any extra title/company pieces, in
 * their original order — this also reproduces the AI-cleaned format's
 * field order for free, since stripping email/phone out of "Name, Title,
 * Company, email, phone" and re-splitting the remainder on commas gives
 * back exactly "Name", "Title", "Company" in order. Falls back to
 * treating the whole string as a name if nothing phone/email-shaped is
 * found. Display-only — the stored value stays the single freeform
 * string described above; nothing here is re-parsed back into `text`. */
export function splitContactDisplayFields(text: string): ContactDisplayField[] {
  let remaining = text;
  let email: string | null = null;
  let phone: string | null = null;

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
    .map((value, i) => ({ kind: i === 0 ? 'name' : 'text', value }));

  if (email) fields.push({ kind: 'email', value: email });
  if (phone) fields.push({ kind: 'phone', value: phone });

  return fields;
}

export interface ContactFormFields {
  firstName: string;
  lastName: string;
  position: string;
  email: string;
  phone: string;
}

/** Builds the same comma-separated shape the AI contact-paste cleanup
 * produces (`server`'s CONTACT_PARSE_SYSTEM_PROMPT: "Name, Title, Company,
 * email, phone") from the structured add/edit form's five separate
 * fields, so splitContactDisplayFields() reads it back exactly the same
 * way regardless of which path an entry came from. Empty fields are
 * omitted rather than left as blank commas. */
export function joinContactFields(fields: ContactFormFields): string {
  const name = `${fields.firstName.trim()} ${fields.lastName.trim()}`.trim();
  return [name, fields.position.trim(), fields.email.trim(), fields.phone.trim()].filter(Boolean).join(', ');
}

/** The reverse of joinContactFields(), for pre-filling the edit form from
 * an existing entry's freeform text — necessarily a best-effort guess,
 * not a lossless round-trip, since the stored text is just one string
 * with no real field boundaries. Built on splitContactDisplayFields()'s
 * existing email/phone detection; the one further guess this adds is
 * splitting the "name" segment on its first space into first/last (right
 * for "Jonas Petraitis", not guaranteed for every name format) — good
 * enough to prefill an edit that's about to be reviewed by a human
 * anyway, same spirit as the AI contact-paste cleanup never auto-saving
 * without a look first. */
export function contactTextToFields(text: string): ContactFormFields {
  const parsed = splitContactDisplayFields(text);
  const nameField = parsed.find((f) => f.kind === 'name');
  const [firstName = '', ...rest] = (nameField?.value ?? '').split(' ').filter(Boolean);
  return {
    firstName,
    lastName: rest.join(' '),
    position: parsed
      .filter((f) => f.kind === 'text')
      .map((f) => f.value)
      .join(', '),
    email: parsed.find((f) => f.kind === 'email')?.value ?? '',
    phone: parsed.find((f) => f.kind === 'phone')?.value ?? '',
  };
}
