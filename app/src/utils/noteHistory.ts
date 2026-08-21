import { randomUUID } from './uuid';

export interface NoteEntry {
  id: string;
  text: string;
  /** Epoch ms; 0 for a legacy plain-text value migrated with no known time. */
  createdAt: number;
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

/** Prepends a new dated entry (newest first) and re-serializes. */
export function addNoteEntry(raw: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return raw;
  const existing = parseNoteHistory(raw);
  const entry: NoteEntry = { id: randomUUID(), text: trimmed, createdAt: Date.now() };
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
