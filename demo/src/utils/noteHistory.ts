import { randomUUID } from './uuid';

// Trimmed copy of app/src/utils/noteHistory.ts — same JSON-array-of-dated-
// entries shape and legacy-plain-string fallback, minus authorName/
// replyFields (no auth or Instantly-reply concept in this demo).
export interface NoteEntry {
  id: string;
  text: string;
  /** Epoch ms; 0 for a legacy plain-text value with no known time. */
  createdAt: number;
}

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
 * are left untouched. */
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

// Copied from production's CellHoverEditor.tsx — the current, full
// 7-tag set (English labels, matching this demo's own convention). Every
// one of these is composed together with a contact's name when logged
// (see the "who is this about" picker in DemoDataCell.tsx's note
// branch) — a tag is never stored standalone anymore, matching
// production's own current behavior.
export const NOTE_TAGS: Array<{ label: string; color: string }> = [
  { label: 'Email', color: '#e3ecf7' },
  { label: 'Email follow-up', color: '#e1f0ef' },
  { label: 'Proposal', color: '#e5f0e3' },
  { label: 'Proposal follow-up', color: '#f3f0dd' },
  { label: 'Meeting scheduled', color: '#eee3f3' },
  { label: 'Meeting completed', color: '#f5e3ec' },
  { label: 'Call', color: '#f6e9dd' },
];
export const NOTE_TAG_COLORS: Record<string, string> = Object.fromEntries(NOTE_TAGS.map((t) => [t.label, t.color]));

// "Didn't answer" — same idea as production's neatsiliepė: a quick-tag
// whose click opens a contact picker (not a fixed-label add), composed
// as a *suffix* ("{name} Didn't answer") so it reads like the request
// itself ("X didn't answer").
export const NO_ANSWER_SUFFIX = "Didn't answer";
export const NO_ANSWER_COLOR = '#e2e2e2';

// "LinkedIn request" — same idea as production's "LinkedIn užklausa":
// composed as a *prefix* ("LinkedIn request {name}"), matching how the
// request itself reads ("sent a LinkedIn request to X").
export const LINKEDIN_REQUEST_PREFIX = 'LinkedIn request';
export const LINKEDIN_REQUEST_COLOR = '#d6e7f7';

export interface TaggedEntry {
  color: string;
  /** Just the fixed tag word/phrase — never the name/rest of the text. */
  tagLabel: string;
  /** Everything besides the tag itself (a contact's name, '' for a
   * legacy standalone tag with no name at all). */
  restText: string;
  tagPosition: 'prefix' | 'suffix' | 'whole';
}

/** Ported from production's parseTaggedEntry (CellHoverEditor.tsx) —
 * detects whether a stored entry's text is "just a tag" (a legacy entry
 * logged before tags required a name), "{tag} {name}" (every current
 * plain tag, and the LinkedIn request tag), or "{name} Didn't answer"
 * (the one suffix-shaped tag) — and splits the tag word out from the
 * rest so it can render as a small colored chip inline, instead of
 * coloring the whole entry. Returns null for plain untagged text. */
export function parseTaggedEntry(text: string): TaggedEntry | null {
  if (NOTE_TAG_COLORS[text]) {
    return { color: NOTE_TAG_COLORS[text], tagLabel: text, restText: '', tagPosition: 'whole' };
  }
  // None of the 7 labels is itself a prefix of another (checked
  // directly), so .find's first match is always the right one.
  const matchingTag = NOTE_TAGS.find((t) => text.startsWith(`${t.label} `));
  if (matchingTag) {
    return { color: matchingTag.color, tagLabel: matchingTag.label, restText: text.slice(matchingTag.label.length + 1), tagPosition: 'prefix' };
  }
  if (text.endsWith(` ${NO_ANSWER_SUFFIX}`)) {
    return { color: NO_ANSWER_COLOR, tagLabel: NO_ANSWER_SUFFIX, restText: text.slice(0, -(NO_ANSWER_SUFFIX.length + 1)), tagPosition: 'suffix' };
  }
  if (text.startsWith(`${LINKEDIN_REQUEST_PREFIX} `)) {
    return {
      color: LINKEDIN_REQUEST_COLOR,
      tagLabel: LINKEDIN_REQUEST_PREFIX,
      restText: text.slice(LINKEDIN_REQUEST_PREFIX.length + 1),
      tagPosition: 'prefix',
    };
  }
  return null;
}

const historyFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** English equivalent of production's formatHistoryTimestamp — no
 * date-fns dependency added for this one call site, matching this
 * demo's existing "no heavy UI dependencies" convention. */
export function formatHistoryTimestamp(ms: number): string {
  if (!ms) return '';
  return historyFormatter.format(new Date(ms));
}
