import { randomUUID } from 'crypto';

/** Server-side port of app/src/utils/noteHistory.ts's NoteEntry/
 * parseNoteHistory/addNoteEntry — this codebase has no module shared
 * across the frontend/backend boundary (same constraint documented in
 * server/src/export/noteFields.ts and server/src/linkedinPlanner/
 * contactParsing.ts), so this is a deliberate, hand-kept duplicate. Only
 * what's needed to APPEND one new entry is ported here — reading/editing/
 * removing an entry already has no server-side caller. */
interface ServerNoteEntry {
  id: string;
  text: string;
  createdAt: number;
  authorName?: string;
}

function parseNoteHistory(raw: string): ServerNoteEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((e) => e && typeof (e as { text?: unknown }).text === 'string')) {
      return (parsed as Array<Record<string, unknown>>).map((e) => ({
        id: typeof e.id === 'string' ? e.id : randomUUID(),
        text: e.text as string,
        createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
        authorName: typeof e.authorName === 'string' ? e.authorName : undefined,
      }));
    }
  } catch {
    // Not JSON — a legacy plain-text note falls through below.
  }
  const trimmed = raw.trim();
  return trimmed ? [{ id: 'legacy', text: trimmed, createdAt: 0 }] : [];
}

/** Prepends a new dated entry (newest first) and re-serializes — mirrors
 * addNoteEntry's exact shape/behavior so an auto-logged entry is
 * indistinguishable, once written, from one a human typed by hand. */
export function addNoteEntry(raw: string, text: string, authorName?: string): string {
  const trimmed = text.trim();
  if (!trimmed) return raw;
  const existing = parseNoteHistory(raw);
  const entry: ServerNoteEntry = { id: randomUUID(), text: trimmed, createdAt: Date.now(), authorName };
  return JSON.stringify([entry, ...existing]);
}

/** The exact tag text CellHoverEditor.tsx's own "LinkedIn užklausa"
 * quick-tag button writes when a worker logs this by hand (pick a
 * contact, note reads "LinkedIn užklausa {name}") — matched exactly here
 * so an entry auto-logged by the Planner's "Kvietimas išsiųstas" button
 * renders identically (same colored chip via parseTaggedEntry) to one
 * logged the old manual way, and so the two are indistinguishable in a
 * row's own history other than the recorded author. */
export const LINKEDIN_REQUEST_PREFIX = 'LinkedIn užklausa';
