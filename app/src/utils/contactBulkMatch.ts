import type { Row, TableMeta } from '../types';
import { loadTables, loadRowsForTable } from '../db/db';
import { getColumnByType } from './row';
import { EMAIL_SEARCH_PATTERN } from './contacts';

export interface ContactMatchCandidate {
  row: Row;
  table: TableMeta;
  contactColId: string;
}

/** Shared matching engine behind every "paste/upload a list of email
 * addresses, find them across the whole workspace" bulk action
 * (MarkContactsSentModal, AddSenderModal) — factored out once a second
 * real consumer needed the identical logic, rather than duplicating it.
 *
 * Always fetches a fresh table list from the server (loadTables()), never
 * a caller's cached useWorkspaceStore.getState().tables snapshot — a
 * real, reproduced bug: that snapshot's `columns` is a load-time copy
 * that's never updated when a column is added/removed/retyped through
 * the currently-open table (only the server record is). Deleting a
 * table's Contacts column and adding a new one left a stale snapshot
 * still pointing at the OLD, now-nonexistent column id, so a table with
 * hundreds of fresh, correctly-typed contacts silently contributed zero
 * matches. See CLAUDE.md's "always re-read on load" rule — this is the
 * same class of staleness loadTable() itself already guards against.
 *
 * Scoped to ONLY each table's own Contacts column (not a broader
 * text+contact scan like emailMatch.ts's buildEmailIndex) — and returns
 * EVERY table where a real Contacts entry matches, not just the first
 * one found. A company can legitimately exist in more than one
 * workspace table at once (a filtered campaign table plus a shared
 * master list), and the master list often has the same email sitting in
 * a *different*, plain-text column without it ever being added to that
 * table's own Contacts entries — "first match wins" silently swallowed
 * the email on whichever table iterated first, even when it couldn't
 * actually credit it, and the table with the real Contacts entry was
 * never even checked. Verified against a real ~360-address export: this
 * alone was worth dozens of silently-lost matches. Every candidate
 * returned here is guaranteed to actually resolve to a ContactEntry via
 * findContactIdByEmail — a text-column-only hit is never useful to any
 * of this feature's callers (there's no ContactEntry there to credit),
 * so it's excluded at the source rather than surfacing as a confusing
 * "found the row but not the contact" case downstream.
 */
export async function findContactCandidates(emails: string[]): Promise<Map<string, ContactMatchCandidate[]>> {
  const wanted = new Set(emails.map((e) => e.toLowerCase()));
  const freshTables = await loadTables();
  const rowsPerTable = await Promise.all(freshTables.map((t) => loadRowsForTable(t.id)));
  const pattern = new RegExp(EMAIL_SEARCH_PATTERN.source, 'g');
  const candidatesByEmail = new Map<string, ContactMatchCandidate[]>();
  freshTables.forEach((table, i) => {
    const contactColId = getColumnByType(table.columns, 'contact')?.id;
    if (!contactColId) return;
    for (const row of rowsPerTable[i]) {
      const raw = row.cells[contactColId];
      if (!raw) continue;
      // Filtered by `wanted` here, not just deduped — a workspace can hold
      // tens of thousands of contact entries while a single bulk action
      // only ever asks about a few hundred/thousand of them, so there's
      // no point building candidate lists for every other email in the
      // workspace on every call.
      for (const m of new Set([...raw.matchAll(pattern)].map((x) => x[0].toLowerCase()))) {
        if (!wanted.has(m)) continue;
        const list = candidatesByEmail.get(m) ?? [];
        list.push({ row, table, contactColId });
        candidatesByEmail.set(m, list);
      }
    }
  });
  return candidatesByEmail;
}
