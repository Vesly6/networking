// Server-side twin of app/src/utils/exportNoteFields.ts — splits a
// note-type column's raw JSON into two readable export columns (comments
// vs. Instantly-reply-sourced entries). This app has no module shared
// across the frontend/backend boundary (same constraint documented
// throughout server/src/export/), so the parsing logic (mirrors
// app/src/utils/noteHistory.ts's parseNoteHistory) and the reply field
// list (mirrors app/src/utils/replyHistoryFormat.ts's
// REPLY_HEADER_FIELD_ORDER) are both ported here by hand — keep both
// copies in sync if either ever changes.

export interface ParsedNoteEntry {
  text: string;
  createdAt: number;
  authorName?: string;
  replyFields?: Record<string, string>;
}

export function parseNoteEntries(raw: string): ParsedNoteEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((e) => e && typeof (e as { text?: unknown }).text === 'string')) {
      return parsed.map((e) => {
        const entry = e as { text: string; createdAt?: unknown; authorName?: unknown; replyFields?: unknown };
        return {
          text: entry.text,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : 0,
          authorName: typeof entry.authorName === 'string' ? entry.authorName : undefined,
          replyFields: entry.replyFields && typeof entry.replyFields === 'object' ? (entry.replyFields as Record<string, string>) : undefined,
        };
      });
    }
  } catch {
    // Not JSON — a legacy plain-text note falls through below.
  }
  const trimmed = raw.trim();
  return trimmed ? [{ text: trimmed, createdAt: 0 }] : [];
}

// Mirrors replyHistoryFormat.ts's REPLY_HEADER_FIELD_ORDER + labels exactly.
const REPLY_HEADER_FIELD_ORDER = ['campaign_name', 'sender_email', 'received_at', 'reply_subject', 'first_name', 'company_name', 'lead_email'] as const;
const REPLY_FIELD_LABELS: Record<string, string> = {
  campaign_name: 'Kampanija',
  sender_email: 'Siuntėjas',
  received_at: 'Gauta',
  reply_subject: 'Tema',
  first_name: 'Vardas',
  company_name: 'Įmonė',
  lead_email: 'Lido el. paštas',
};

// Deliberately UTC — see app/src/utils/exportNoteFields.ts's own doc
// comment on why both sides use this plain format rather than the in-app
// formatHistoryTimestamp's local-time/Lithuanian-locale rendering.
function formatExportTimestamp(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function formatCommentEntry(e: ParsedNoteEntry): string {
  const date = formatExportTimestamp(e.createdAt);
  const author = e.authorName ? ` (${e.authorName})` : '';
  const prefix = date ? `${date}${author}: ` : '';
  return `${prefix}${e.text}`;
}

function formatReplyEntry(e: ParsedNoteEntry): string {
  const fields = e.replyFields ?? {};
  const statusLine = fields.lead_status ? `Statusas: ${fields.lead_status}` : null;
  const headerLines = REPLY_HEADER_FIELD_ORDER.map((key) => (fields[key] ? `${REPLY_FIELD_LABELS[key]}: ${fields[key]}` : null)).filter(
    (l): l is string => !!l,
  );
  return [...(statusLine ? [statusLine] : []), ...headerLines, '', e.text].join('\n');
}

export function splitNoteEntries(raw: string): { comments: string; replies: string } {
  const entries = parseNoteEntries(raw);
  const comments = entries.filter((e) => !e.replyFields);
  const replies = entries
    .filter((e) => e.replyFields)
    .sort((a, b) => (b.replyFields?.received_at ?? '').localeCompare(a.replyFields?.received_at ?? ''));
  return {
    comments: comments.map(formatCommentEntry).join('\n\n'),
    replies: replies.map(formatReplyEntry).join('\n\n---\n\n'),
  };
}
