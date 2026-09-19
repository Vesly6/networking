// Client-side flattening logic for the Export dialog — used both for the
// dialog's own live row/column-count preview (real and demo builds alike)
// and for the demo build's actual file generation (utils/exportTableDemo.ts).
// A real (non-demo) build never uses this to build the actual file — that
// happens server-side via server/src/export/buildExportRows.ts, a separate
// port of the same algorithm (this app has no module shared across the
// frontend/backend boundary — see that file's own doc comment). Keep the
// two in sync by hand if the flattening rules ever change.
//
// Three independent axes on top of the original two-mode shape (on
// explicit request): contacts (companies_only mode only — cell/columns,
// freely combinable with each other), notes (cell/columns, freely
// combinable), replies (cell/columns, freely combinable). The axis
// checkboxes are genuinely independent — checking notesCell AND
// notesColumns together is a supported, deliberate scenario (both a
// summary cell and per-entry columns in the same file), not a UI mistake
// to guard against.
//
// `prettyFormat` (the old "Gražiai suformatuoti pastabas ir atsakymus"
// checkbox) changed ROLE in this pass: it used to decide BOTH whether the
// note column got split into readable columns AND how each entry was
// worded. Now it ONLY controls wording (decorated-with-date/author vs.
// plain entry text) — WHETHER anything gets extracted from the note column
// at all is entirely the four axis checkboxes' decision. This is why, with
// every new checkbox left at its default (off), the note/contact columns
// pass through completely untouched regardless of prettyFormat's own value
// — required for this export's own explicit backward-compatibility rule
// ("Companies only при настройках по умолчанию даёт тот же файл, что и до
// изменений").
import type { Column, Row } from '../types';
import { parseContacts, contactTextToFields, type SenderRecord } from './contacts';
import { extractNoteEntries, formatCommentEntry, formatReplyEntry } from './exportNoteFields';
import { clampToLimit } from './cellLimit';

export type RowStructure = 'companies_only' | 'with_contacts';
// Kept under its original name — every existing caller (ExportDialog,
// exportTableApi, exportTableDemo, the audit log's own `detail.mode`)
// already says "mode" for this, and it's genuinely the same row-shape
// decision as before this pass, just no longer the ONLY axis in play.
export type ExportMode = RowStructure;

export interface AxisLimits {
  contacts: number;
  notes: number;
  replies: number;
}

// A configurable-but-sane default — see ExportDialog.tsx's own limit
// inputs. Chosen as "generous enough that most real companies never hit
// it, small enough that a 500-contact outlier can't blow the column count
// out to something XLSX chokes on."
export const DEFAULT_AXIS_LIMITS: AxisLimits = { contacts: 10, notes: 10, replies: 10 };

export interface ExportAxisOptions {
  /** companies_only mode only — see section 8 of the account owner's own
   * spec: with_contacts already IS the row-per-contact expansion, so this
   * axis is meaningless/disabled there. */
  contactsCell: boolean;
  contactsColumns: boolean;
  notesCell: boolean;
  notesColumns: boolean;
  repliesCell: boolean;
  repliesColumns: boolean;
  limits: AxisLimits;
  prettyFormat: boolean;
}

export const DEFAULT_AXIS_OPTIONS: ExportAxisOptions = {
  contactsCell: false,
  contactsColumns: false,
  notesCell: false,
  notesColumns: false,
  repliesCell: false,
  repliesColumns: false,
  limits: DEFAULT_AXIS_LIMITS,
  prettyFormat: false,
};

export interface BuildExportRowsParams {
  columns: Column[]; // display order, hidden already excluded by the caller
  rows: Row[]; // rows to export, already scope-resolved (filter/selection) by the caller
  mode: RowStructure;
  contactColumnId: string | null;
  includeCompaniesWithoutContacts: boolean;
  onlyContactsWithEmail: boolean;
  axis: ExportAxisOptions;
}

export interface BuiltExportRows {
  headerRow: string[];
  dataRows: string[][];
  /** True on an axis whenever some row's real item count exceeded that
   * axis's configured limit — the account owner's own explicit
   * requirement that overflow is surfaced, never silently dropped (the
   * actual overflow data itself always lands in a trailing "N+" column
   * regardless of this flag; this is purely what drives the dialog's own
   * pre-export warning). */
  overflow: { contacts: boolean; notes: boolean; replies: boolean };
}

// Matches server/src/export/buildExportRows.ts's own copy exactly — the
// same 7 fields the "with contacts" row mode has always exported per
// contact, reused here as the field set inside each numbered "Kontaktas N"
// column group (the account owner's own explicit requirement: "состав
// группы — те же поля контакта, что выгружаются в режиме строк"). The
// dynamic per-contact Siuntėjas-N sub-expansion stays exclusive to the
// rows mode — nesting a second dynamic-width list inside each already-
// dynamic contact group is a combinatorial explosion this pass
// deliberately doesn't attempt.
export const CONTACT_FIELD_HEADERS = ['Vardas', 'Pavardė', 'Pareigos', 'El. paštas', 'Telefonas', 'LinkedIn', 'Išsiųsta laiškų'];

// Excel's own hard per-sheet row cap (including the header row).
export const XLSX_MAX_ROWS = 1_048_576;

// Excel's own hard per-sheet COLUMN cap — surfaced by the dialog as a
// warning when a wide combination of axes approaches it (see the account
// owner's own spec, section 7: "при приближении к лимиту формата — явное
// предупреждение").
export const XLSX_MAX_COLUMNS = 16_384;

