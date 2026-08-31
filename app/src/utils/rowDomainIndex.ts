import type { Column, Row } from '../types';
import { normalizeDomain } from './domainMatch';
import { getPrimaryLabel } from './row';

export interface RowDomainMatch {
  rowId: string;
  label: string;
}

/** Keyed by normalizeDomain() of a `link`-type column's cell value. Unlike
 * rowPhoneIndex.ts's buildPhoneIndex (one match per key, last-write-wins),
 * this keeps an *array* per domain — a real, if rare, case in actual
 * customer data: two different company rows can legitimately share one
 * domain (sister companies / rebrands, e.g. "Forge LT, UAB" and "Forge LT
 * Engineering, UAB" both on forge.lt). Silently picking one would be wrong
 * often enough to matter; MergeContactsModal.tsx surfaces any key with more
 * than one entry as a collision the user resolves by hand, rather than
 * guessing. */
export function buildDomainIndex(columns: Column[], rows: Row[], linkColumnId: string): Map<string, RowDomainMatch[]> {
  const index = new Map<string, RowDomainMatch[]>();
  for (const row of rows) {
    const domain = normalizeDomain(row.cells[linkColumnId] ?? '');
    if (!domain) continue;
    const match: RowDomainMatch = { rowId: row.id, label: getPrimaryLabel(row, columns) };
    const existing = index.get(domain);
    if (existing) existing.push(match);
    else index.set(domain, [match]);
  }
  return index;
}
