import type { ReactNode } from 'react';

/** Wraps every case-insensitive occurrence of `query` in `text` with a
 * <mark> — backs the table search box's "highlight matches" behavior.
 * Only ever called on rows the search has already matched (TableView's
 * filteredSortedRows), never run over the whole table, so this doesn't
 * need to be fast at scale. */
export function highlightMatches(text: string, query: string): ReactNode {
  if (!query.trim() || !text) return text;
  const q = query.trim();
  const lowerText = text.toLowerCase();
  const lowerQ = q.toLowerCase();
  if (!lowerText.includes(lowerQ)) return text;

  const parts: ReactNode[] = [];
  let start = 0;
  let idx = lowerText.indexOf(lowerQ, start);
  let key = 0;
  while (idx !== -1) {
    if (idx > start) parts.push(text.slice(start, idx));
    parts.push(
      <mark key={key++} className="cell-highlight">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    start = idx + q.length;
    idx = lowerText.indexOf(lowerQ, start);
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}
