import { openDB, type IDBPDatabase, type DBSchema } from 'idb';
import type { Row, TableMeta } from '../types';
import type { TranscriptionRecord, SmsLogRecord } from '../utils/callsApi';
import type { CallStatRecord } from '../utils/callStats';

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

export async function loadTables(): Promise<TableMeta[]> {
  const db = await getDB();
  return db.getAll('tables');
}

export async function saveTable(table: TableMeta): Promise<void> {
  const db = await getDB();
  await db.put('tables', table);
}

export async function getTable(id: string): Promise<TableMeta | null> {
  const db = await getDB();
  return (await db.get('tables', id)) ?? null;
}

/** Read-modify-write so a stale in-memory `columns`/`name` copy from one
 * store never clobbers a fresher write made through the other store. */
export async function updateTableColumns(tableId: string, columns: TableMeta['columns']): Promise<void> {
  const db = await getDB();
  const existing = await db.get('tables', tableId);
  if (!existing) return;
  await db.put('tables', { ...existing, columns, updatedAt: Date.now() });
}

export async function updateTableName(tableId: string, name: string): Promise<void> {
  const db = await getDB();
  const existing = await db.get('tables', tableId);
  if (!existing) return;
  await db.put('tables', { ...existing, name, updatedAt: Date.now() });
}

export async function countRowsForTable(tableId: string): Promise<number> {
  const db = await getDB();
  return db.countFromIndex('rows', 'by-table', tableId);
}

export async function deleteTableDB(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['tables', 'rows'], 'readwrite');
  await tx.objectStore('tables').delete(id);
  const rowIds = await tx.objectStore('rows').index('by-table').getAllKeys(id);
  await Promise.all(rowIds.map((rowId) => tx.objectStore('rows').delete(rowId)));
  await tx.done;
}

export async function loadRowsForTable(tableId: string): Promise<Row[]> {
  const db = await getDB();
  return db.getAllFromIndex('rows', 'by-table', tableId);
}

export async function saveRow(row: Row): Promise<void> {
  const db = await getDB();
  await db.put('rows', row);
}

export async function saveRows(rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDB();
  const tx = db.transaction('rows', 'readwrite');
  await Promise.all(rows.map((row) => tx.store.put(row)));
  await tx.done;
}

export async function deleteRowDB(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('rows', id);
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
