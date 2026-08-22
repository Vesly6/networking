import type { Column, Row } from '../types';
import { phoneMatchKey } from './phoneMatch';
import { getPrimaryLabel, getColumnByType } from './row';
import { parseContacts, extractPhoneNumber, contactTextToFields } from './contacts';

export interface RowPhoneMatch {
  rowId: string;
  label: string;
}

export interface ContactPhoneMatch {
  rowId: string;
  columnId: string;
  contactId: string;
  label: string;
}

export interface PhoneIndex {
  /** Keyed by phoneMatchKey() of a `phone`-type column's cell value. */
  phoneToRow: Map<string, RowPhoneMatch>;
  /** Keyed by phoneMatchKey() of a number extracted from a `contact`-type
   * column entry's freeform text — a call can belong to a specific person
   * inside a row's Contacts list, not just the row's own Phone column. */
  phoneToContact: Map<string, ContactPhoneMatch>;
}

/** Shared by CallsView.tsx (matching call-history entries to a row) and
 * the live incoming-call banner (App.tsx/IncomingCallBanner.tsx) —
 * originally built inline in CallsView.tsx only; extracted here once a
 * second consumer needed the identical logic, rather than duplicating it.
 * Scoped to whichever table's columns/rows are passed in — same
 * limitation CallsView.tsx already had (only the currently *loaded*
 * table's rows are searched, not every table this workspace has). */
export function buildPhoneIndex(columns: Column[], rows: Row[]): PhoneIndex {
  const phoneToRow = new Map<string, RowPhoneMatch>();
  const phoneColumns = columns.filter((c) => c.type === 'phone');
  if (phoneColumns.length > 0) {
    for (const row of rows) {
      for (const col of phoneColumns) {
        const key = phoneMatchKey(row.cells[col.id] ?? '');
        if (key) phoneToRow.set(key, { rowId: row.id, label: getPrimaryLabel(row, columns) });
      }
    }
  }

  const phoneToContact = new Map<string, ContactPhoneMatch>();
  const contactColumn = getColumnByType(columns, 'contact');
  if (contactColumn) {
    for (const row of rows) {
      const raw = row.cells[contactColumn.id];
      if (!raw) continue;
      for (const entry of parseContacts(raw)) {
        const phone = extractPhoneNumber(entry.text);
        if (!phone) continue;
        const key = phoneMatchKey(phone);
        if (!key) continue;
        const { firstName, lastName } = contactTextToFields(entry.text);
        const label = [firstName, lastName].filter(Boolean).join(' ') || entry.text;
        phoneToContact.set(key, { rowId: row.id, columnId: contactColumn.id, contactId: entry.id, label });
      }
    }
  }

  return { phoneToRow, phoneToContact };
}
