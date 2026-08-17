import type { Column, Row } from '../types';
import { parseContacts, contactTextToFields } from './contacts';

export function getPrimaryLabel(row: Row, columns: Column[]): string {
  // Prefer a dedicated Company column if one exists; older tables without
  // one fall back to whatever's in the first column, as before.
  const company = getColumnByType(columns, 'company') ?? columns[0];
  const value = company ? row.cells[company.id] : '';
  return value?.trim() || 'Untitled';
}

export function getNextActionColumn(columns: Column[]): Column | undefined {
  return columns.find((c) => c.type === 'date' && c.isNextActionDate);
}

export function getColumnByType(columns: Column[], type: Column['type']): Column | undefined {
  return columns.find((c) => c.type === type);
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
