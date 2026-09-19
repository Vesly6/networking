// Server-side twin of app/src/utils/exportFlatten.ts's buildExportRows() —
// same algorithm, operating on plain wire-shaped {id,name,type} columns and
// {id,cells} rows instead of the client's typed Column/Row (this app has no
// module shared across the frontend/backend boundary, same constraint
// documented in permissions/registry.ts). Keep the two in sync by hand if
// the flattening rules ever change. See the client twin's own header
// comment for the full "three independent axes" design and the
// `prettyFormat` role change — not re-duplicated here.
import { parseContactEntries, extractContactFields, type ExportSenderRecord, type ExtractedContactFields } from './contactFields.js';
import { extractNoteEntries, formatCommentEntry, formatReplyEntry } from './noteFields.js';

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

export interface AxisLimits {
  contacts: number;
  notes: number;
  replies: number;
}

export interface ExportAxisOptions {
  contactsCell: boolean;
  contactsColumns: boolean;
  notesCell: boolean;
  notesColumns: boolean;
  repliesCell: boolean;
  repliesColumns: boolean;
  limits: AxisLimits;
  prettyFormat: boolean;
}

export interface BuildExportRowsParams {
  columns: ExportColumn[]; // display order, hidden already excluded by the caller
  rows: ExportRow[]; // rows to export, already scope-resolved by the caller
  mode: ExportMode;
  includeCompaniesWithoutContacts: boolean;
  onlyContactsWithEmail: boolean;
  axis: ExportAxisOptions;
}

export interface BuiltExportRows {
  headerRow: string[];
  dataRows: string[][];
  overflow: { contacts: boolean; notes: boolean; replies: boolean };
}

// Matches app/src/utils/exportFlatten.ts's CONTACT_FIELD_HEADERS — keep
// both copies byte-identical if either changes.
export const CONTACT_FIELD_HEADERS = ['Vardas', 'Pavardė', 'Pareigos', 'El. paštas', 'Telefonas', 'LinkedIn', 'Išsiųsta laiškų'];

// Excel's own hard per-sheet row/column caps (including the header row).
export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLUMNS = 16_384;

// A plain length clamp mirroring app/src/utils/cellLimit.ts's own
// plain-slice fallback — export cell values here are already-joined
// display strings, never the raw stored JSON array cellLimit.ts's
// JSON-aware branch exists to protect, so there is nothing to lose by
// keeping this deliberately simpler than that client-side utility.
const EXCEL_CELL_LIMIT = 32_767;
function cell(value: string): string {
  return value.length <= EXCEL_CELL_LIMIT ? value : value.slice(0, EXCEL_CELL_LIMIT);
}

function formatSender(s: ExportSenderRecord | undefined): string {
  if (!s) return '';
  return s.date ? `${s.email} (${s.date})` : s.email;
}

function contactRowMatchesEmailFilter(text: string, onlyContactsWithEmail: boolean): boolean {
  return !onlyContactsWithEmail || !!extractContactFields(text).email;
}

function companyFieldColumns(columns: ExportColumn[], contactColumnId: string | null, noteColumnId: string | null, dropContact: boolean, dropNote: boolean): ExportColumn[] {
  return columns.filter((c) => !(dropContact && c.id === contactColumnId) && !(dropNote && c.id === noteColumnId));
}

interface NotesPlan {
  headers: string[];
  getValues: (row: ExportRow) => string[];
  notesOverflow: boolean;
  repliesOverflow: boolean;
}

