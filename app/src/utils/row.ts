import type { Column, Row } from '../types';
import { parseContacts, contactTextToFields, extractPhoneNumber } from './contacts';

export function getPrimaryLabel(row: Row, columns: Column[]): string {
  // Prefer a dedicated Company column if one exists; older tables without
  // one fall back to whatever's in the first column, as before.
  const company = getColumnByType(columns, 'company') ?? columns[0];
  const value = company ? row.cells[company.id] : '';
  return value?.trim() || 'Be pavadinimo';
}

export function getNextActionColumn(columns: Column[]): Column | undefined {
  return columns.find((c) => c.type === 'date' && c.isNextActionDate);
}

export function getColumnByType(columns: Column[], type: Column['type']): Column | undefined {
  return columns.find((c) => c.type === type);
}

/** The column holding this table's actual company-website URL, for the
 * "🔍 Paieška" Apollo decision-maker search (ApolloContactSearchModal.tsx)
 * — NOT just "the first link column," since a table can have several
 * `link`-type columns (Website, LinkedIn, Facebook…) and picking blindly
 * risked handing Apollo a LinkedIn/Facebook URL instead of the real site.
 * Prefers the column explicitly marked isWebsiteColumn; when none is
 * marked, falls back to the table's link column only if there's EXACTLY
 * ONE (genuinely unambiguous — same "auto-select only when there's one
 * candidate, otherwise make the user choose" precedent already used by
 * MergeContactsModal's own link-column matching), never guessing among
 * several. Returns undefined rather than guessing when there's no link
 * data at all, or more than one un-flagged candidate. */
export function getWebsiteColumn(columns: Column[]): Column | undefined {
  const flagged = columns.find((c) => c.type === 'link' && c.isWebsiteColumn);
  if (flagged) return flagged;
  const linkColumns = columns.filter((c) => c.type === 'link');
  return linkColumns.length === 1 ? linkColumns[0] : undefined;
}

/** This row's actual website URL, resolved via getWebsiteColumn above —
 * the value ApolloContactSearchModal.tsx should turn into a domain
 * (utils/domainMatch.ts's normalizeDomain) instead of guessing one from
 * the company name. undefined when the table has no reliably-identifiable
 * website column or the cell is empty. */
export function getWebsiteUrl(row: Row, columns: Column[]): string | undefined {
  const column = getWebsiteColumn(columns);
  const value = column ? row.cells[column.id] : undefined;
  return value?.trim() || undefined;
}

/** "First Last" for the contact linked to this row's next-action date
 * (row.linkedContactId — see types.ts), or null if none is linked, the
 * table has no contact-type column, or the linked entry was since
 * deleted (dangling ids are expected to happen — notes/contacts get
 * edited independently — so this resolves quietly to null rather than
 * throwing). Falls back to the entry's raw text if splitting it into
 * first/last doesn't produce anything (contactTextToFields is a
 * best-effort guess, not a lossless parse — see utils/contacts.ts). */
export function getLinkedContactName(row: Row, columns: Column[]): string | null {
  if (!row.linkedContactId) return null;
  const contactColumn = getColumnByType(columns, 'contact');
  if (!contactColumn) return null;
  const entry = parseContacts(row.cells[contactColumn.id] ?? '').find((c) => c.id === row.linkedContactId);
  if (!entry) return null;
  const { firstName, lastName } = contactTextToFields(entry.text);
  const name = `${firstName} ${lastName}`.trim();
  return name || entry.text;
}

/** The number to actually dial for this row's next-action date — the
 * linked contact's own phone (extracted from their freeform Contacts
 * entry, same as click-to-call already does) if one is linked and has a
 * phone-shaped value, else this row's own `phone`-type column. Prefers the
 * specific person over the generic company number since it's more
 * actionable for a call queue ("who to call" already answered the *who* —
 * this answers the *what number*). Quietly resolves to null when neither
 * is available, same graceful-fallback spirit as getLinkedContactName. */
export function getNextActionPhone(row: Row, columns: Column[]): string | null {
  if (row.linkedContactId) {
    const contactColumn = getColumnByType(columns, 'contact');
    const entry = contactColumn
      ? parseContacts(row.cells[contactColumn.id] ?? '').find((c) => c.id === row.linkedContactId)
      : undefined;
    const phone = entry ? extractPhoneNumber(entry.text) : null;
    if (phone) return phone;
  }
  const phoneColumn = getColumnByType(columns, 'phone');
  const value = phoneColumn ? row.cells[phoneColumn.id]?.trim() : '';
  return value || null;
}
