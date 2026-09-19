// Splits a note-type column's raw JSON into structured comment/reply entry
// lists for the Export dialog's independent notes/replies axes (see
// utils/exportFlatten.ts) — a plain hand-typed/tagged comment reads
// completely differently from an entry auto-pushed in from an Instantly
// reply (see utils/replyHistoryFormat.ts), so mashing both into one raw-JSON
// cell is what originally looked "коряво." Reuses the app's own real
// parser/field list (parseNoteHistory, REPLY_HEADER_FIELD_ORDER) rather than
// re-deriving the comment/reply split — this is the same
// commentEntries/replyEntries distinction CellHoverEditor.tsx's own history
// view already makes (NoteEntry.replyFields present or not).
import { parseNoteHistory, type NoteEntry } from './noteHistory';
import { REPLY_HEADER_FIELD_ORDER } from './replyHistoryFormat';

const REPLY_FIELD_LABELS: Record<string, string> = {
  campaign_name: 'Kampanija',
  sender_email: 'Siuntėjas',
  received_at: 'Gauta',
  reply_subject: 'Tema',
  first_name: 'Vardas',
  company_name: 'Įmonė',
  lead_email: 'Lido el. paštas',
};

// Deliberately UTC on both sides (mirrored server-side in
// server/src/export/noteFields.ts) rather than the in-app
// formatHistoryTimestamp's local-time + Lithuanian-locale rendering — this
// app has no stored per-company timezone to format against server-side (the
// server's own OS clock is not necessarily the company's), so both paths
// use the same plain, unambiguous format instead of risking an hour
// mismatch between the demo (client-local time) and real (server-local
// time) export paths.
function formatExportTimestamp(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `pretty=true` decorates the entry with its date/author (comments) or a
 * labeled metadata block (replies) — the exact formatting the old
 * "Gražiai suformatuoti" checkbox always produced. `pretty=false` is the
 * plain entry text alone, no decoration — the closest meaningful analogue
 * of "raw data" once the export has already committed to extracting
 * individual entries at all (see exportFlatten.ts's own doc comment on
 * why this checkbox no longer decides WHETHER entries get extracted, only
 * how each one is rendered). */
export function formatCommentEntry(e: NoteEntry, pretty: boolean): string {
  if (!pretty) return e.text;
  const date = formatExportTimestamp(e.createdAt);
  const author = e.authorName ? ` (${e.authorName})` : '';
  const prefix = date ? `${date}${author}: ` : '';
  return `${prefix}${e.text}`;
}

export function formatReplyEntry(e: NoteEntry, pretty: boolean): string {
  if (!pretty) return e.text;
  const fields = e.replyFields ?? {};
  const statusLine = fields.lead_status ? `Statusas: ${fields.lead_status}` : null;
  const headerLines = REPLY_HEADER_FIELD_ORDER.map((key) => (fields[key] ? `${REPLY_FIELD_LABELS[key]}: ${fields[key]}` : null)).filter(
    (l): l is string => !!l,
  );
  return [...(statusLine ? [statusLine] : []), ...headerLines, '', e.text].join('\n');
}

export interface ExtractedNoteEntries {
  /** Every plain hand-typed/tagged entry, in the column's own stored order
   * (newest-first — see addNoteEntry's `unshift`), so entry[0] is always
   * the most recent — the account owner's own explicit requirement for
   * what "Pastaba 1" means in the columns variant. */
  comments: NoteEntry[];
  /** Every Instantly-reply-sourced entry, explicitly re-sorted newest-first
   * by its own `received_at` (not just insertion order — see
   * PushReplyRowsModal.tsx, replies can be pushed out of chronological
   * order relative to when they're inserted into this array). */
  replies: NoteEntry[];
}

export function extractNoteEntries(raw: string): ExtractedNoteEntries {
  const entries = parseNoteHistory(raw);
  const comments = entries.filter((e) => !e.replyFields);
  const replies = entries
    .filter((e) => e.replyFields)
    .sort((a, b) => (b.replyFields?.received_at ?? '').localeCompare(a.replyFields?.received_at ?? ''));
  return { comments, replies };
}
