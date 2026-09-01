import type { Column, Row } from '../types';
import { EMAIL_SEARCH_PATTERN } from './contacts';

// Column-name-agnostic on purpose: destination tables have no single
// canonical "email" column (companies-2026-08-31 has three — El. paštas
// (1)/(2)/(3) — plus emails embedded in the freeform Contacts column), and
// a future per-country table may be shaped completely differently. Scanning
// every text/contact-type column for an email-shaped substring works
// unmodified regardless of column names, same "match by content, not by
// schema" idea as phoneMatch.ts's suffix match.
const SCANNABLE_TYPES: Column['type'][] = ['text', 'contact'];

/** Every email-shaped substring found anywhere in this row's scannable
 * (text/contact) columns, lowercased and deduped. */
export function extractRowEmails(row: Row, columns: Column[]): string[] {
  const emails = new Set<string>();
  const pattern = new RegExp(EMAIL_SEARCH_PATTERN.source, 'g');
  for (const col of columns) {
    if (!SCANNABLE_TYPES.includes(col.type)) continue;
    const raw = row.cells[col.id];
    if (!raw) continue;
    for (const match of raw.matchAll(pattern)) emails.add(match[0].toLowerCase());
  }
  return [...emails];
}

/** Map<lowercased email, row> for every row that has at least one
 * scannable-column email — built fresh per call (recomputing this for a
 * 14k-row table is the same cost class as loading the table itself, which
 * already happens on every table open; not worth caching across calls
 * given exports are infrequent/manual and rows can change in between). */
export function buildEmailIndex(rows: Row[], columns: Column[]): Map<string, Row> {
  const index = new Map<string, Row>();
  for (const row of rows) {
    for (const email of extractRowEmails(row, columns)) {
      if (!index.has(email)) index.set(email, row);
    }
  }
  return index;
}