function cell(value: string): string {
  return clampToLimit(value).value;
}

function formatSender(s: SenderRecord | undefined): string {
  if (!s) return '';
  return s.date ? `${s.email} (${s.date})` : s.email;
}

function contactRowMatchesEmailFilter(text: string, onlyContactsWithEmail: boolean): boolean {
  return !onlyContactsWithEmail || !!contactTextToFields(text).email;
}

/** Plain company-field columns — everything that ISN'T one of the
 * dedicated axis sections below. The contact and/or note column is
 * dropped from here exactly when its OWN axis is actually producing
 * output for it (never "because prettyFormat is on" by itself — see this
 * file's own header comment) — so a company still exports every other
 * column untouched even while its contact/note data moves into a
 * dedicated section. */
function companyFieldColumns(columns: Column[], contactColumnId: string | null, noteColumnId: string | null, dropContact: boolean, dropNote: boolean): Column[] {
  return columns.filter((c) => !(dropContact && c.id === contactColumnId) && !(dropNote && c.id === noteColumnId));
}

interface NotesPlan {
  headers: string[];
  getValues: (row: Row) => string[];
  notesOverflow: boolean;
  repliesOverflow: boolean;
}

/** One pass over every row's note column up front — required before any
 * header can be built at all, since "Pastaba 1..N"'s own column COUNT is
 * the widest count seen across the WHOLE export, not a per-row decision.
 * A no-op (empty plan) when neither axis is active, which is what keeps
 * the note column untouched by default (see this file's own header
 * comment). */
function planNotesAxis(rows: Row[], noteColumnId: string | null, axis: ExportAxisOptions): NotesPlan {
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
  getValues: (row: Row) => string[];
  overflow: boolean;
}

/** companies_only mode only — see ExportAxisOptions.contactsCell's own
 * doc comment. Same two-pass shape as planNotesAxis: the widest per-row
 * contact count (after the email filter) has to be known before headers
 * can be built. */
function planContactsAxis(rows: Row[], contactColumnId: string | null, mode: RowStructure, onlyContactsWithEmail: boolean, axis: ExportAxisOptions): ContactsPlan {
  const axisActive = mode === 'companies_only' && !!contactColumnId && (axis.contactsCell || axis.contactsColumns);
  if (!axisActive || !contactColumnId) {
    return { headers: [], getValues: () => [], overflow: false };
  }
  const perRow = new Map(
    rows.map((r) => [r.id, parseContacts(r.cells[contactColumnId] ?? '').filter((e) => contactRowMatchesEmailFilter(e.text, onlyContactsWithEmail))]),
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
        const fields = contactTextToFields(entry.text);
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
  const { columns, rows, mode, contactColumnId, includeCompaniesWithoutContacts, onlyContactsWithEmail, axis } = params;
  const noteColumnId = columns.find((c) => c.type === 'note')?.id ?? null;

  const contactsPlan = planContactsAxis(rows, contactColumnId, mode, onlyContactsWithEmail, axis);
  const notesPlan = planNotesAxis(rows, noteColumnId, axis);
  const contactsAxisActive = contactsPlan.headers.length > 0;
  const notesAxisActive = notesPlan.headers.length > 0;

  // In "with contacts" mode the contact column is ALWAYS dropped from the
  // plain company fields (superseded by the per-contact row expansion
  // below) — unchanged from this export's original behavior, independent
  // of the new contacts axis (which only ever applies in companies_only
  // mode — see section 8's own compatibility rule).
  const dropContactColumn = mode === 'with_contacts' || contactsAxisActive;
  const fieldColumns = companyFieldColumns(columns, contactColumnId, noteColumnId, dropContactColumn, notesAxisActive);
  const fieldHeaders = fieldColumns.map((c) => c.name);
  const getFieldValues = (row: Row) => fieldColumns.map((c) => row.cells[c.id] ?? '');

  if (mode === 'companies_only' || !contactColumnId) {
    const headerRow = [...fieldHeaders, ...contactsPlan.headers, ...notesPlan.headers];
    const dataRows = rows.map((row) => [...getFieldValues(row), ...contactsPlan.getValues(row), ...notesPlan.getValues(row)]);
    return { headerRow, dataRows, overflow: { contacts: contactsPlan.overflow, notes: notesPlan.notesOverflow, replies: notesPlan.repliesOverflow } };
  }

  // --- with_contacts: fan out one output row per contact (existing
  // mechanism, unchanged) — company AND notes-axis values are computed
  // once per source row, then repeated onto every one of that company's
  // contact rows, same as company field values already were. ---
  interface PendingContactRow {
    fieldValues: string[];
    notesValues: string[];
    fields: ReturnType<typeof contactTextToFields>;
    sentCount: number;
    senders: SenderRecord[];
  }
  const pending: PendingContactRow[] = [];
  let maxSenders = 0;
  for (const row of rows) {
    const fieldValues = getFieldValues(row);
    const notesValues = notesPlan.getValues(row);
    const entries = parseContacts(row.cells[contactColumnId] ?? '');
    const extracted = entries
      .map((e) => ({ fields: contactTextToFields(e.text), sentCount: e.sentCount ?? 0, senders: e.senders ?? [] }))
      .filter(({ fields }) => !onlyContactsWithEmail || !!fields.email);

    if (extracted.length === 0) {
      if (includeCompaniesWithoutContacts) pending.push({ fieldValues, notesValues, fields: contactTextToFields(''), sentCount: 0, senders: [] });
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
