// Splits a note-type column's raw JSON into two human-readable export
// columns — on explicit request ("заметки экспортируется довольно
// коряво"): a plain hand-typed/tagged comment reads completely
// differently from an entry auto-pushed in from an Instantly reply (see
// utils/replyHistoryFormat.ts), so mashing both into one raw-JSON cell is
// what looked "коряво" in the first place. Reuses the app's own real
// parser/field list (parseNoteHistory, REPLY_HEADER_FIELD_ORDER) rather
// than re-deriving the comment/reply split — this is the same
// commentEntries/replyEntries distinction CellHoverEditor.tsx's own
// history view already makes (NoteEntry.replyFields present or not).
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
// formatHistoryTimestamp's local-time + Lithuanian-locale rendering —
// this app has no stored per-company timezone to format against
// server-side (the server's own OS clock is not necessarily the
// company's), so both paths use the same plain, unambiguous format
// instead of risking an hour mismatch between the demo (client-local
// time) and real (server-local time) export paths.
function formatExportTimestamp(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function formatCommentEntry(e: NoteEntry): string {
  const date = formatExportTimestamp(e.createdAt);
  const author = e.authorName ? ` (${e.authorName})` : '';
  const prefix = date ? `${date}${author}: ` : '';
  return `${prefix}${e.text}`;
}

function formatReplyEntry(e: NoteEntry): string {
  const fields = e.replyFields ?? {};
  const statusLine = fields.lead_status ? `Statusas: ${fields.lead_status}` : null;
  const headerLines = REPLY_HEADER_FIELD_ORDER.map((key) => (fields[key] ? `${REPLY_FIELD_LABELS[key]}: ${fields[key]}` : null)).filter(
    (l): l is string => !!l,
  );
  return [...(statusLine ? [statusLine] : []), ...headerLines, '', e.text].join('\n');
}

/** `comments` = every plain hand-typed/tagged entry, newest-first, one per
 * paragraph. `replies` = every Instantly-reply-sourced entry (sorted the
 * same newest-first way CellHoverEditor.tsx's own replyEntries already
 * is), each rendered as a small labeled block instead of a raw
 * replyFields dict. Both come back as one multi-line string per column —
 * CSV/XLSX cells already handle embedded newlines correctly via this
 * app's existing RFC4180 quoting (utils/tsv.ts), same as any other
 * multi-line cell value. */
export function splitNoteEntries(raw: string): { comments: string; replies: string } {
  const entries = parseNoteHistory(raw);
  const comments = entries.filter((e) => !e.replyFields);
  const replies = entries
    .filter((e) => e.replyFields)
    .sort((a, b) => (b.replyFields?.received_at ?? '').localeCompare(a.replyFields?.received_at ?? ''));
  return {
    comments: comments.map(formatCommentEntry).join('\n\n'),
    replies: replies.map(formatReplyEntry).join('\n\n---\n\n'),
  };
}
