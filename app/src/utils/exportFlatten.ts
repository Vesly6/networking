// Client-side flattening logic for the Export dialog — used both for the
// dialog's own live row-count preview (real and demo builds alike) and for
// the demo build's actual file generation (utils/exportTableDemo.ts). A
// real (non-demo) build never uses this to build the actual file — that
// happens server-side via server/src/export/buildExportRows.ts, a separate
// port of the same algorithm (this app has no module shared across the
// frontend/backend boundary — see that file's own doc comment).
import type { Column, Row } from '../types';
import { parseContacts, contactTextToFields } from './contacts';

export type ExportMode = 'companies_only' | 'with_contacts';

export interface BuildExportRowsParams {
  columns: Column[]; // display order, hidden already excluded by the caller
  rows: Row[]; // rows to export, already scope-resolved (filter/selection) by the caller
  mode: ExportMode;
  contactColumnId: string | null;
  includeCompaniesWithoutContacts: boolean;
  onlyContactsWithEmail: boolean;
}

export interface BuiltExportRows {
  headerRow: string[];
  dataRows: string[][];
}

export const CONTACT_FIELD_HEADERS = ['Vardas', 'Pavardė', 'Pareigos', 'El. paštas', 'Telefonas', 'LinkedIn'];

// Excel's own hard per-sheet row cap (including the header row).
export const XLSX_MAX_ROWS = 1_048_576;

/** Mirrors server/src/export/buildExportRows.ts exactly — see that file's
 * own comment for why this exists twice. In "with contacts" mode the raw
 * contact-type column is dropped from the company-columns section
 * (superseded by the expanded fields); every other column, including
 * note-type, passes through untouched — its raw JSON stays exactly as
 * today, a deliberate decision not to clean it up in this pass. A company
 * with zero surviving contacts (after the email-only filter) emits one
 * blank-contact-fields row only when includeCompaniesWithoutContacts is
 * true, else is skipped; company data is never deduplicated across a
 * company's own multiple contact rows — required behavior for a
 * mail-merge-style file, not a bug. */
export function buildExportRows(params: BuildExportRowsParams): BuiltExportRows {
  const { columns, rows, mode, contactColumnId, includeCompaniesWithoutContacts, onlyContactsWithEmail } = params;
  const companyColumns = mode === 'with_contacts' && contactColumnId ? columns.filter((c) => c.id !== contactColumnId) : columns;

  if (mode === 'companies_only' || !contactColumnId) {
    return {
      headerRow: companyColumns.map((c) => c.name),
      dataRows: rows.map((row) => companyColumns.map((c) => row.cells[c.id] ?? '')),
    };
  }

  const headerRow = [...companyColumns.map((c) => c.name), ...CONTACT_FIELD_HEADERS];
  const dataRows: string[][] = [];

  for (const row of rows) {
    const companyValues = companyColumns.map((c) => row.cells[c.id] ?? '');
    const entries = parseContacts(row.cells[contactColumnId] ?? '');
    const extracted = entries.map((e) => contactTextToFields(e.text)).filter((f) => !onlyContactsWithEmail || !!f.email);

    if (extracted.length === 0) {
      if (includeCompaniesWithoutContacts) dataRows.push([...companyValues, ...CONTACT_FIELD_HEADERS.map(() => '')]);
      continue;
    }

    for (const fields of extracted) {
      dataRows.push([...companyValues, fields.firstName, fields.lastName, fields.position, fields.email, fields.phone, fields.linkedinUrl]);
    }
  }

  return { headerRow, dataRows };
}
