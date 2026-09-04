import { localApiRequest } from './localApi';

export type ImportOperationType = 'contacts_merge' | 'reply_push' | 'mark_sent';

/** One self-describing, independently-reversible change made by an import
 * — never a snapshot of a cell's previous full value. That distinction is
 * the whole point of this log: a note/contact cell is itself a JSON array
 * that can gain unrelated entries (another import, or a plain manual edit)
 * between when this import ran and when it's rolled back, and reverting to
 * a stale "previous value" snapshot would silently destroy those. Instead
 * each entry records just enough identity (an entry id, a contact id, the
 * exact amount a counter moved) to undo precisely this import's own effect
 * against whatever the cell's CURRENT value is at rollback time. See
 * applyImportRollback.ts for how each kind is actually reverted. */
export type ImportChangeEntry =
  // entryIds is a list, not one id — a single push can add more than one
  // note entry to the same destination row (e.g. a multi-message reply
  // thread from one lead pushed in one go), so this must be able to
  // record every entry this import added to that row, not just the last.
  | { tableId: string; rowId: string; kind: 'note_entries_added'; columnId: string; entryIds: string[] }
  | { tableId: string; rowId: string; kind: 'contact_entries_added'; columnId: string; entryIds: string[] }
  | {
      tableId: string;
      rowId: string;
      kind: 'contact_counter_bumped';
      columnId: string;
      contactId: string;
      field: 'sentCount' | 'repliedCount';
      amount: number;
    }
  | { tableId: string; rowId: string; kind: 'cell_color_set'; columnId: string; previousColor: string | null };

export interface ImportOperationRecord {
  id: string;
  type: ImportOperationType;
  label: string;
  recordCount: number;
  status: 'active' | 'rolled_back';
  createdAt: number;
  rolledBackAt: number | null;
  changes: ImportChangeEntry[];
}

export function createImportRecord(input: {
  type: ImportOperationType;
  label: string;
  recordCount: number;
  changes: ImportChangeEntry[];
}): Promise<{ operation: ImportOperationRecord }> {
  return localApiRequest('/api/import-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function listImportRecords(): Promise<{ operations: ImportOperationRecord[] }> {
  return localApiRequest('/api/import-history');
}

export function confirmImportRollback(id: string): Promise<{ ok: true }> {
  return localApiRequest(`/api/import-history/${id}/rollback`, { method: 'POST' });
}
