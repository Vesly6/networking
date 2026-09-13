// Trimmed copy of app/src/utils/row.ts — getPrimaryLabel/getColumnByType/
// getNextActionColumn/getLinkedContactName/getNextActionPhone, which is
// what the demo's grid/toolbar/Calendar tab need (no website-column
// concept here).
import type { Column, Row } from '../types';
import { parseContacts, contactTextToFields, extractPhoneNumber } from './contacts';

export function getPrimaryLabel(row: Row, columns: Column[]): string {
  const company = getColumnByType(columns, 'company') ?? columns[0];
  const value = company ? row.cells[company.id] : '';
  return value?.trim() || 'Unnamed';
}

export function getColumnByType(columns: Column[], type: Column['type']): Column | undefined {
  return columns.find((c) => c.type === type);
}

export function getNextActionColumn(columns: Column[]): Column | undefined {
  return columns.find((c) => c.type === 'date' && c.isNextActionDate);
}

/** Which of this row's own Contacts entries the next-action date/call is
 * for — resolved from Row.linkedContactId, set via the date cell's 👤
 * picker. Null if nothing's linked or the linked entry no longer exists
 * (edited/deleted independently — never an error, just resolves to null). */
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

/** The number to actually call for this row's next-action date — the
 * linked contact's own phone if one is linked and has a phone-shaped
 * value, else this row's own `phone`-type column. */
export function getNextActionPhone(row: Row, columns: Column[]): string | null {
  if (row.linkedContactId) {
    const contactColumn = getColumnByType(columns, 'contact');
    const entry = contactColumn ? parseContacts(row.cells[contactColumn.id] ?? '').find((c) => c.id === row.linkedContactId) : undefined;
    const phone = entry ? extractPhoneNumber(entry.text) : null;
    if (phone) return phone;
  }
  const phoneColumn = getColumnByType(columns, 'phone');
  const value = phoneColumn ? row.cells[phoneColumn.id]?.trim() : '';
  return value || null;
}
