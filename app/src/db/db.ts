import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { Row, TableMeta, TableFolder } from '../types';
import type { TranscriptionRecord, SmsLogRecord } from '../utils/callsApi';
import type { CallStatRecord } from '../utils/callStats';
import { localApiRequest } from '../utils/localApi';

interface AppDB extends DBSchema {
  tables: {
    key: string;
    value: TableMeta;
  };
  rows: {
    key: string;
    value: Row;
    indexes: { 'by-table': string };
  };
  transcriptions: {
    key: string;
    value: TranscriptionRecord;
  };
  callStats: {
    key: string;
    value: CallStatRecord;
  };
  smsLog: {
    key: string;
    value: SmsLogRecord;
  };
}

const DB_NAME = 'cold-calls-crm';
// v5: added smsLog — Zadarma's API has no way to check a sent SMS's status
// or history after the fact (confirmed against their own official PHP
// reference client: sendSms() is the only SMS method that exists), and
// this app didn't persist anything about a send either — so "did that SMS
// actually go out?" was genuinely unanswerable after the fact, a real gap
// reported directly. Every send attempt (success or failure) now gets a
// local record, same "local, permanent copy" reasoning callStats already
// documents for call history.
const DB_VERSION = 5;

let dbPromise: Promise<IDBPDatabase<AppDB>> | null = null;

function getDB(): Promise<IDBPDatabase<AppDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AppDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        // v1 had a single implicit table ("meta"/"rows" without tableId). No real
        // user data existed on v1 yet, so we drop those stores instead of migrating.
        const legacyDb = db as unknown as { objectStoreNames: DOMStringList; deleteObjectStore(name: string): void };
        if (oldVersion < 2) {
          if (legacyDb.objectStoreNames.contains('meta')) legacyDb.deleteObjectStore('meta');
          if (legacyDb.objectStoreNames.contains('rows')) legacyDb.deleteObjectStore('rows');
        }
        if (!db.objectStoreNames.contains('tables')) {
          db.createObjectStore('tables', { keyPath: 'id' });
        }
        const rowStore = db.objectStoreNames.contains('rows')
          ? undefined
          : db.createObjectStore('rows', { keyPath: 'id' });
        if (rowStore) {
          rowStore.createIndex('by-table', 'tableId');
        }
        if (!db.objectStoreNames.contains('transcriptions')) {
          db.createObjectStore('transcriptions', { keyPath: 'callId' });
        }
        if (!db.objectStoreNames.contains('callStats')) {
          db.createObjectStore('callStats', { keyPath: 'call_id' });
        }
        if (!db.objectStoreNames.contains('smsLog')) {
          db.createObjectStore('smsLog', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

// --- Table/row data now lives server-side (server/src/tableData/db.ts) —
// see CLAUDE.md's own section on this migration for the full "phone
// showed zero contacts" story that drove it. These functions keep their
// exact original names/signatures (all still return the same Promise<T>
// shapes as before) and are called from exactly the same places
// (useTableStore.ts/useWorkspaceStore.ts, which never touched IndexedDB
// directly to begin with) — only the body changed, from `idb` calls to
// `localApiRequest` calls against the new server routes. The `tables`/
// `rows` IndexedDB object stores themselves are untouched and still
// declared below (see AppDB) purely so the one-time migration helpers
// further down this file can still read whatever old local data exists.

export async function loadTables(): Promise<TableMeta[]> {
  const { tables } = await localApiRequest<{ tables: TableMeta[] }>('/api/tables');
  return tables;
}

export async function saveTable(table: TableMeta): Promise<void> {
  await localApiRequest('/api/tables', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(table),
  });
}

export async function getTable(id: string, signal?: AbortSignal): Promise<TableMeta | null> {
  try {
    return await localApiRequest<TableMeta>(`/api/tables/${encodeURIComponent(id)}`, { signal });
  } catch {
    return null;
  }
}

/** Read-modify-write server-side (server/src/tableData/db.ts's own
 * updateTableColumns) for the identical reason this always worked this
 * way client-side: a stale in-memory `columns`/`name` copy from one store
 * must never clobber a fresher write made through the other. */
export async function updateTableColumns(tableId: string, columns: TableMeta['columns']): Promise<void> {
  await localApiRequest(`/api/tables/${encodeURIComponent(tableId)}/columns`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ columns }),
  });
}

