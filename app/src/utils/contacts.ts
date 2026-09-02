import { randomUUID } from './uuid';

export interface ContactEntry {
  id: string;
  text: string;
  /** Whether a 🔍 Instagram/Facebook AI lookup (SocialLookupModal) has
   * already been run for this entry and come up with nothing the user
   * confirmed — lets the UI show a dimmed "not found" icon instead of
   * silently offering to search (and spend a real, if small, per-search
   * cost) again every time the entry is opened. A *found and confirmed*
   * link isn't tracked here at all — like linkedinUrl, it's just stored as
   * a detectable URL segment inside `text` itself (see
   * INSTAGRAM_PATTERN/FACEBOOK_PATTERN below). This is pure app-internal
   * bookkeeping, not part of the human-editable text, so it lives as a
   * separate field rather than being squeezed into the one string — the
   * "collapse everything into one string" convention this file otherwise
   * follows is about the person's own data (name/phone/email/...), which
   * this isn't. Absent entirely (not `false`) for every contact created
   * before this existed, and for one that simply hasn't been searched
   * yet. */
  socialLookup?: { instagramNotFound?: boolean; facebookNotFound?: boolean };
  /** How many times "mark as sent" (the ✉️ icon next to this contact) has
   * been clicked — a counter, not a boolean, since the same contact can
   * legitimately be included in more than one outreach round (a first
   * batch that went unanswered, then a later re-send). Absent/undefined,
   * never 0, for a contact never marked sent — same convention as
   * socialLookup above. */
  sentCount?: number;
  /** How many times a reply from this contact has been pushed into this
   * row's History via PushReplyRowsModal's automatic email match (see
   * incrementContactRepliedCount below) — never set through any control
   * in the Contacts editor itself. */
  repliedCount?: number;
  /** Every distinct sender mailbox that has emailed this contact, across
   * every outreach round ("Pridėti siuntėją" — see addContactSender
   * below), each stamped with the date it was recorded — a growing,
   * deduped-by-email list, not a counter, because the whole point is
   * remembering *which* mailbox(es) and *when*, not just how many times:
   * a worker who's about to call this person needs to say "we emailed
   * you from X on this date" correctly, and a real contact genuinely
   * accumulates more than one entry here across 10+ separate campaigns
   * run over time (a first round nobody replies to, a later round from a
   * different mailbox that gets a response). Newest-first — addContactSender
   * prepends. Absent entirely, never an empty array, for a contact
   * that's never had a sender recorded. */
  senders?: SenderRecord[];
}

export interface SenderRecord {
  email: string;
  /** yyyy.MM.dd — see utils/date.ts's todaySenderDate(). Empty string
   * for a sender recorded before dates were tracked (the very first
   * shipped version stored senders as plain email strings with no date
   * at all) — parseContacts below reads that legacy shape transparently. */
  date: string;
}

function toPositiveCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Reads both shapes senders has ever been stored as: the current
 * `{email, date}[]` and the very first shipped version's plain
 * `string[]` (a real, already-written batch of ~770 entries exists in
 * that older shape) — a bare email there becomes `{email, date: ''}`. */
