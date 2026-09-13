import { EXCEL_CELL_LIMIT } from '../constants';

/** A real, reported incident: a `contact`/`note` cell's whole value is one
 * JSON array of entries (see utils/contacts.ts/noteHistory.ts). A plain
 * character-boundary slice doesn't know that, and can (and did — a
 * ~180-contact cell that grew past the limit) cut in the middle of an
 * entry, leaving JSON that can never be parsed back into a list again —
 * the whole array then falls back to being displayed as one giant
 * garbled "entry" instead of a list, and everything past the cut is
 * silently gone. Fixed by dropping whole array elements from the end
 * (entries are newest-first — see addNoteEntry/addContact's own
 * `unshift` — so this drops the oldest ones) until the re-serialized
 * array fits, so the result is always valid, parseable JSON; only a
 * plain string that doesn't parse as a JSON array falls back to the old
 * byte-slice behavior. */
export function clampToLimit(value: string): { value: string; truncated: boolean } {
  if (value.length <= EXCEL_CELL_LIMIT) return { value, truncated: false };
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      let entries = parsed;
      while (entries.length > 0) {
        const candidate = JSON.stringify(entries);
        if (candidate.length <= EXCEL_CELL_LIMIT) return { value: candidate, truncated: true };
        entries = entries.slice(0, -1);
      }
      return { value: '[]', truncated: true };
    }
  } catch {
    // Not JSON — fall through to the plain slice below.
  }
  return { value: value.slice(0, EXCEL_CELL_LIMIT), truncated: true };
}
