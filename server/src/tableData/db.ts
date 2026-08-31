import Database from 'better-sqlite3';
import Papa from 'papaparse';
import { randomUUID } from 'node:crypto';
import { dataFilePath } from '../dataDir.js';

// Same reasoning as linkedin/db.ts and smsInbox/db.ts: the whole point of
// this feature is that a table's data is the same regardless of which
// device/browser opens the app, so it can no longer live only in the
// browser's own IndexedDB (app/src/db/db.ts) — see CLAUDE.md's own section
// on this migration for the full "phone showed zero contacts" story. Its
// own file (server/table-data.sqlite, gitignored) by default, not shared
// with linkedin.sqlite/sms-inbox.sqlite — this codebase's established
// convention is one small SQLite file per server-side feature rather than
// a shared multi-feature database. See dataDir.ts for why the actual
// directory is configurable (this is the single most important file to
// actually survive a Render restart — it's the one holding the CRM data
// this whole migration exists for).
const DB_PATH = dataFilePath('table-data.sqlite');

let db: Database.Database | null = null;

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      columns_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rows (
      id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
      cells_json TEXT NOT NULL,
      colors_json TEXT,
      order_num INTEGER NOT NULL,
      linked_contact_id TEXT,
      next_action_note TEXT,
      height INTEGER,
      hidden INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rows_by_table ON rows(table_id);

    CREATE TABLE IF NOT EXISTS worker_actions (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_name TEXT NOT NULL,
      action_type TEXT NOT NULL,
      table_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      column_id TEXT,
      column_name TEXT,
      contact_id TEXT,
      detail TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS worker_actions_by_company ON worker_actions(company_id, created_at);
  `);
  // Additive migration for databases created before `hidden` existed —
  // CREATE TABLE IF NOT EXISTS above is a no-op against an already-
  // existing rows table (this is the durable copy of the user's real
  // ~14,000-row CRM, so it already exists in production), so a column
  // added after the fact needs this explicit ALTER TABLE. Guarded by
  // try/catch since it throws "duplicate column name" on a fresh install,
  // where the CREATE TABLE above already included the column.
  try {
    database.exec(`ALTER TABLE rows ADD COLUMN hidden INTEGER`);
  } catch {
    // Column already exists — nothing to do.
  }
  // Multi-tenant isolation (see accounts/db.ts) — added to both tables
  // AND rows (denormalized rather than joining through tables.company_id
  // on every row query) because a row's table never changes after
  // creation in this app, so keeping it in sync is a write-once concern,
  // and every row-level query/mutation gets a plain, fast `WHERE
  // company_id = ?` instead of a join. `DEFAULT ''` (not NULL — SQLite
  // allows adding a NOT NULL column only with a default) is a temporary
  // placeholder for pre-existing rows, immediately overwritten by
  // index.ts's startup call to backfillCompanyId() with the real owner
  // company id — never left as '' in practice.
  for (const table of ['tables', 'rows']) {
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN company_id TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists — nothing to do.
    }
  }
  database.exec(`CREATE INDEX IF NOT EXISTS tables_by_company ON tables(company_id)`);
  database.exec(`CREATE INDEX IF NOT EXISTS rows_by_company ON rows(company_id)`);

  // Explicit per-table opt-in for daily backups — NOT automatic for every
  // table, on explicit request: a company can have 30 tables and only
  // want 3 backed up, to keep storage/noise down (broader default
  // coverage is an intentional later step, not this pass).
  try {
    database.exec(`ALTER TABLE tables ADD COLUMN daily_backup_enabled INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — nothing to do.
  }

  database.exec(`
    -- One row per daily snapshot of one flagged table. Stores the SAME
    -- structural JSON the live table uses (columns_json/rows_json), not a
    -- flattened CSV string — restoring from a lossy CSV round-trip is
    -- exactly the type-guessing failure mode CLAUDE.md documents for
    -- regular CSV import (a note/contact column's JSON-array cell value
    -- reduces to unparseable garbage once it's been through a naive
    -- CSV round-trip). The CSV a super-admin actually downloads is
    -- rendered from this JSON on demand — see backupToCsvText below.
    CREATE TABLE IF NOT EXISTS backups (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      table_name TEXT NOT NULL,
      columns_json TEXT NOT NULL,
      rows_json TEXT NOT NULL,
      row_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS backups_by_company ON backups(company_id, created_at);
    CREATE INDEX IF NOT EXISTS backups_by_table ON backups(table_id, created_at);
  `);
}

/** Called once from index.ts's startup sequence, right after
 * accounts/db.ts's bootstrapOwnerIfNeeded() resolves the owner's company
 * id — assigns every pre-existing table/row (company_id still '' from the
 * ALTER TABLE default above) to that company, so the owner's real ~7,500
 * rows keep working exactly as before under the new multi-tenant model.
 * A no-op on every boot after the first (nothing left with company_id ''
 * once this has run once). */
export function backfillCompanyId(ownerCompanyId: string): void {
  const database = getDb();
  database.prepare(`UPDATE tables SET company_id = ? WHERE company_id = ''`).run(ownerCompanyId);
  database.prepare(`UPDATE rows SET company_id = ? WHERE company_id = ''`).run(ownerCompanyId);
}

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    // Makes `ON DELETE CASCADE` on rows.table_id actually take effect —
    // same explicit opt-in this codebase's other SQLite stores already
    // need (better-sqlite3 doesn't enforce FKs by default, unlike what
    // "REFERENCES ... ON DELETE CASCADE" alone might suggest).
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

// --- Column/Row shapes mirror app/src/types.ts exactly — this server has
// no independent opinion about what a "column" or "row" is, it's just
// where the client's own Column[]/cells/colors JSON blobs are durably
// stored. Kept as plain `unknown`-free `Record<string, unknown>`-shaped
// passthrough types rather than re-declaring Column here, so a future
// column-type addition on the client doesn't also need a server change. ---

export interface TableMeta {
  id: string;
  name: string;
  columns: unknown[]; // Column[] — opaque to this server, see note above
  dailyBackupEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface TableRow {
  id: string;
  name: string;
  columns_json: string;
  daily_backup_enabled: number;
  created_at: number;
  updated_at: number;
}

function tableFromRow(r: TableRow): TableMeta {
  return {
    id: r.id,
    name: r.name,
    columns: JSON.parse(r.columns_json),
    dailyBackupEnabled: r.daily_backup_enabled === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function loadTables(companyId: string): TableMeta[] {
  const rows = getDb().prepare(`SELECT * FROM tables WHERE company_id = ? ORDER BY created_at ASC`).all(companyId) as TableRow[];
  return rows.map(tableFromRow);
}

/** Scoped by companyId so a request for another company's table id
 * returns null (the route maps that to a plain 404) — the actual
 * isolation boundary every other table/row function below relies on. */
export function getTable(id: string, companyId: string): TableMeta | null {
  const row = getDb().prepare(`SELECT * FROM tables WHERE id = ? AND company_id = ?`).get(id, companyId) as TableRow | undefined;
  return row ? tableFromRow(row) : null;
}

/** Blind upsert — matches db.ts's own `saveTable` on the client (a plain
 * `put`), used both for creating a brand-new table and for the one-time
 * migration's "write this whole table record over" step. company_id is
 * only ever set from the caller's own req.auth (never client-supplied)
 * and, on conflict, the UPDATE only fires when the existing row already
 * belongs to that same company — this is what stops a crafted request
 * from overwriting another company's table even if it somehow guessed a
 * real id (astronomically unlikely given UUIDs, but free to guard). */
export function saveTable(table: TableMeta, companyId: string): void {
  getDb()
    .prepare(
      `INSERT INTO tables (id, name, columns_json, company_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, columns_json = excluded.columns_json, updated_at = excluded.updated_at
       WHERE tables.company_id = excluded.company_id`,
    )
    .run(table.id, table.name, JSON.stringify(table.columns), companyId, table.createdAt, table.updatedAt);
}

/** Read-modify-write, matching the client's own `updateTableColumns` —
 * same reasoning: a caller only ever has a possibly-stale in-memory copy
 * of the OTHER fields (name), so this must not blindly overwrite them. */
export function updateTableColumns(tableId: string, columns: unknown[], companyId: string): void {
  const database = getDb();
  const existing = database.prepare(`SELECT * FROM tables WHERE id = ? AND company_id = ?`).get(tableId, companyId) as
    | TableRow
    | undefined;
  if (!existing) return;
  database
    .prepare(`UPDATE tables SET columns_json = ?, updated_at = ? WHERE id = ? AND company_id = ?`)
    .run(JSON.stringify(columns), Date.now(), tableId, companyId);
}

export function updateTableName(tableId: string, name: string, companyId: string): void {
  const database = getDb();
  const existing = database.prepare(`SELECT id FROM tables WHERE id = ? AND company_id = ?`).get(tableId, companyId) as
    | { id: string }
    | undefined;
  if (!existing) return;
  database.prepare(`UPDATE tables SET name = ?, updated_at = ? WHERE id = ? AND company_id = ?`).run(name, Date.now(), tableId, companyId);
}

/** The Workspace screen's per-table "📦 daily backup" toggle (a company's
 * own super_admin — no owner gate needed here, unlike the Admin
 * dashboard's own backup oversight). Does NOT bump updated_at — this
 * isn't a content edit, and touching it shouldn't make an otherwise-
 * untouched table look recently modified. */
export function setTableBackupFlag(tableId: string, companyId: string, enabled: boolean): void {
  getDb()
    .prepare(`UPDATE tables SET daily_backup_enabled = ? WHERE id = ? AND company_id = ?`)
    .run(enabled ? 1 : 0, tableId, companyId);
}

/** Rows cascade via the FK (ON DELETE CASCADE) — no separate row-deletion
 * step needed here, unlike the client's own deleteTableDB, which has to
 * do that manually since IndexedDB has no foreign keys at all. */
export function deleteTable(id: string, companyId: string): void {
  getDb().prepare(`DELETE FROM tables WHERE id = ? AND company_id = ?`).run(id, companyId);
}

export interface Row {
  id: string;
  tableId: string;
  cells: Record<string, string>;
  colors?: Record<string, string>;
  order: number;
  linkedContactId?: string;
  nextActionNote?: string;
  height?: number;
  hidden?: boolean;
  createdAt: number;
  updatedAt: number;
}

interface RowRow {
  id: string;
  table_id: string;
  cells_json: string;
  colors_json: string | null;
  order_num: number;
  linked_contact_id: string | null;
  next_action_note: string | null;
  height: number | null;
  hidden: number | null;
  created_at: number;
  updated_at: number;
}

function rowFromRow(r: RowRow): Row {
  return {
    id: r.id,
    tableId: r.table_id,
    cells: JSON.parse(r.cells_json),
    colors: r.colors_json ? JSON.parse(r.colors_json) : undefined,
    order: r.order_num,
    linkedContactId: r.linked_contact_id ?? undefined,
    nextActionNote: r.next_action_note ?? undefined,
    height: r.height ?? undefined,
    hidden: r.hidden === 1 ? true : undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Scoped by companyId, same isolation rule as getTable — used by
 * sanitizeRowForWorker (below) to compare an incoming write against what's
 * actually stored, since a worker's write restrictions depend on what
 * *changed*, not just what was sent. */
function getRowById(id: string, companyId: string): Row | null {
  const row = getDb().prepare(`SELECT * FROM rows WHERE id = ? AND company_id = ?`).get(id, companyId) as RowRow | undefined;
  return row ? rowFromRow(row) : null;
}

// --- Worker cell-write restrictions ---------------------------------------
// The frontend already hides the UI paths that would attempt any of this
// (CellHoverEditor's edit/delete guards, DataCell staying single-click-to-
// edit but never overwriting a filled text/phone/company/link cell for a
// worker — see CLAUDE.md), but per the original multi-tenant plan this is
// the layer that actually matters for a worker sophisticated enough to hit
// the API directly, not just the app's own UI.

const APPEND_ONLY_COLUMN_TYPES = new Set(['text', 'phone', 'company', 'link']);

interface JsonEntry {
  id: string;
  text: string;
  [key: string]: unknown;
}

/** note/contact cells store a JSON array of entries (see
 * app/src/utils/noteHistory.ts / utils/contacts.ts) — returns null for a
 * legacy plain-text value (pre-dates that format) or anything else that
 * doesn't parse as one, since there's no entry-by-entry diff possible
 * against a value that was never structured that way. */
function tryParseEntries(raw: string): JsonEntry[] | null {
  if (raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((e) => e && typeof e === 'object' && typeof (e as JsonEntry).id === 'string')) {
      return parsed as JsonEntry[];
    }
  } catch {
    // Not JSON at all — legacy plain-text value.
  }
  return null;
}

/** A worker without the relevant edit/delete permission can still *add* a
 * new note/contact entry freely — only an existing entry's id has to
 * survive, with identical text, or this reverts just that one entry back
 * to its last-known-good state (the plan's own "reject the specific
 * violation, not the whole write" design, same principle as the append-
 * only cell check below). */
function sanitizeEntryList(oldRaw: string, newRaw: string, canEdit: boolean, canDelete: boolean): string {
  if (canEdit && canDelete) return newRaw;
  const oldEntries = tryParseEntries(oldRaw);
  const newEntries = tryParseEntries(newRaw);
  // Nothing to protect (no prior JSON-array value) or nothing parseable in
  // the incoming write (reject wholesale rather than guess at intent) —
  // both ends are the safe default in their own direction.
  if (oldEntries === null) return newRaw;
  if (newEntries === null) return oldRaw;

  const newById = new Map(newEntries.map((e) => [e.id, e]));
  const kept = oldEntries
    .filter((old) => newById.has(old.id) || !canDelete)
    .map((old) => {
      const incoming = newById.get(old.id);
      if (!incoming) return old; // a blocked deletion, restored as-is
      return !canEdit && incoming.text !== old.text ? old : incoming;
    });

  const oldIds = new Set(oldEntries.map((e) => e.id));
  // Brand-new entries (never gated) — prepended, matching how a real add
  // (addNoteEntry/addContact) always prepends, so the merged array still
  // reads newest-first.
  const added = newEntries.filter((e) => !oldIds.has(e.id));
  return JSON.stringify([...added, ...kept]);
}

/** Subset of UserPermissions (accounts/db.ts) this module actually needs,
 * plus the acting worker's own identity — kept as a local shape rather
 * than importing User/UserPermissions, so this file doesn't need an
 * opinion about the rest of the account model. userId/userName are what
 * let saveRow/saveRows below also write the activity-log entries this
 * whole restriction pass naturally already has all the data for (see
 * detectWorkerActions/logWorkerActions). */
export interface WorkerRowRestriction {
  userId: string;
  userName: string;
  canDeleteNotes: boolean;
  canEditContacts: boolean;
  canDeleteContacts: boolean;
  canHideRowsColumns: boolean;
}

/** Server-side backstop for what a worker can change on an *existing* row.
 * A brand-new row (existing === null) is never restricted — adding new
 * leads is the normal worker workflow regardless of any permission flag;
 * only *changing something that was already there* is ever in scope.
 * text/phone/company/link are append-only unconditionally (not gated by
 * any permission at all — see APPEND_ONLY_COLUMN_TYPES above), matching
 * the plan's "structural/content changes are for admins, workers append"
 * split; date/dropdown stay fully free (the calendar/status workflow the
 * plan explicitly keeps unrestricted). */
function sanitizeRowForWorker(existing: Row | null, incoming: Row, columns: unknown[], perms: WorkerRowRestriction): Row {
  if (!existing) return incoming;
  const columnList = columns as Array<{ id: string; type: string }>;
  const cells = { ...incoming.cells };
  for (const column of columnList) {
    const oldValue = existing.cells[column.id] ?? '';
    const newValue = cells[column.id] ?? '';
    if (APPEND_ONLY_COLUMN_TYPES.has(column.type)) {
      if (oldValue !== '' && newValue !== oldValue) cells[column.id] = oldValue;
    } else if (column.type === 'note') {
      cells[column.id] = sanitizeEntryList(oldValue, newValue, perms.canDeleteNotes, perms.canDeleteNotes);
    } else if (column.type === 'contact') {
      cells[column.id] = sanitizeEntryList(oldValue, newValue, perms.canEditContacts, perms.canDeleteContacts);
    }
    // Anything else (date/dropdown): unrestricted, left exactly as sent.
  }
  const hidden = !perms.canHideRowsColumns && incoming.hidden !== existing.hidden ? existing.hidden : incoming.hidden;
  return { ...incoming, cells, hidden };
}

// --- Worker activity log ---------------------------------------------------
// On explicit request: a super-admin wants to see what a worker actually
// did (not just have their mistakes silently reverted by the restrictions
// above) and jump straight to the row/contact in question. Detection runs
// against the *sanitized* row, not the raw incoming one — an attempted-but-
// blocked change never happened as far as the stored data is concerned, so
// it shouldn't show up in the log as if it did either.

export type WorkerActionType = 'row_created' | 'cell_edited' | 'note_added' | 'contact_added';

export interface WorkerActionRecord {
  actionType: WorkerActionType;
  tableId: string;
  tableName: string;
  rowId: string;
  columnId?: string;
  columnName?: string;
  contactId?: string;
  detail: string;
}

function truncateDetail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

/** Diffs `existing` (null for a brand-new row) against `sanitized` (the
 * row as it's actually about to be written, after sanitizeRowForWorker) to
 * produce a list of human-legible actions. A new row logs one row_created
 * entry, not a cell_edited per filled field (too noisy, and "a row was
 * added" already says what happened) — except note/contact entries, which
 * still get their own note_added/contact_added rows even on a brand-new
 * row, since those are what the "jump to that contact" button needs a
 * contactId for. */
function detectWorkerActions(
  existing: Row | null,
  sanitized: Row,
  columns: unknown[],
  tableId: string,
  tableName: string,
): WorkerActionRecord[] {
  const columnList = columns as Array<{ id: string; name: string; type: string }>;
  const actions: WorkerActionRecord[] = [];

  const detectEntryAdditions = (column: (typeof columnList)[number], oldRaw: string, newRaw: string) => {
    const oldEntries = tryParseEntries(oldRaw) ?? [];
    const newEntries = tryParseEntries(newRaw) ?? [];
    const oldIds = new Set(oldEntries.map((e) => e.id));
    for (const entry of newEntries) {
      if (oldIds.has(entry.id)) continue;
      actions.push({
        actionType: column.type === 'note' ? 'note_added' : 'contact_added',
        tableId,
        tableName,
        rowId: sanitized.id,
        columnId: column.id,
        columnName: column.name,
        contactId: entry.id,
        detail: truncateDetail(entry.text ?? ''),
      });
    }
  };

  if (!existing) {
    actions.push({ actionType: 'row_created', tableId, tableName, rowId: sanitized.id, detail: 'Nauja eilutė' });
    for (const column of columnList) {
      if (column.type !== 'note' && column.type !== 'contact') continue;
      detectEntryAdditions(column, '', sanitized.cells[column.id] ?? '');
    }
    return actions;
  }

  for (const column of columnList) {
    const oldValue = existing.cells[column.id] ?? '';
    const newValue = sanitized.cells[column.id] ?? '';
    if (column.type === 'note' || column.type === 'contact') {
      detectEntryAdditions(column, oldValue, newValue);
    } else if (oldValue !== newValue) {
      actions.push({
        actionType: 'cell_edited',
        tableId,
        tableName,
        rowId: sanitized.id,
        columnId: column.id,
        columnName: column.name,
        detail: `${column.name}: ${truncateDetail(newValue)}`,
      });
    }
  }
  return actions;
}

interface WorkerActionRow {
  id: string;
  company_id: string;
  user_id: string;
  user_name: string;
  action_type: string;
  table_id: string;
  table_name: string;
  row_id: string;
  column_id: string | null;
  column_name: string | null;
  contact_id: string | null;
  detail: string;
  created_at: number;
}

export interface WorkerActionLogEntry {
  id: string;
  userId: string;
  userName: string;
  actionType: WorkerActionType;
  tableId: string;
  tableName: string;
  rowId: string;
  columnId?: string;
  columnName?: string;
  contactId?: string;
  detail: string;
  createdAt: number;
}

function workerActionFromRow(r: WorkerActionRow): WorkerActionLogEntry {
  return {
    id: r.id,
    userId: r.user_id,
    userName: r.user_name,
    actionType: r.action_type as WorkerActionType,
    tableId: r.table_id,
    tableName: r.table_name,
    rowId: r.row_id,
    columnId: r.column_id ?? undefined,
    columnName: r.column_name ?? undefined,
    contactId: r.contact_id ?? undefined,
    detail: r.detail,
    createdAt: r.created_at,
  };
}

function logWorkerActions(companyId: string, userId: string, userName: string, actions: WorkerActionRecord[]): void {
  if (actions.length === 0) return;
  const stmt = getDb().prepare(
    `INSERT INTO worker_actions (id, company_id, user_id, user_name, action_type, table_id, table_name, row_id, column_id, column_name, contact_id, detail, created_at)
     VALUES (@id, @companyId, @userId, @userName, @actionType, @tableId, @tableName, @rowId, @columnId, @columnName, @contactId, @detail, @createdAt)`,
  );
  const now = Date.now();
  const tx = getDb().transaction((batch: WorkerActionRecord[]) => {
    for (const a of batch) {
      stmt.run({
        id: randomUUID(),
        companyId,
        userId,
        userName,
        actionType: a.actionType,
        tableId: a.tableId,
        tableName: a.tableName,
        rowId: a.rowId,
        columnId: a.columnId ?? null,
        columnName: a.columnName ?? null,
        contactId: a.contactId ?? null,
        detail: a.detail,
        createdAt: now,
      });
    }
  });
  tx(actions);
}

/** Newest-first, optionally scoped to one worker — used by the
 * "Darbuotojai" panel's activity-history section (super-admin/owner only,
 * see index.ts's GET /api/worker-actions). No pruning/rotation, matching
 * this codebase's existing insert-only audit log (linkedin/db.ts's own
 * actions_log) — an audit trail is expected to keep growing. */
export function listWorkerActions(companyId: string, userId: string | undefined, limit: number): WorkerActionLogEntry[] {
  const database = getDb();
  const rows = userId
    ? (database
        .prepare(`SELECT * FROM worker_actions WHERE company_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(companyId, userId, limit) as WorkerActionRow[])
    : (database
        .prepare(`SELECT * FROM worker_actions WHERE company_id = ? ORDER BY created_at DESC LIMIT ?`)
        .all(companyId, limit) as WorkerActionRow[]);
  return rows.map(workerActionFromRow);
}
// ---------------------------------------------------------------------------

export function loadRowsForTable(tableId: string, companyId: string): Row[] {
  const rows = getDb()
    .prepare(`SELECT * FROM rows WHERE table_id = ? AND company_id = ? ORDER BY order_num ASC`)
    .all(tableId, companyId) as RowRow[];
  return rows.map(rowFromRow);
}

export function countRowsForTable(tableId: string, companyId: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM rows WHERE table_id = ? AND company_id = ?`).get(tableId, companyId) as {
    n: number;
  };
  return row.n;
}

export interface TimedReminderGroup {
  tableId: string;
  tableName: string;
  columns: unknown[]; // Column[] — opaque here, same as TableMeta.columns; the
  // caller (index.ts) resolves a display label client-side.
  rows: { id: string; cells: Record<string, string> }[];
}

/** Powers the global "it's time to call" notification — on explicit
 * request, this has to work regardless of which table (if any) the user
 * currently has open, so it can't just read useTableStore's in-memory
 * rows the way the calendar/task-list views do; it has to go back to the
 * DB across every one of the company's tables. Scoped to exactly the
 * rows that could possibly matter (a next-action-date column value with
 * an opt-in time component — see types.ts/CLAUDE.md's "Optional time"
 * section, `yyyy-MM-ddTHH:mm` vs a bare `yyyy-MM-dd`) via a SQL-level
 * pre-filter (LENGTH(json_extract(...)) > 10, mirroring the client's own
 * hasTime() in utils/date.ts exactly) rather than loading and
 * JSON-parsing every row in every table — most rows never opt into a
 * time at all, so this keeps the common case cheap even against a
 * ~14,000-row table, which matters given this runs on a client polling
 * interval, not a one-off page load. Deliberately returns every match
 * with no "is it actually due yet" filtering here — that comparison has
 * to happen client-side, in the user's own browser-local timezone
 * (`yyyy-MM-ddTHH:mm` has no timezone suffix, and this server's own
 * clock — Render, normally UTC — has no reliable way to know what
 * timezone the user actually meant when they typed that time). */
export function findTimedNextActionRows(companyId: string): TimedReminderGroup[] {
  const database = getDb();
  const tables = loadTables(companyId);
  const groups: TimedReminderGroup[] = [];
  for (const table of tables) {
    const dateColumn = (table.columns as Array<{ id: string; type?: string; isNextActionDate?: boolean }>).find(
      (c) => c.type === 'date' && c.isNextActionDate,
    );
    if (!dateColumn) continue;
    const candidates = database
      .prepare(
        `SELECT id, cells_json FROM rows WHERE table_id = ? AND company_id = ? AND LENGTH(json_extract(cells_json, ?)) > 10`,
      )
      .all(table.id, companyId, `$."${dateColumn.id}"`) as Array<{ id: string; cells_json: string }>;
    if (candidates.length === 0) continue;
    groups.push({
      tableId: table.id,
      tableName: table.name,
      columns: table.columns,
      rows: candidates.map((r) => ({ id: r.id, cells: JSON.parse(r.cells_json) })),
    });
  }
  return groups;
}

/** True only if every id in `tableIds` is a table that belongs to
 * `companyId` — the route handler for PUT /api/rows calls this (with the
 * distinct tableIds present in the incoming batch) before saveRows(),
 * since that endpoint receives whole Row objects (each carrying its own
 * tableId) rather than a single :id param to check against getTable(). */
export function allTablesBelongToCompany(tableIds: string[], companyId: string): boolean {
  if (tableIds.length === 0) return true;
  const unique = [...new Set(tableIds)];
  const placeholders = unique.map(() => '?').join(',');
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM tables WHERE company_id = ? AND id IN (${placeholders})`)
    .get(companyId, ...unique) as { n: number };
  return row.n === unique.length;
}

const UPSERT_ROW_SQL = `
  INSERT INTO rows (id, table_id, cells_json, colors_json, order_num, linked_contact_id, next_action_note, height, hidden, company_id, created_at, updated_at)
  VALUES (@id, @tableId, @cellsJson, @colorsJson, @order, @linkedContactId, @nextActionNote, @height, @hidden, @companyId, @createdAt, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    cells_json = excluded.cells_json,
    colors_json = excluded.colors_json,
    order_num = excluded.order_num,
    linked_contact_id = excluded.linked_contact_id,
    next_action_note = excluded.next_action_note,
    height = excluded.height,
    hidden = excluded.hidden,
    updated_at = excluded.updated_at
  WHERE rows.company_id = excluded.company_id
`;

function rowToParams(row: Row, companyId: string) {
  return {
    id: row.id,
    tableId: row.tableId,
    cellsJson: JSON.stringify(row.cells),
    colorsJson: row.colors ? JSON.stringify(row.colors) : null,
    order: row.order,
    linkedContactId: row.linkedContactId ?? null,
    nextActionNote: row.nextActionNote ?? null,
    height: row.height ?? null,
    hidden: row.hidden ? 1 : null,
    companyId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** companyId always comes from the caller's own req.auth, never from the
 * row payload itself — the route handler is responsible for first
 * confirming row.tableId actually belongs to that company (via getTable)
 * before calling this, so a row can never land under a table it doesn't
 * really belong to. See rowToParams/UPSERT_ROW_SQL's own WHERE clause for
 * the second layer of this (an update only applies if the existing row
 * already belongs to the same company).
 *
 * `workerRestriction`, when passed (only ever for req.auth.role ===
 * 'worker' — owner/super_admin writes always pass undefined/null and skip
 * this entirely), runs the row through sanitizeRowForWorker first — an
 * extra SELECT + SELECT of the table's columns, paid only on the worker
 * path. */
export function saveRow(row: Row, companyId: string, workerRestriction?: WorkerRowRestriction | null): void {
  let toSave = row;
  if (workerRestriction) {
    const existing = getRowById(row.id, companyId);
    const table = getTable(row.tableId, companyId);
    toSave = sanitizeRowForWorker(existing, row, table?.columns ?? [], workerRestriction);
    const actions = detectWorkerActions(existing, toSave, table?.columns ?? [], row.tableId, table?.name ?? '');
    logWorkerActions(companyId, workerRestriction.userId, workerRestriction.userName, actions);
  }
  getDb().prepare(UPSERT_ROW_SQL).run(rowToParams(toSave, companyId));
}

/** One transaction for the whole batch — critical for real usage, not
 * just style: useTableStore.ts's moveRows/insertRows/applySortOrder all
 * rewrite `order` across *every* row in a table on a single drag-reorder
 * or column-sort click, so a 14,000-row table doing that one row at a
 * time (whether as 14,000 separate SQL statements or, worse, 14,000
 * separate HTTP requests from the client) would be unusable. Matches the
 * client's own `saveRows` (one IndexedDB tx, Promise.all of puts) and the
 * `addLeads`/other bulk-insert precedent already in linkedin/db.ts.
 *
 * `workerRestriction` — see saveRow's own doc comment; applied per-row
 * before the batch is written, with the target table's columns fetched
 * once per distinct tableId in the batch (not once per row) since a bulk
 * save is almost always all-one-table. */
export function saveRows(rows: Row[], companyId: string, workerRestriction?: WorkerRowRestriction | null): void {
  if (rows.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(UPSERT_ROW_SQL);
  let toSave = rows;
  if (workerRestriction) {
    const tablesById = new Map<string, { name: string; columns: unknown[] }>();
    const allActions: WorkerActionRecord[] = [];
    toSave = rows.map((row) => {
      if (!tablesById.has(row.tableId)) {
        const table = getTable(row.tableId, companyId);
        tablesById.set(row.tableId, { name: table?.name ?? '', columns: table?.columns ?? [] });
      }
      const { name: tableName, columns } = tablesById.get(row.tableId)!;
      const existing = getRowById(row.id, companyId);
      const sanitized = sanitizeRowForWorker(existing, row, columns, workerRestriction);
      allActions.push(...detectWorkerActions(existing, sanitized, columns, row.tableId, tableName));
      return sanitized;
    });
    logWorkerActions(companyId, workerRestriction.userId, workerRestriction.userName, allActions);
  }
  const tx = database.transaction((batch: Row[]) => {
    for (const row of batch) stmt.run(rowToParams(row, companyId));
  });
  tx(toSave);
}

export function deleteRow(id: string, companyId: string): void {
  getDb().prepare(`DELETE FROM rows WHERE id = ? AND company_id = ?`).run(id, companyId);
}

// --- Daily backups (super-admin's Package-icon toggle + the owner Admin
// dashboard's Duomenys panel) -------------------------------------------
// Snapshots the SAME structural JSON the live table already stores
// (columns + rows), not a flattened CSV — see the `backups` table's own
// schema comment above for why. Nothing here reads/writes `tables`/`rows`
// directly except createBackup (a plain snapshot-and-insert) and
// restoreBackupAsNewTable (a plain snapshot-and-insert in the other
// direction).

export interface BackupSummary {
  id: string;
  companyId: string;
  tableId: string;
  tableName: string;
  rowCount: number;
  createdAt: number;
}

interface BackupSummaryRow {
  id: string;
  company_id: string;
  table_id: string;
  table_name: string;
  row_count: number;
  created_at: number;
}

function backupSummaryFromRow(r: BackupSummaryRow): BackupSummary {
  return { id: r.id, companyId: r.company_id, tableId: r.table_id, tableName: r.table_name, rowCount: r.row_count, createdAt: r.created_at };
}

const BACKUP_SUMMARY_COLUMNS = `id, company_id, table_id, table_name, row_count, created_at`;

/** Every table currently flagged for daily backup, across every company
 * — the scheduler tick (index.ts) walks this list once per hour rather
 * than looping every table in the system and checking a flag per row.
 * Deliberately its own minimal shape, not TableMeta (which has no
 * companyId field at all — see its own doc comment on staying opaque/
 * company-agnostic elsewhere in this file) — the scheduler needs exactly
 * id+companyId to call createBackup, nothing else. */
export function listBackupFlaggedTables(): Array<{ id: string; companyId: string }> {
  const rows = getDb().prepare(`SELECT id, company_id FROM tables WHERE daily_backup_enabled = 1`).all() as Array<{
    id: string;
    company_id: string;
  }>;
  return rows.map((r) => ({ id: r.id, companyId: r.company_id }));
}

/** UTC date string (YYYY-MM-DD) of this table's most recent backup, or
 * null if it's never had one — the scheduler's "already ran today" check.
 * UTC, not local time, matching this codebase's own established
 * date-bucketing convention (see CLAUDE.md's addDays()/dayKeyUtc() notes)
 * — a server that's normally UTC anyway (Render) has no reliable way to
 * know any individual company's "local day" boundary. */
export function latestBackupDateUtc(tableId: string): string | null {
  const row = getDb().prepare(`SELECT created_at FROM backups WHERE table_id = ? ORDER BY created_at DESC LIMIT 1`).get(tableId) as
    | { created_at: number }
    | undefined;
  return row ? new Date(row.created_at).toISOString().slice(0, 10) : null;
}

/** Snapshots `tableId` right now. Called only for tables already
 * confirmed flagged (listBackupFlaggedTables) — no flag check here, so
 * this can also be reused later for an on-demand "back this up now"
 * button without re-deriving the flag state. */
export function createBackup(tableId: string, companyId: string): BackupSummary | null {
  const table = getTable(tableId, companyId);
  if (!table) return null;
  const rows = loadRowsForTable(tableId, companyId);
  const id = randomUUID();
  const createdAt = Date.now();
  getDb()
    .prepare(
      `INSERT INTO backups (id, company_id, table_id, table_name, columns_json, rows_json, row_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, companyId, table.id, table.name, JSON.stringify(table.columns), JSON.stringify(rows), rows.length, createdAt);
  return { id, companyId, tableId: table.id, tableName: table.name, rowCount: rows.length, createdAt };
}

export function listBackupsForCompany(companyId: string): BackupSummary[] {
  const rows = getDb()
    .prepare(`SELECT ${BACKUP_SUMMARY_COLUMNS} FROM backups WHERE company_id = ? ORDER BY created_at DESC`)
    .all(companyId) as BackupSummaryRow[];
  return rows.map(backupSummaryFromRow);
}

/** Owner-only (every company's backups, for oversight — see
 * /api/admin/backups). */
export function listAllBackups(): BackupSummary[] {
  const rows = getDb().prepare(`SELECT ${BACKUP_SUMMARY_COLUMNS} FROM backups ORDER BY created_at DESC`).all() as BackupSummaryRow[];
  return rows.map(backupSummaryFromRow);
}

/** `companyId` optional — omitted for the owner's cross-company Admin
 * dashboard (any backup, any company), required for the per-company
 * super_admin route so a request can't delete another company's backup
 * by guessing/copying an id. */
export function deleteBackup(id: string, companyId?: string): void {
  if (companyId) {
    getDb().prepare(`DELETE FROM backups WHERE id = ? AND company_id = ?`).run(id, companyId);
  } else {
    getDb().prepare(`DELETE FROM backups WHERE id = ?`).run(id);
  }
}

/** Called once per scheduler tick (index.ts) — deletes anything older
 * than `maxAgeDays`. Cheap enough to just run unconditionally every tick
 * rather than tracking a separate "last purged at" marker. */
export function purgeOldBackups(maxAgeDays: number): void {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  getDb().prepare(`DELETE FROM backups WHERE created_at < ?`).run(cutoff);
}

/** `companyId` optional — omitted for the owner's cross-company Admin
 * dashboard routes (download/restore), required for the per-company
 * super_admin routes so a request can't reach into another company's
 * backup by guessing/copying an id. */
function getBackupFull(id: string, companyId?: string) {
  const row = companyId
    ? (getDb().prepare(`SELECT * FROM backups WHERE id = ? AND company_id = ?`).get(id, companyId) as
        | (BackupSummaryRow & { columns_json: string; rows_json: string })
        | undefined)
    : (getDb().prepare(`SELECT * FROM backups WHERE id = ?`).get(id) as (BackupSummaryRow & { columns_json: string; rows_json: string }) | undefined);
  if (!row) return null;
  return { ...backupSummaryFromRow(row), columns: JSON.parse(row.columns_json) as Array<{ id: string; name: string }>, rows: JSON.parse(row.rows_json) as Row[] };
}

/** Renders a stored snapshot as CSV text on demand — same field/quoting
 * logic as app/src/utils/csv.ts's exportRowsToCsv (Papa.unparse), ported
 * server-side rather than hand-rolled, for the identical reason CLAUDE.md
 * already documents against a naive split/join CSV serializer (embedded
 * tabs/newlines/quotes in a cell need real RFC4180 quoting). */
export function backupToCsvText(id: string, companyId?: string): { filename: string; csv: string } | null {
  const backup = getBackupFull(id, companyId);
  if (!backup) return null;
  const fields = backup.columns.map((c) => c.name);
  const data = backup.rows.map((row) => backup.columns.map((c) => row.cells[c.id] ?? ''));
  const csv = Papa.unparse({ fields, data });
  const date = new Date(backup.createdAt).toISOString().slice(0, 10);
  return { filename: `${backup.tableName} (${date}).csv`, csv };
}

/** Creates a brand-new table from a stored snapshot — current data is
 * never touched (this IS the "History"/day-level-restore feature, per
 * the account owner's own explicit choice of a safe, non-destructive
 * restore over overwriting live data). Column ids are kept exactly as
 * they were in the snapshot (nothing else in this schema requires column
 * ids to be globally unique — they're only ever looked up scoped to
 * their own table's own columns_json), so only row ids need remapping;
 * cells/colors are keyed by column id, which doesn't change, so they
 * carry over unmodified.
 *
 * `companyId` optional — required for the per-company super_admin route
 * (same "can't reach into another company's backup" reasoning as
 * deleteBackup); omitted for the owner's cross-company Admin dashboard,
 * where the new table is created under the backup's OWN company (read
 * back from the backup record itself, via getBackupFull's unscoped
 * lookup) — never the owner's own company, which would silently move a
 * client's restored data into the owner's own workspace. */
export function restoreBackupAsNewTable(id: string, companyId?: string): TableMeta | null {
  const backup = getBackupFull(id, companyId);
  if (!backup) return null;
  const targetCompanyId = companyId ?? backup.companyId;
  const now = Date.now();
  const date = new Date(backup.createdAt).toISOString().slice(0, 10);
  const newTable: TableMeta = {
    id: randomUUID(),
    name: `${backup.tableName} (kopija ${date})`,
    columns: backup.columns,
    dailyBackupEnabled: false,
    createdAt: now,
    updatedAt: now,
  };
  saveTable(newTable, targetCompanyId);
  const remappedRows: Row[] = backup.rows.map((row) => ({
    ...row,
    id: randomUUID(),
    tableId: newTable.id,
    createdAt: now,
    updatedAt: now,
  }));
  saveRows(remappedRows, targetCompanyId);
  return newTable;
}