function planNotesAxis(rows: ExportRow[], noteColumnId: string | null, axis: ExportAxisOptions): NotesPlan {
  const axisActive = !!noteColumnId && (axis.notesCell || axis.notesColumns || axis.repliesCell || axis.repliesColumns);
  if (!axisActive || !noteColumnId) {
    return { headers: [], getValues: () => [], notesOverflow: false, repliesOverflow: false };
  }
  const perRow = new Map(rows.map((r) => [r.id, extractNoteEntries(r.cells[noteColumnId] ?? '')]));
  const maxComments = axis.notesColumns ? Math.max(0, ...[...perRow.values()].map((p) => p.comments.length)) : 0;
  const maxReplies = axis.repliesColumns ? Math.max(0, ...[...perRow.values()].map((p) => p.replies.length)) : 0;
  const commentCols = Math.min(maxComments, axis.limits.notes);
  const replyCols = Math.min(maxReplies, axis.limits.replies);
  const notesOverflow = maxComments > axis.limits.notes;
  const repliesOverflow = maxReplies > axis.limits.replies;

  const headers: string[] = [];
  if (axis.notesCell) headers.push('Pastabos');
  for (let i = 1; i <= commentCols; i++) headers.push(`Pastaba ${i}`);
  if (notesOverflow) headers.push(`Pastabos ${commentCols + 1}+`);
  if (axis.repliesCell) headers.push('Atsakymai');
  for (let i = 1; i <= replyCols; i++) headers.push(`Atsakymas ${i}`);
  if (repliesOverflow) headers.push(`Atsakymai ${replyCols + 1}+`);

  return {
    headers,
    notesOverflow,
    repliesOverflow,
    getValues: (row) => {
      const { comments, replies } = perRow.get(row.id) ?? { comments: [], replies: [] };
      const values: string[] = [];
      if (axis.notesCell) values.push(cell(comments.map((e) => formatCommentEntry(e, axis.prettyFormat)).join('\n\n')));
      for (let i = 0; i < commentCols; i++) values.push(comments[i] ? cell(formatCommentEntry(comments[i], axis.prettyFormat)) : '');
      if (notesOverflow) values.push(cell(comments.slice(commentCols).map((e) => formatCommentEntry(e, axis.prettyFormat)).join('\n\n')));
      if (axis.repliesCell) values.push(cell(replies.map((e) => formatReplyEntry(e, axis.prettyFormat)).join('\n\n---\n\n')));
      for (let i = 0; i < replyCols; i++) values.push(replies[i] ? cell(formatReplyEntry(replies[i], axis.prettyFormat)) : '');
      if (repliesOverflow) values.push(cell(replies.slice(replyCols).map((e) => formatReplyEntry(e, axis.prettyFormat)).join('\n\n---\n\n')));
      return values;
    },
  };
}

interface ContactsPlan {
  headers: string[];
  getValues: (row: ExportRow) => string[];
  overflow: boolean;
}

const BLANK_FIELDS: ExtractedContactFields = { firstName: '', lastName: '', position: '', email: '', phone: '', linkedinUrl: '' };

function planContactsAxis(rows: ExportRow[], contactColumnId: string | null, mode: ExportMode, onlyContactsWithEmail: boolean, axis: ExportAxisOptions): ContactsPlan {
  const axisActive = mode === 'companies_only' && !!contactColumnId && (axis.contactsCell || axis.contactsColumns);
  if (!axisActive || !contactColumnId) {
    return { headers: [], getValues: () => [], overflow: false };
  }
  const perRow = new Map(
    rows.map((r) => [r.id, parseContactEntries(r.cells[contactColumnId] ?? '').filter((e) => contactRowMatchesEmailFilter(e.text, onlyContactsWithEmail))]),
  );
  const maxContacts = axis.contactsColumns ? Math.max(0, ...[...perRow.values()].map((es) => es.length)) : 0;
  const contactCols = Math.min(maxContacts, axis.limits.contacts);
  const overflow = maxContacts > axis.limits.contacts;

  const headers: string[] = [];
  if (axis.contactsCell) headers.push('Kontaktai');
  for (let i = 1; i <= contactCols; i++) for (const h of CONTACT_FIELD_HEADERS) headers.push(`Kontaktas ${i} ${h}`);
  if (overflow) headers.push(`Kontaktai ${contactCols + 1}+`);

  return {
    headers,
    overflow,
    getValues: (row) => {
      const entries = perRow.get(row.id) ?? [];
      const values: string[] = [];
      if (axis.contactsCell) values.push(cell(entries.map((e) => e.text).join('\n')));
      for (let i = 0; i < contactCols; i++) {
        const entry = entries[i];
        if (!entry) {
          values.push('', '', '', '', '', '', '');
          continue;
        }
        const fields = extractContactFields(entry.text);
        values.push(fields.firstName, fields.lastName, fields.position, fields.email, fields.phone, fields.linkedinUrl, String(entry.sentCount ?? 0));
      }
      if (overflow) values.push(cell(entries.slice(contactCols).map((e) => e.text).join('\n')));
      return values;
    },
  };
}

