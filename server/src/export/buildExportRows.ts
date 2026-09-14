// Server-side twin of app/src/utils/exportFlatten.ts's buildExportRows() —
// same algorithm, operating on plain wire-shaped {id,name,type} columns and
// {id,cells} rows instead of the client's typed Column/Row (this app has no
// module shared across the frontend/backend boundary, same constraint
// documented in permissions/registry.ts). Keep the two in sync by hand if
// the flattening rules ever change.
import { parseContactEntries, extractContactFields, type ExportSenderRecord, type ExtractedContactFields } from './contactFields.js';
import { splitNoteEntries } from './noteFields.js';

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
  /** See app/src/utils/exportFlatten.ts's own doc comment — replaces the
   * table's own note-type column (if any) with two readable columns
   * ("Pastabos"/"Atsakymai") instead of passing its raw JSON through. */
  prettyNotes: boolean;
}

export interface BuiltExportRows {
  headerRow: string[];
  dataRows: string[][];
}

// Matches app/src/utils/exportFlatten.ts's CONTACT_FIELD_HEADERS — keep
// both copies byte-identical if either changes.
export const CONTACT_FIELD_HEADERS = ['Vardas', 'Pavardė', 'Pareigos', 'El. paštas', 'Telefonas', 'LinkedIn', 'Išsiųsta laiškų'];

// Excel's own hard per-sheet row cap (including the header row).
export const XLSX_MAX_ROWS = 1_048_576;

function formatSender(s: ExportSenderRecord | undefined): string {
  if (!s) return '';
  return s.date ? `${s.email} (${s.date})` : s.email;
}

interface PendingContactRow {
  companyValues: string[];
  fields: ExtractedContactFields;
  sentCount: number;
  senders: ExportSenderRecord[];
}

const BLANK_FIELDS: ExtractedContactFields = { firstName: '', lastName: '', position: '', email: '', phone: '', linkedinUrl: '' };

interface CompanyColumnPlan {
  headers: string[];
  getValues: (row: ExportRow) => string[];
}

/** Mirrors app/src/utils/exportFlatten.ts's planCompanyColumns exactly —
 * only special-cases the FIRST note-type column found (at most one per
 * table, same convention as isNextActionDate/isStatusColumn elsewhere in
 * this app); any additional note columns pass through raw regardless of
 * prettyNotes, same as when the option is off entirely. */
function planCompanyColumns(columns: ExportColumn[], prettyNotes: boolean): CompanyColumnPlan {
  const noteIndex = prettyNotes ? columns.findIndex((c) => c.type === 'note') : -1;
  if (noteIndex === -1) {
    return {
      headers: columns.map((c) => c.name),
      getValues: (row) => columns.map((c) => row.cells[c.id] ?? ''),
    };
  }
  const noteColumn = columns[noteIndex];
  const before = columns.slice(0, noteIndex);
  const after = columns.slice(noteIndex + 1);
  return {
    headers: [...before.map((c) => c.name), 'Pastabos', 'Atsakymai', ...after.map((c) => c.name)],
    getValues: (row) => {
      const { comments, replies } = splitNoteEntries(row.cells[noteColumn.id] ?? '');
      return [...before.map((c) => row.cells[c.id] ?? ''), comments, replies, ...after.map((c) => row.cells[c.id] ?? '')];
    },
  };
}

/** Sender columns ("Siuntėjas 1", "Siuntėjas 2", ...) are dynamic, not
 * fixed — see app/src/utils/exportFlatten.ts's own doc comment for the
 * full reasoning (a contact can accumulate a different sender per
 * outreach round, and every one of them should be visible, not just the
 * latest). Two passes: collect every contact row's own senders array and
 * the widest one seen across the WHOLE export first, then build the
 * header with that many columns and pad every shorter row with blanks. */
export function buildExportRows(params: BuildExportRowsParams): BuiltExportRows {
  const { columns, rows, mode, includeCompaniesWithoutContacts, onlyContactsWithEmail, prettyNotes } = params;
  const contactColumn = columns.find((c) => c.type === 'contact');

  // In "with contacts" mode the raw contact-type column is dropped from the
  // company-columns section — it's superseded by the expanded fields below.
  const companyColumns = mode === 'with_contacts' && contactColumn ? columns.filter((c) => c.id !== contactColumn.id) : columns;
  const companyPlan = planCompanyColumns(companyColumns, prettyNotes);

  if (mode === 'companies_only' || !contactColumn) {
    return {
      headerRow: companyPlan.headers,
      dataRows: rows.map((row) => companyPlan.getValues(row)),
    };
  }

  const pending: PendingContactRow[] = [];
  let maxSenders = 0;

  for (const row of rows) {
    const companyValues = companyPlan.getValues(row);
    const entries = parseContactEntries(row.cells[contactColumn.id] ?? '');
    const extracted = entries
      .map((entry) => ({ fields: extractContactFields(entry.text), sentCount: entry.sentCount, senders: entry.senders }))
      .filter(({ fields }) => !onlyContactsWithEmail || !!fields.email);

    if (extracted.length === 0) {
      if (includeCompaniesWithoutContacts) pending.push({ companyValues, fields: BLANK_FIELDS, sentCount: 0, senders: [] });
      continue;
    }

    for (const { fields, sentCount, senders } of extracted) {
      maxSenders = Math.max(maxSenders, senders.length);
      pending.push({ companyValues, fields, sentCount, senders });
    }
  }

  const senderHeaders = Array.from({ length: maxSenders }, (_, i) => `Siuntėjas ${i + 1}`);
  const headerRow = [...companyPlan.headers, ...CONTACT_FIELD_HEADERS, ...senderHeaders];
  const dataRows = pending.map((p) => [
    ...p.companyValues,
    p.fields.firstName,
    p.fields.lastName,
    p.fields.position,
    p.fields.email,
    p.fields.phone,
    p.fields.linkedinUrl,
    String(p.sentCount),
    ...Array.from({ length: maxSenders }, (_, i) => formatSender(p.senders[i])),
  ]);

  return { headerRow, dataRows };
}
