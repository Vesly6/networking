import type { ReactNode } from 'react';

/** Wraps every case-insensitive occurrence of one or more queries in
 * `text` with a <mark> — backs the table search box's "highlight
 * matches" behavior. Accepts either a single query (the plain live
 * search box text) or an array (that text plus every committed search
 * tag — see TableView's own searchTags) so a row matched by several
 * different tags shows all of them highlighted, not just one. Only ever
 * called on rows the search has already matched (TableView's
 * filteredSortedRows), never run over the whole table, so this doesn't
 * need to be fast at scale.
 *
 * Multiple queries are applied one at a time over the growing node list
 * rather than in one combined pass — each pass only re-scans the plain
 * string fragments left over from the previous one, since an already-
 * produced <mark> is a JSX element, not a string, and gets skipped
 * automatically. This is what keeps two overlapping/adjacent matches
 * from double-wrapping the same characters. */
export function highlightMatches(text: string, queries: string | string[]): ReactNode {
  const list = (Array.isArray(queries) ? queries : [queries]).map((q) => q.trim()).filter(Boolean);
  if (list.length === 0 || !text) return text;

  let nodes: ReactNode[] = [text];
  let key = 0;
  for (const q of list) {
    const lowerQ = q.toLowerCase();
    const next: ReactNode[] = [];
    for (const node of nodes) {
      if (typeof node !== 'string') {
        next.push(node);
        continue;
      }
      const lowerNode = node.toLowerCase();
      if (!lowerNode.includes(lowerQ)) {
        next.push(node);
        continue;
      }
      let start = 0;
      let idx = lowerNode.indexOf(lowerQ, start);
      while (idx !== -1) {
        if (idx > start) next.push(node.slice(start, idx));
        next.push(
          <mark key={key++} className="cell-highlight">
            {node.slice(idx, idx + q.length)}
          </mark>,
        );
        start = idx + q.length;
        idx = lowerNode.indexOf(lowerQ, start);
      }
      if (start < node.length) next.push(node.slice(start));
    }
    nodes = next;
  }
  return nodes;
}