export async function updateTableName(tableId: string, name: string): Promise<void> {
  await localApiRequest(`/api/tables/${encodeURIComponent(tableId)}/name`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

/** The Workspace screen's per-table daily-backup toggle (Package icon) —
 * see server/src/tableData/db.ts's own doc comment on why this is explicit
 * per-table opt-in. Same "table mutation, goes through db/db.ts like
 * every other one" convention as updateTableName/updateTableColumns
 * above. */
export async function updateTableBackupFlag(tableId: string, enabled: boolean): Promise<void> {
  await localApiRequest(`/api/tables/${encodeURIComponent(tableId)}/backup-flag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

/** SheetTabs' right-click "Priskirti aplankui"/"Išimti iš aplanko" —
 * folderId null ungroups the table. */
export async function setTableFolder(tableId: string, folderId: string | null): Promise<void> {
  await localApiRequest(`/api/tables/${encodeURIComponent(tableId)}/folder`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId }),
  });
}

/** SheetTabs' drag-reorder — one bulk request for the whole batch, same
 * "never one request per item" reasoning as saveRows below. */
export async function reorderTablesDB(updates: { id: string; order: number }[]): Promise<void> {
  await localApiRequest('/api/tables/reorder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tables: updates }),
  });
}

export async function loadTableFolders(): Promise<TableFolder[]> {
  const { folders } = await localApiRequest<{ folders: TableFolder[] }>('/api/table-folders');
  return folders;
}

export async function createTableFolderDB(folder: TableFolder): Promise<void> {
  await localApiRequest('/api/table-folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(folder),
  });
}

export async function renameTableFolderDB(id: string, name: string): Promise<void> {
  await localApiRequest(`/api/table-folders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export async function deleteTableFolderDB(id: string): Promise<void> {
  await localApiRequest(`/api/table-folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function reorderTableFoldersDB(updates: { id: string; order: number }[]): Promise<void> {
  await localApiRequest('/api/table-folders/reorder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folders: updates }),
  });
}

export async function countRowsForTable(tableId: string): Promise<number> {
  const { count } = await localApiRequest<{ count: number }>(`/api/tables/${encodeURIComponent(tableId)}/rows/count`);
  return count;
}

export async function deleteTableDB(id: string): Promise<void> {
  await localApiRequest(`/api/tables/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function loadRowsForTable(tableId: string, signal?: AbortSignal): Promise<Row[]> {
  const { rows } = await localApiRequest<{ rows: Row[] }>(`/api/tables/${encodeURIComponent(tableId)}/rows`, { signal });
  return rows;
}

export async function saveRow(row: Row): Promise<void> {
  await localApiRequest(`/api/rows/${encodeURIComponent(row.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(row),
  });
}

/** One request for the whole batch — critical, not just tidy: a
 * drag-reorder or column sort rewrites `order` across *every* row in the
 * table (see useTableStore.ts's moveRows/insertRows/applySortOrder), so a
 * 14,000-row table doing this as one row per HTTP request would be
 * unusable. Matches server/src/tableData/db.ts's own saveRows(), which
 * wraps the whole batch in a single SQLite transaction. */
export async function saveRows(rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  await localApiRequest('/api/rows', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
}

/** Same shape/endpoint semantics as saveRows above, but a distinct server
 * route (POST /api/rows/import) specifically so a worker's can_export_import
 * permission can gate CSV import without also blocking every other bulk
 * write (paste, drag-reorder, sort) that goes through the general
 * saveRows/PUT /api/rows path. useTableStore.ts's importCsvRows calls
 * this instead of saveRows for each of its batches. */
export async function importRows(rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  await localApiRequest('/api/rows/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows }),
  });
}

export async function deleteRowDB(id: string): Promise<void> {
  await localApiRequest(`/api/rows/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function getTranscription(callId: string): Promise<TranscriptionRecord | null> {
  const db = await getDB();
  return (await db.get('transcriptions', callId)) ?? null;
}

export async function saveTranscription(record: TranscriptionRecord): Promise<void> {
  const db = await getDB();
  await db.put('transcriptions', record);
}

/** Every cached transcription/summary, unfiltered — used by the Comment
 * editor's "last summary" quick-tag to find the single most-recently-saved
 * one (by `savedAt`) without needing to know its `callId` up front. Same
 * bulk-read shape as getAllCallStats() below. */
export async function getAllTranscriptions(): Promise<TranscriptionRecord[]> {
  const db = await getDB();
  return db.getAll('transcriptions');
}

/** Bulk upsert, same pattern as saveRows() — one transaction, not one
 * put-and-await per record. Called after every successful Zadarma fetch
 * (both the manual "Load calls" list and the background history sync
 * below), so the local copy only ever grows/refreshes, never shrinks —
 * Zadarma's own statistics eventually age out, this is what survives that. */
export async function saveCallStats(records: CallStatRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('callStats', 'readwrite');
  await Promise.all(records.map((r) => tx.store.put(r)));
  await tx.done;
}

export async function getAllCallStats(): Promise<CallStatRecord[]> {
  const db = await getDB();
  return db.getAll('callStats');
}

/** The background sync's watermark: the most recent `callstart` already
 * saved locally, or null if nothing's been synced yet. Deriving this from
 * the data itself (rather than tracking a separate "last synced" key)
 * means a manual "Load calls" for some arbitrary past range also correctly
 * advances the watermark if it happens to be the most recent date seen,
 * with no extra bookkeeping to keep in sync. */
export async function getLatestCallStatDate(): Promise<string | null> {
  const all = await getAllCallStats();
  if (all.length === 0) return null;
  return all.reduce((max, r) => (r.callstart > max ? r.callstart : max), all[0].callstart);
}

/** One record per SMS send attempt, success or failure — see this file's
 * DB_VERSION 5 comment for why this exists at all (Zadarma's API has no
 * way to check afterward). Written right after the send call resolves,
 * from CellHoverEditor.tsx's handleSendSms. */
export async function saveSmsLogEntry(record: SmsLogRecord): Promise<void> {
  const db = await getDB();
  await db.put('smsLog', record);
}

export async function getAllSmsLog(): Promise<SmsLogRecord[]> {
  const db = await getDB();
  return db.getAll('smsLog');
}
