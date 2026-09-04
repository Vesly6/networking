import type { Row } from '../types';
import { getTable, loadRowsForTable, saveRows } from '../db/db';
import { removeNoteEntry } from './noteHistory';
import { parseContacts, serializeContacts, decrementContactCounter } from './contacts';
import type { ImportChangeEntry } from './importHistory';

export interface RollbackResult {
  rowsReverted: number;
  /** A row this import touched no longer exists (deleted since) — its
   * change is simply skipped, not an error; nothing to revert. */
  rowsSkipped: number;
  /** A whole table this import touched has since been deleted — every
   * change belonging to it is skipped the same way. */
  tablesSkipped: number;
}

/** Computes and applies the revert for one import's logged changes,
 * against whatever the affected rows' CURRENT state is — never a
 * snapshot from import time (see ImportChangeEntry's own doc comment for
 * why). Reuses the exact same note/contact JSON-array helpers the
 * writing modals (MergeContactsModal/PushReplyRowsModal/
 * MarkContactsSentModal) already go through, so this never touches a
 * note/contact cell's raw JSON directly either — same "only these
 * modules touch that JSON" rule CLAUDE.md documents for the rest of the
 * app.
 *
 * Grouped by table, then by row, so a row touched by more than one
 * change in the same import (e.g. PushReplyRowsModal's note-entry-add
 * and repliedCount-bump landing on the same destination row) is only
 * read and saved once. Writes go through the ordinary saveRows() path —
 * the same authenticated, company-scoped route every other row write in
 * this app already uses — so a rollback can never touch a table
 * belonging to a different company, same as any other write.
 *
 * Only called after the caller has confirmed the operation is still
 * 'active' (server-side, via getImportOperation) — this function itself
 * has no concept of "already rolled back," it just applies whatever
 * changes it's given. */
export async function applyImportRollback(changes: ImportChangeEntry[]): Promise<RollbackResult> {
  const byTable = new Map<string, ImportChangeEntry[]>();
  for (const change of changes) {
    const list = byTable.get(change.tableId) ?? [];
    list.push(change);
    byTable.set(change.tableId, list);
  }

  let rowsReverted = 0;
  let rowsSkipped = 0;
  let tablesSkipped = 0;

  for (const [tableId, tableChanges] of byTable) {
    const table = await getTable(tableId);
    if (!table) {
      tablesSkipped++;
      continue;
    }
    const rows = await loadRowsForTable(tableId);
    const rowById = new Map(rows.map((r) => [r.id, r]));

    const byRow = new Map<string, ImportChangeEntry[]>();
    for (const change of tableChanges) {
      const list = byRow.get(change.rowId) ?? [];
      list.push(change);
      byRow.set(change.rowId, list);
    }

    const toSave: Row[] = [];
    for (const [rowId, rowChanges] of byRow) {
      const row = rowById.get(rowId);
      if (!row) {
        rowsSkipped++;
        continue;
      }
      let cells = row.cells;
      let colors = row.colors;
      for (const change of rowChanges) {
        switch (change.kind) {
          case 'note_entries_added': {
            let current = cells[change.columnId] ?? '';
            for (const entryId of change.entryIds) current = removeNoteEntry(current, entryId);
            cells = { ...cells, [change.columnId]: current };
            break;
          }
          case 'contact_entries_added': {
            const current = cells[change.columnId] ?? '';
            const remaining = parseContacts(current).filter((entry) => !change.entryIds.includes(entry.id));
            cells = { ...cells, [change.columnId]: serializeContacts(remaining) };
            break;
          }
          case 'contact_counter_bumped': {
            const current = cells[change.columnId] ?? '';
            cells = {
              ...cells,
              [change.columnId]: decrementContactCounter(current, change.contactId, change.field, change.amount),
            };
            break;
          }
          case 'cell_color_set': {
            const nextColors = { ...(colors ?? {}) };
            if (change.previousColor === null) delete nextColors[change.columnId];
            else nextColors[change.columnId] = change.previousColor;
            colors = nextColors;
            break;
          }
        }
      }
      toSave.push({ ...row, cells, colors, updatedAt: Date.now() });
      rowsReverted++;
    }
    if (toSave.length > 0) await saveRows(toSave);
  }

  return { rowsReverted, rowsSkipped, tablesSkipped };
}
