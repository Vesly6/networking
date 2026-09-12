// Copied as-is from app/src/utils/highlight.tsx.
import type { ReactNode } from 'react';

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
