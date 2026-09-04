import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dataFilePath } from '../dataDir.js';

/** Durable log of the three bulk operations that can mutate rows an
 * arbitrary user isn't looking at (Contacts/decision-makers merge, the
 * Instantly reply push, and the "mark as sent" bulk counter bump) — added
 * so a specific one of these can be found and reverted later without
 * touching data written by any other import, or by the plain manual edits
 * that inevitably happen to the same rows afterward. Deliberately does
 * NOT cover the ordinary CSV-import-into-a-new-table flow
 * (CsvImportMapping.tsx) — undoing that is just deleting the whole table
 * it created, already supported.
 *
 * The actual revert computation lives client-side (app/src/utils/
 * applyImportRollback.ts), reusing the same note/contact JSON-array
 * helpers (removeNoteEntry, parseContacts/serializeContacts) the writing
 * modals themselves already use, rather than re-implementing that
 * business logic a second time in this separate npm package. This file
 * is purely the durable log: what changed, and whether it's already been
 * rolled back. `changes_json` holds an array of self-describing,
 * independently-reversible ImportChangeEntry objects (see that type on
 * the client) — e.g. "row X's Contacts cell gained entries [a, b]", not a
 * snapshot of the whole cell's previous value, specifically so a later,
 * unrelated edit to the same cell (another import, or a plain manual
 * edit) is never silently clobbered by the revert. */
const DB_PATH = dataFilePath('import-history.sqlite');

let db: Database.Database | null = null;

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS import_operations (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      rolled_back_at INTEGER,
      changes_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS import_operations_by_company ON import_operations(company_id, created_at DESC);
  `);
}

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    migrate(db);
  }
  return db;
}

export type ImportOperationType = 'contacts_merge' | 'reply_push' | 'mark_sent';
export type ImportOperationStatus = 'active' | 'rolled_back';

export interface ImportOperationRecord {
  id: string;
  companyId: string;
  type: ImportOperationType;
  label: string;
  recordCount: number;
  status: ImportOperationStatus;
  createdAt: number;
  rolledBackAt: number | null;
  /** Opaque to the server — an array of ImportChangeEntry objects, typed
   * and interpreted only on the client (see this file's own doc comment
   * above). Stored as-is, JSON-stringified. */
  changes: unknown[];
}

interface ImportOperationRow {
  id: string;
  company_id: string;
  type: string;
  label: string;
  record_count: number;
  status: string;
  created_at: number;
  rolled_back_at: number | null;
  changes_json: string;
}

function fromRow(r: ImportOperationRow): ImportOperationRecord {
  return {
    id: r.id,
    companyId: r.company_id,
    type: r.type as ImportOperationType,
    label: r.label,
    recordCount: r.record_count,
    status: r.status as ImportOperationStatus,
    createdAt: r.created_at,
    rolledBackAt: r.rolled_back_at,
    changes: JSON.parse(r.changes_json) as unknown[],
  };
}

export function insertImportOperation(entry: {
  companyId: string;
  type: ImportOperationType;
  label: string;
  recordCount: number;
  changes: unknown[];
}): ImportOperationRecord {
  const id = randomUUID();
  const createdAt = Date.now();
  getDb()
    .prepare(
      `INSERT INTO import_operations (id, company_id, type, label, record_count, status, created_at, changes_json)
       VALUES (@id, @companyId, @type, @label, @recordCount, 'active', @createdAt, @changesJson)`,
    )
    .run({ id, createdAt, ...entry, changesJson: JSON.stringify(entry.changes) });
  return {
    id,
    companyId: entry.companyId,
    type: entry.type,
    label: entry.label,
    recordCount: entry.recordCount,
    status: 'active',
    createdAt,
    rolledBackAt: null,
    changes: entry.changes,
  };
}

export function listImportOperations(companyId: string, limit = 200): ImportOperationRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM import_operations WHERE company_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(companyId, limit) as ImportOperationRow[];
  return rows.map(fromRow);
}

export function getImportOperation(id: string, companyId: string): ImportOperationRecord | null {
  const row = getDb().prepare(`SELECT * FROM import_operations WHERE id = ? AND company_id = ?`).get(id, companyId) as
    | ImportOperationRow
    | undefined;
  return row ? fromRow(row) : null;
}

/** Called only after the client has already applied every revert write
 * successfully (see applyImportRollback.ts) — this just flips the status
 * so the record can't be rolled back a second time. Returns false (and
 * changes nothing) if the record is missing, belongs to another company,
 * or was already rolled back, so the route handler can 404/409
 * appropriately instead of silently double-marking it. */
export function markImportOperationRolledBack(id: string, companyId: string): boolean {
  const result = getDb()
    .prepare(
      `UPDATE import_operations SET status = 'rolled_back', rolled_back_at = ?
       WHERE id = ? AND company_id = ? AND status = 'active'`,
    )
    .run(Date.now(), id, companyId);
  return result.changes > 0;
}
