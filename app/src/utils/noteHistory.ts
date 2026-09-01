import { randomUUID } from './uuid';

export interface NoteEntry {
  id: string;
  text: string;
  /** Epoch ms; 0 for a legacy plain-text value migrated with no known time. */
  createdAt: number;
  /** Who added this entry — "First Last" from useAuthStore at the moment
   * addNoteEntry() was called (see its own doc comment). Undefined for
   * every entry logged before this shipped and for the single-string
   * legacy fallback below; CellHoverEditor's rendering just omits the
   * author line in that case rather than showing a placeholder. */
  authorName?: string;
  /** Set only on an entry pushed in from an Instantly reply (the
   * cross-table History mapping feature — see replyHistoryFormat.ts) —
   * the reply's metadata fields (campaign_name, sender_email,
   * received_at, reply_subject, first_name, company_name, lead_status,
   * lead_email — see REPLY_TAG_ORDER), rendered as colored tags above
   * `text` (which, for one of these entries, is just the reply's own
   * body — see cleanReplyText) instead of plain text lines. Undefined
   * for every ordinary, hand-typed/tagged note entry. */
  replyFields?: Record<string, string>;
}

/** A note cell's stored value is a JSON array of dated entries (newest
 * first) once this feature has touched it. Older cells — hand-typed before
 * this existed, or written by CSV import, which just puts raw text into a
 * note-type column — are still a bare string; treat that as a single
 * undated legacy entry rather than losing it. */
export function parseNoteHistory(raw: string): NoteEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((e) => e && typeof e.text === 'string')) {
      return parsed.map((e) => ({
        id: typeof e.id === 'string' ? e.id : randomUUID(),
        text: e.text,
        createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
        authorName: typeof e.authorName === 'string' ? e.authorName : undefined,
        replyFields: e.replyFields && typeof e.replyFields === 'object' ? e.replyFields : undefined,
      }));
    }
  } catch {
    // Not JSON — a legacy plain-text note falls through below.
  }
  return [{ id: 'legacy', text: raw, createdAt: 0 }];
}

export function serializeNoteHistory(entries: NoteEntry[]): string {
  return JSON.stringify(entries);
}

/** Prepends a new dated entry (newest first) and re-serializes.
 * `authorName` is the currently logged-in user's "First Last" (passed by
 * the caller — this module has no store access of its own, matching its
 * existing "just JSON in, JSON out" shape) — undefined when there's no
 * multi-user context to attribute (shouldn't normally happen post-login,
 * but kept optional rather than required so this function doesn't need
 * to know anything about auth state itself). */
export function addNoteEntry(raw: string, text: string, authorName?: string, replyFields?: Record<string, string>): string {
  const trimmed = text.trim();
  if (!trimmed) return raw;
  const existing = parseNoteHistory(raw);
  const entry: NoteEntry = { id: randomUUID(), text: trimmed, createdAt: Date.now(), authorName, replyFields };
  return serializeNoteHistory([entry, ...existing]);
}

/** Edits an existing entry's text in place; its position and `createdAt`
 * (when it was originally logged) are left untouched. */
export function updateNoteEntry(raw: string, id: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return raw;
  const existing = parseNoteHistory(raw);
  return serializeNoteHistory(existing.map((e) => (e.id === id ? { ...e, text: trimmed } : e)));
}

export function removeNoteEntry(raw: string, id: string): string {
  return serializeNoteHistory(parseNoteHistory(raw).filter((e) => e.id !== id));
}

export function getLatestNoteText(raw: string): string {
  return parseNoteHistory(raw)[0]?.text ?? '';
}
