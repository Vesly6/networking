import type { Column, Row } from '../types';
import { INTEREST_LABEL_COLORS } from './instantlyApi';
import { localApiRequest } from './localApi';

/** The fields an Instantly reply carries once synced into "Visi
 * atsakymai" (see server/src/instantlyReplySync.ts's REPLY_COLUMNS, which
 * this mirrors minus reply_snippet — a truncated duplicate of reply_text,
 * not worth carrying separately). Single source of truth for how a reply
 * is read and rendered, shared by the bulk "push selected rows" flow and
 * the per-row "Peržiūrėti istoriją" live-preview toggle, so the two paths
 * can never format the same data differently. */
export interface ReplyRowFields {
  lead_status: string;
  received_at: string;
  first_name: string;
  company_name: string;
  lead_email: string;
  sender_email: string;
  reply_subject: string;
  reply_text: string;
  campaign_name: string;
}

/** Top-to-bottom order for the bold metadata header — on explicit
 * request ("моя идея с тегами слишком зашла далеко... но подчеркнуть
 * информацию на начале чтоб она была заметна"): a per-field colored pill
 * for every metadata field was too much, but the metadata still needs to
 * stand out from the reply_text body below it — a plain bold text block
 * does that with far less visual noise. lead_status is excluded here —
 * it's the one field that keeps its own colored badge (a single pill,
 * not "tags" plural, and matches the original explicit ask that this one
 * field specifically needs a color), rendered separately above this
 * block (see CellHoverEditor.tsx's renderReplyHeader). */
export const REPLY_HEADER_FIELD_ORDER: Array<Exclude<keyof ReplyRowFields, 'reply_text' | 'lead_status'>> = [
  'campaign_name',
  'sender_email',
  'received_at',
  'reply_subject',
  'first_name',
  'company_name',
  'lead_email',
];

export function replyStatusColor(label: string): string | undefined {
  return INTEREST_LABEL_COLORS[label];
}

/** Every field worth persisting into a NoteEntry.replyFields dict — same
 * as REPLY_HEADER_FIELD_ORDER plus lead_status (still stored so the badge
 * can read it back at render time; it just doesn't get its own bold-block
 * line, since it renders as the colored pill instead). */
export const REPLY_STORED_FIELD_ORDER: Array<Exclude<keyof ReplyRowFields, 'reply_text'>> = [
  ...REPLY_HEADER_FIELD_ORDER,
  'lead_status',
];

/** Strips every blank line and trims each remaining line — on explicit
 * request ("чтоб занимало меньше места... без пустых линий"), so a
 * reply's original email paragraph spacing doesn't bloat the History
 * entry. Applied to reply_text only — the one field long/free-form enough
 * to carry that spacing in the first place. */
export function cleanReplyText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

/** A real reply's reply_text is the WHOLE email-client rendering — the
 * newest message on top, followed by the entire quoted older thread
 * (each repeat carrying its own "From:/Sent:/To:/Subject:" block and
 * often a legal disclaimer) — not just the new content. Confirmed live:
 * a real reply's actually-new message was 4 lines; the rest was 30+
 * lines of quoted noise, long/dense enough to trigger a real editing bug
 * (see CellHoverEditor.tsx). Server-side AI extraction (gpt-4o-mini,
 * see server/src/openai.ts's extractLatestEmailMessage) keeps just the
 * newest message — rule-based cutting at the first "From:" line is too
 * fragile across email clients' different quote-marker formats. Batched
 * (one request for every selected row in a push, not one per row) —
 * falls back to the ORIGINAL raw texts on any request-level failure
 * (network, missing API key) so a bulk push never blocks entirely on
 * this being unavailable; cleanReplyText should still run on the result
 * afterward for blank-line stripping either way. */
export async function extractLatestEmailMessages(rawTexts: string[]): Promise<string[]> {
  try {
    const { texts } = await localApiRequest<{ texts: string[] }>('/api/instantly/extract-reply-texts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: rawTexts }),
    });
    return texts;
  } catch {
    return rawTexts;
  }
}

const ALL_FIELD_KEYS: Array<keyof ReplyRowFields> = [
  'lead_status',
  'received_at',
  'first_name',
  'company_name',
  'lead_email',
  'sender_email',
  'reply_subject',
  'reply_text',
  'campaign_name',
];

/** Resolves one "Visi atsakymai" row's cells into ReplyRowFields, keyed by
 * COLUMN NAME (not id) — reused by both the bulk push flow (Step 3) and
 * the per-row live-preview toggle (Step 4), so a row from that table
 * reads the same way regardless of which feature is looking at it. */
export function resolveReplyFields(row: Row, sourceColumns: Column[]): ReplyRowFields {
  const colByName = new Map(sourceColumns.map((c) => [c.name, c.id]));
  const fields = {} as ReplyRowFields;
  for (const key of ALL_FIELD_KEYS) {
    const colId = colByName.get(key);
    fields[key] = (colId ? row.cells[colId] : undefined) ?? '';
  }
  return fields;
}
