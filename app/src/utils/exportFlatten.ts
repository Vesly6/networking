// Client-side flattening logic for the Export dialog — used both for the
// dialog's own live row-count preview (real and demo builds alike) and for
// the demo build's actual file generation (utils/exportTableDemo.ts). A
// real (non-demo) build never uses this to build the actual file — that
// happens server-side via server/src/export/buildExportRows.ts, a separate
// port of the same algorithm (this app has no module shared across the
// frontend/backend boundary — see that file's own doc comment).
import type { Column, Row } from '../types';
import { parseContacts, contactTextToFields, type SenderRecord } from './contacts';
import { splitNoteEntries } from './exportNoteFields';

export type ExportMode = 'companies_only' | 'with_contacts';

export interface BuildExportRowsParams {
  columns: Column[]; // display order, hidden already excluded by the caller
  rows: Row[]; // rows to export, already scope-resolved (filter/selection) by the caller
  mode: ExportMode;
  contactColumnId: string | null;
  includeCompaniesWithoutContacts: boolean;
  onlyContactsWithEmail: boolean;
  /** When true, the table's own note-type column (if any) is replaced in
   * the export by two readable columns ("Pastabos"/"Atsakymai") instead
   * of passing its raw JSON through untouched — on explicit request
   * ("заметки экспортируется довольно коряво"). Off by default/omitted:
   * every column, note-type included, exports exactly as stored, matching
   * the account owner's own earlier explicit decision not to touch this
   * by default. Applies in BOTH export modes (whichever columns end up in
   * the "company" section), not just "with contacts". */
  prettyNotes?: boolean;
}

export interface BuiltExportRows {
  headerRow: string[];
  dataRows: string[][];
}

export const CONTACT_FIELD_HEADERS = ['Vardas', 'Pavardė', 'Pareigos', 'El. paštas', 'Telefonas', 'LinkedIn', 'Išsiųsta laiškų'];

// Excel's own hard per-sheet row cap (including the header row).
export const XLSX_MAX_ROWS = 1_048_576;

function formatSender(s: SenderRecord | undefined): string {
  if (!s) return '';
  return s.date ? `${s.email} (${s.date})` : s.email;
}

interface PendingContactRow {
  companyValues: string[];
  fields: ReturnType<typeof contactTextToFields>;
  sentCount: number;
  senders: SenderRecord[];
}

interface CompanyColumnPlan {
  headers: string[];
  getValues: (row: Row) => string[];
}

/** Builds the header list + per-row value getter for whichever columns
 * end up in the "company" section of the export (all of them in
 * "companies only" mode; every non-Contacts column in "with contacts"
 * mode). Only special-cases the FIRST note-type column found when
 * `prettyNotes` is on — same "at most one of these per table" convention
 * this app already applies to isNextActionDate/isStatusColumn — any
 * additional note columns pass through raw, same as when the option is
 * off entirely. */
function planCompanyColumns(columns: Column[], prettyNotes: boolean): CompanyColumnPlan {
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
 * mail-merge-style file, not a bug.
 *
 * Sender columns ("Siuntėjas 1", "Siuntėjas 2", ...) are dynamic, not
 * fixed — a contact can accumulate a different sender for each outreach
 * round (ContactEntry.senders, newest-first — see contacts.ts's
 * addContactSender), and the account owner explicitly wants every one of
 * them visible, not just the latest. Since a flat CSV/XLSX row can't hold
 * a variable-length list, this runs in two passes: first collect every
 * contact row's own senders array and the widest one seen across the
 * WHOLE export (not just one company), then build the header with that
 * many "Siuntėjas N" columns and pad every row's shorter list with blank
 * cells — so every row has the same column count, as any flat export
 * requires, without truncating whoever happens to have the most senders. */
export function buildExportRows(params: BuildExportRowsParams): BuiltExportRows {
  const { columns, rows, mode, contactColumnId, includeCompaniesWithoutContacts, onlyContactsWithEmail, prettyNotes } = params;
  const companyColumns = mode === 'with_contacts' && contactColumnId ? columns.filter((c) => c.id !== contactColumnId) : columns;
  const companyPlan = planCompanyColumns(companyColumns, !!prettyNotes);

  if (mode === 'companies_only' || !contactColumnId) {
    return {
      headerRow: companyPlan.headers,
      dataRows: rows.map((row) => companyPlan.getValues(row)),
    };
  }

  const pending: PendingContactRow[] = [];
  let maxSenders = 0;

  for (const row of rows) {
    const companyValues = companyPlan.getValues(row);
    const entries = parseContacts(row.cells[contactColumnId] ?? '');
    const extracted = entries
      .map((e) => ({ fields: contactTextToFields(e.text), sentCount: e.sentCount ?? 0, senders: e.senders ?? [] }))
      .filter(({ fields }) => !onlyContactsWithEmail || !!fields.email);

    if (extracted.length === 0) {
      if (includeCompaniesWithoutContacts) {
        pending.push({ companyValues, fields: contactTextToFields(''), sentCount: 0, senders: [] });
      }
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
