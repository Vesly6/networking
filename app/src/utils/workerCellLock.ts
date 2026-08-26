import type { Column } from '../types';
import type { AuthUser } from '../store/useAuthStore';

const APPEND_ONLY_COLUMN_TYPES = new Set(['text', 'phone', 'company', 'link']);

/** Mirrors server/src/tableData/db.ts's sanitizeRowForWorker exactly — the
 * client-side half of the same rule, shared by DataCell.tsx's click-to-
 * edit gate and TableView.tsx's Delete/Backspace handler, so a worker
 * never sees an action look like it succeeded (cell goes blank, selection
 * clears) only to have the server silently revert it on the next reload.
 * That gap was real and reported: Delete/Backspace went through
 * TableView's own `updateCells` call directly, never checking this at
 * all, so a worker could clear a protected cell's *displayed* value even
 * though the write was always being reverted server-side — confusing
 * exactly the way this shared check exists to prevent.
 *
 * `currentValue` is whatever's stored for this cell *right now* (before
 * the attempted change) — text/phone/company/link are append-only
 * unconditionally (not gated by any permission at all, same as the
 * server); note/contact only lock once they hold entries and the worker
 * lacks the delete permission for that column type (clearing a note/
 * contact cell to '' is a full wipe of every entry, the same thing
 * canDeleteNotes/canDeleteContacts already gate one entry at a time in
 * CellHoverEditor.tsx); date/dropdown stay unrestricted either way — the
 * calendar/status workflow the plan deliberately keeps free for workers. */
export function isCellLockedForWorker(column: Column, currentValue: string, user: AuthUser | null): boolean {
  if (!user || user.role !== 'worker') return false;
  if (currentValue === '') return false;
  if (APPEND_ONLY_COLUMN_TYPES.has(column.type)) return true;
  if (column.type === 'note') return !user.permissions.canDeleteNotes;
  if (column.type === 'contact') return !user.permissions.canDeleteContacts;
  return false;
}