function normalizeSenders(v: unknown): SenderRecord[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const result: SenderRecord[] = [];
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
  return result.length > 0 ? result : undefined;
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
        id: typeof e.id === 'string' ? e.id : randomUUID(),
        text: typeof e.text === 'string' ? e.text : formatLegacyEntryText(e),
        socialLookup: e.socialLookup && typeof e.socialLookup === 'object' ? e.socialLookup : undefined,
        sentCount: toPositiveCount(e.sentCount),
        repliedCount: toPositiveCount(e.repliedCount),
        senders: normalizeSenders(e.senders),
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

/** `id` is normally left to generate itself — the one caller that passes
 * one explicitly (ApolloContactSearchModal's "+ Pridėti") needs to know the
 * new entry's id *before* this returns, so a slow background phone-number
 * lookup can later call updateContact() on the exact same entry instead of
 * appending a duplicate once the number arrives. */
export function addContact(raw: string, text: string, id: string = randomUUID()): string {
  const trimmed = text.trim();
  if (!trimmed) return raw;
  const existing = parseContacts(raw);
  return serializeContacts([...existing, { id, text: trimmed }]);
}

/** Batch version of addContact() for MergeContactsModal.tsx — appends
 * several entries in one parse/serialize pass (avoids re-parsing the JSON
 * array once per entry) and skips any incoming entry whose email already
 * exists among the row's current contacts, so re-running the same merge
 * (or two overlapping ones) doesn't pile up duplicate people. Matches by
 * email specifically (not name) since it's the one field both a hand-typed
 * contact and a CSV-derived one are likely to have written identically —
 * a name has too many formatting variants to compare reliably. An entry
 * with no detectable email is never treated as a duplicate of anything. */
export function addContactsDedupByEmail(raw: string, newEntryTexts: string[]): { raw: string; added: number; skipped: number } {
  const existing = parseContacts(raw);
  const existingEmails = new Set(
    existing
      .map((e) => splitContactDisplayFields(e.text).find((f) => f.kind === 'email')?.value.toLowerCase())
      .filter((v): v is string => !!v),
  );
  let added = 0;
  let skipped = 0;
  const toAdd: ContactEntry[] = [];
  for (const text of newEntryTexts) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    const email = splitContactDisplayFields(trimmed).find((f) => f.kind === 'email')?.value.toLowerCase();
    if (email && existingEmails.has(email)) {
      skipped++;
      continue;
    }
    if (email) existingEmails.add(email);
    toAdd.push({ id: randomUUID(), text: trimmed });
    added++;
  }
  return { raw: serializeContacts([...existing, ...toAdd]), added, skipped };
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

/** Marks that a 🔍 Instagram/Facebook lookup was run for this entry and
 * the user confirmed no real match exists on `platform` — see
 * ContactEntry.socialLookup's doc comment for why this is separate
 * bookkeeping rather than something folded into `text`. A *found* profile
 * doesn't go through this at all — it's appended straight into `text` via
 * the normal updateContact() above, same as any other field. */
export function markSocialLookupNotFound(raw: string, id: string, platform: 'instagram' | 'facebook'): string {
  const key = platform === 'instagram' ? 'instagramNotFound' : 'facebookNotFound';
  return serializeContacts(
    parseContacts(raw).map((c) => (c.id === id ? { ...c, socialLookup: { ...c.socialLookup, [key]: true } } : c)),
  );
}

/** The manual "I just sent this contact something" click (CellHoverEditor's
 * ✉️ icon) — bumps ContactEntry.sentCount. A counter, not a boolean: the
 * same contact can be included in more than one outreach round, and
 * clicking again after a reply already came in (re-engagement) is a
 * legitimate, expected use, not an error. Independent of repliedCount —
 * see incrementContactRepliedCount's own doc comment for the one
 * exception (a reply floors sentCount to at least 1, since replying to
 * zero sends isn't a real state). */
export function markContactSent(raw: string, id: string): string {
  return serializeContacts(parseContacts(raw).map((c) => (c.id === id ? { ...c, sentCount: (c.sentCount ?? 0) + 1 } : c)));
}

/** "Pridėti siuntėją" bulk action (AddSenderModal.tsx's own equivalent of
 * MarkContactsSentModal) — records that `senderEmail` emailed this
 * contact on `date` (utils/date.ts's todaySenderDate()). Prepended, not
 * appended — the tooltip reads newest-first, on explicit request, so a
 * worker sees the most recent outreach mailbox first. Deduped
 * case-insensitively by email: running the same campaign export twice,
 * or two campaigns that happen to reuse a mailbox, moves that sender to
 * the front with the new date rather than growing a duplicate entry —
 * "when did we last send from this mailbox" should reflect the latest
 * send, not the first. */
export function addContactSender(raw: string, id: string, senderEmail: string, date: string): string {
  const sender = senderEmail.trim();
  if (!sender) return raw;
  return serializeContacts(
    parseContacts(raw).map((c) => {
      if (c.id !== id) return c;
      const existing = (c.senders ?? []).filter((s) => s.email.toLowerCase() !== sender.toLowerCase());
      return { ...c, senders: [{ email: sender, date }, ...existing] };
    }),
  );
}

/** Never called from the Contacts editor UI directly — only from
 * PushReplyRowsModal.tsx's automatic email match, the moment a reply from
 * this contact is pushed into this row's History.
 *
 * Also floors sentCount to at least 1 — a real, reported logical gap:
 * sentCount and repliedCount are bumped by two entirely independent
 * bulk actions ("Pridėti išsiųstus" vs. "Perkelti į lentelę"), so a
 * contact could genuinely show repliedCount:1, sentCount:0 — not
 * because nothing was ever sent (they clearly replied to *something*),
 * but because this specific person was never run through "Pridėti
 * išsiųstus". Left otherwise independent on purpose: this only ever
 * raises sentCount to 1 as a floor, it doesn't try to keep the two
 * counters in lockstep afterward (a contact can legitimately be sent to
 * 3 times and reply once, or reply to 2 separate threads off one
 * marked send) — see buildSentTooltip's own doc comment for the
 * matching UI-wording fix. */
export function incrementContactRepliedCount(raw: string, id: string): string {
  return serializeContacts(
    parseContacts(raw).map((c) =>
      c.id === id ? { ...c, repliedCount: (c.repliedCount ?? 0) + 1, sentCount: Math.max(c.sentCount ?? 0, 1) } : c,
    ),
  );
}

/** Finds which specific contact entry (if any) in this row's Contacts cell
 * owns `email` — used by PushReplyRowsModal.tsx to attribute a pushed
 * reply to one person, not just to the row as a whole. Row-level matching
 * (emailMatch.ts's buildEmailIndex) can succeed via a completely different
 * column (e.g. a plain "El. paštas" text column) with no corresponding
 * Contacts entry at all — that's a real, expected case for some tables'
 * schemas, so returning null here is not an error, just "nothing to
 * credit." First match wins on a duplicate email across entries (rare —
 * addContactsDedupByEmail already prevents most at import time). */
export function findContactIdByEmail(raw: string, email: string): string | null {
  const target = email.trim().toLowerCase();
  if (!target) return null;
  const match = parseContacts(raw).find(
    (c) => splitContactDisplayFields(c.text).find((f) => f.kind === 'email')?.value.toLowerCase() === target,
  );
  return match?.id ?? null;
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
  kind: 'name' | 'email' | 'phone' | 'linkedin' | 'instagram' | 'facebook' | 'text';
  value: string;
}

// Searches for an email shape anywhere in a longer string, not just a
// whole comma-split piece — a hand-typed contact often has no commas at
// all ("John Doe +37061234567 john@x.com"). Excludes quote/brace/bracket
// characters (on top of the usual whitespace/comma boundary) so a match
// doesn't drag along trailing punctuation if the text happens to contain
// JSON-ish syntax (e.g. someone pasting this module's own stored shape,
// `[{"id":...,"text":"..."}]`, back in as literal text).
export const EMAIL_SEARCH_PATTERN = /[^\s,"{}[\]]+@[^\s,"{}[\]]+\.[^\s,"{}[\]]+/;

// Matches a LinkedIn profile/company URL anywhere in the text. Extracted
// *before* the phone pattern below, not just before/after email — a
// LinkedIn profile URL commonly ends in a numeric-looking id segment
// (e.g. "linkedin.com/in/jonas-petraitis-84719203"), which is 7+ digits
// and would otherwise get misdetected as a phone number by PHONE_PATTERN.
const LINKEDIN_PATTERN = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/[^\s,"{}[\]]*/i;
// Same reasoning/shape as LINKEDIN_PATTERN, for the two other profile
// links a confirmed 🔍 lookup (SocialLookupModal) can append — Instagram
// and Facebook profile URLs commonly carry a long numeric id too.
const INSTAGRAM_PATTERN = /https?:\/\/(?:www\.)?instagram\.com\/[^\s,"{}[\]]*/i;
const FACEBOOK_PATTERN = /https?:\/\/(?:www\.)?facebook\.com\/[^\s,"{}[\]]*/i;

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
    .map((value, i) => ({ kind: i === 0 ? 'name' : 'text', value }));

  if (email) fields.push({ kind: 'email', value: email });
  if (phone) fields.push({ kind: 'phone', value: phone });
  if (linkedin) fields.push({ kind: 'linkedin', value: linkedin });
  if (instagram) fields.push({ kind: 'instagram', value: instagram });
  if (facebook) fields.push({ kind: 'facebook', value: facebook });

  return fields;
}

export interface ContactFormFields {
  firstName: string;
  lastName: string;
  position: string;
  company: string;
  email: string;
  phone: string;
  linkedinUrl: string;
  // No form <input> exposes these two — they're only ever written by a
  // confirmed 🔍 Instagram/Facebook lookup (SocialLookupModal), appended
  // straight into an entry's text via updateContact(), same as
  // linkedinUrl. They're still part of this type (rather than living
  // outside it) purely so contactTextToFields() -> edit form -> save
  // round-trips them unchanged: without this, editing *any* other field
  // through the structured form and saving would silently drop an
  // already-confirmed Instagram/Facebook link, since joinContactFields()
  // only ever emits what's in this object.
  instagramUrl: string;
  facebookUrl: string;
}

/** Builds the same comma-separated shape the AI contact-paste cleanup
 * produces (`server`'s CONTACT_PARSE_SYSTEM_PROMPT: "Name, Title, Company,
 * email, phone") from the structured add/edit form's fields, so
 * splitContactDisplayFields() reads it back exactly the same way
 * regardless of which path an entry came from. linkedinUrl/instagramUrl/
 * facebookUrl are appended last, after phone — the AI-cleanup prompt has
 * no URL fields of its own, so these are purely additive and don't shift
 * any of the other positions. Empty fields are omitted rather than left
 * as blank commas. */
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

/** The reverse of joinContactFields(), for pre-filling the edit form from
 * an existing entry's freeform text — necessarily a best-effort guess,
 * not a lossless round-trip, since the stored text is just one string
 * with no real field boundaries. Built on splitContactDisplayFields()'s
 * existing email/phone/linkedin detection; the further guesses this adds
 * are splitting the "name" segment on its first space into first/last
 * (right for "Jonas Petraitis", not guaranteed for every name format),
 * and treating the first two generic 'text' segments as position and
 * company respectively (matches the order joinContactFields writes them
 * in — there's no way to tell them apart from the string alone beyond
 * position) — good enough to prefill an edit that's about to be reviewed
 * by a human anyway, same spirit as the AI contact-paste cleanup never
 * auto-saving without a look first. */
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
