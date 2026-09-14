// Server-side twin of app/src/utils/exportFlatten.ts's buildExportRows() —
// same algorithm, operating on plain wire-shaped {id,name,type} columns and
// {id,cells} rows instead of the client's typed Column/Row (this app has no
// module shared across the frontend/backend boundary, same constraint
// documented in permissions/registry.ts). Keep the two in sync by hand if
// the flattening rules ever change.
import { parseContactEntryTexts, extractContactFields } from './contactFields.js';

export type ExportMode = 'companies_only' | 'with_contacts';

export interface ExportColumn {
  id: string;
  name: string;
  type: string;
}

export interface ExportRow {
  id: string;
  cells: Record<string, string>;
}

export interface BuildExportRowsParams {
  columns: ExportColumn[]; // display order, hidden already excluded by the caller
  rows: ExportRow[]; // rows to export, already scope-resolved (filter/selection) by the caller
  mode: ExportMode;
  includeCompaniesWithoutContacts: boolean;
  onlyContactsWithEmail: boolean;
}

export interface BuiltExportRows {
  headerRow: string[];
  dataRows: string[][];
}

// Matches app/src/utils/exportFlatten.ts's CONTACT_FIELD_HEADERS — keep
// both copies byte-identical if either changes.
export const CONTACT_FIELD_HEADERS = ['Vardas', 'Pavardė', 'Pareigos', 'El. paštas', 'Telefonas'];

// Excel's own hard per-sheet row cap (including the header row).
export const XLSX_MAX_ROWS = 1_048_576;

export function buildExportRows(params: BuildExportRowsParams): BuiltExportRows {
  const { columns, rows, mode, includeCompaniesWithoutContacts, onlyContactsWithEmail } = params;
  const contactColumn = columns.find((c) => c.type === 'contact');

  // In "with contacts" mode the raw contact-type column is dropped from the
  // company-columns section — it's superseded by the expanded fields below.
  // Every other column, including note-type, passes through untouched (its
  // raw JSON is left exactly as-is, matching the account owner's own
  // decision not to clean that up in this pass).
  const companyColumns = mode === 'with_contacts' && contactColumn ? columns.filter((c) => c.id !== contactColumn.id) : columns;

  if (mode === 'companies_only' || !contactColumn) {
    return {
      headerRow: companyColumns.map((c) => c.name),
      dataRows: rows.map((row) => companyColumns.map((c) => row.cells[c.id] ?? '')),
    };
  }

  const headerRow = [...companyColumns.map((c) => c.name), ...CONTACT_FIELD_HEADERS];
  const dataRows: string[][] = [];

  for (const row of rows) {
    const companyValues = companyColumns.map((c) => row.cells[c.id] ?? '');
    const texts = parseContactEntryTexts(row.cells[contactColumn.id] ?? '');
    const extracted = texts.map(extractContactFields).filter((f) => !onlyContactsWithEmail || !!f.email);

    if (extracted.length === 0) {
      if (includeCompaniesWithoutContacts) dataRows.push([...companyValues, '', '', '', '', '']);
      continue;
    }

    for (const fields of extracted) {
      dataRows.push([...companyValues, fields.firstName, fields.lastName, fields.position, fields.email, fields.phone]);
    }
  }

  return { headerRow, dataRows };
}