/** Column order is fixed, per the account owner's own spec (section 9):
 * company fields → [contact fields per row / contacts cell / contact N
 * groups] → notes cell → note N → replies cell → reply N → [sender N,
 * rows mode only]. */
export function buildExportRows(params: BuildExportRowsParams): BuiltExportRows {
  const { columns, rows, mode, includeCompaniesWithoutContacts, onlyContactsWithEmail, axis } = params;
  const contactColumn = columns.find((c) => c.type === 'contact');
  const contactColumnId = contactColumn?.id ?? null;
  const noteColumnId = columns.find((c) => c.type === 'note')?.id ?? null;

  const contactsPlan = planContactsAxis(rows, contactColumnId, mode, onlyContactsWithEmail, axis);
  const notesPlan = planNotesAxis(rows, noteColumnId, axis);
  const contactsAxisActive = contactsPlan.headers.length > 0;
  const notesAxisActive = notesPlan.headers.length > 0;

  const dropContactColumn = mode === 'with_contacts' || contactsAxisActive;
  const fieldColumns = companyFieldColumns(columns, contactColumnId, noteColumnId, dropContactColumn, notesAxisActive);
  const fieldHeaders = fieldColumns.map((c) => c.name);
  const getFieldValues = (row: ExportRow) => fieldColumns.map((c) => row.cells[c.id] ?? '');

  if (mode === 'companies_only' || !contactColumnId) {
    const headerRow = [...fieldHeaders, ...contactsPlan.headers, ...notesPlan.headers];
    const dataRows = rows.map((row) => [...getFieldValues(row), ...contactsPlan.getValues(row), ...notesPlan.getValues(row)]);
    return { headerRow, dataRows, overflow: { contacts: contactsPlan.overflow, notes: notesPlan.notesOverflow, replies: notesPlan.repliesOverflow } };
  }

  interface PendingContactRow {
    fieldValues: string[];
    notesValues: string[];
    fields: ExtractedContactFields;
    sentCount: number;
    senders: ExportSenderRecord[];
  }
  const pending: PendingContactRow[] = [];
  let maxSenders = 0;
  for (const row of rows) {
    const fieldValues = getFieldValues(row);
    const notesValues = notesPlan.getValues(row);
    const entries = parseContactEntries(row.cells[contactColumnId] ?? '');
    const extracted = entries
      .map((entry) => ({ fields: extractContactFields(entry.text), sentCount: entry.sentCount, senders: entry.senders }))
      .filter(({ fields }) => !onlyContactsWithEmail || !!fields.email);

    if (extracted.length === 0) {
      if (includeCompaniesWithoutContacts) pending.push({ fieldValues, notesValues, fields: BLANK_FIELDS, sentCount: 0, senders: [] });
      continue;
    }
    for (const { fields, sentCount, senders } of extracted) {
      maxSenders = Math.max(maxSenders, senders.length);
      pending.push({ fieldValues, notesValues, fields, sentCount, senders });
    }
  }

  const senderHeaders = Array.from({ length: maxSenders }, (_, i) => `Siuntėjas ${i + 1}`);
  const headerRow = [...fieldHeaders, ...CONTACT_FIELD_HEADERS, ...notesPlan.headers, ...senderHeaders];
  const dataRows = pending.map((p) => [
    ...p.fieldValues,
    p.fields.firstName,
    p.fields.lastName,
    p.fields.position,
    p.fields.email,
    p.fields.phone,
    p.fields.linkedinUrl,
    String(p.sentCount),
    ...p.notesValues,
    ...Array.from({ length: maxSenders }, (_, i) => formatSender(p.senders[i])),
  ]);

  return { headerRow, dataRows, overflow: { contacts: false, notes: notesPlan.notesOverflow, replies: notesPlan.repliesOverflow } };
}
