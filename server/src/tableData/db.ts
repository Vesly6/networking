import Database from 'better-sqlite3';
import Papa from 'papaparse';
import { randomUUID } from 'node:crypto';
import { dataFilePath } from '../dataDir.js';
import { listCompanies, getCompanySuperAdmin } from '../accounts/db.js';

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

    -- SheetTabs grouping buckets ("PL", "SE energy", ...) — purely an
    -- organizational label, no effect on table data. Created here (before
    -- the tables.folder_id ALTER TABLE below) so that column's REFERENCES
    -- clause resolves against a table that already exists, same ordering
    -- constraint accounts/db.ts's own news_folders/news_topics pair follows.
    CREATE TABLE IF NOT EXISTS table_folders (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL,
      order_num INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS table_folders_by_company ON table_folders(company_id);

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
  // Dual-identity attribution for impersonated writes (a company
  // super_admin acting as one of their own workers — see auth.ts's
  // AuthContext.actingAs). Both nullable and left NULL for every
  // pre-existing row and for every ordinary (non-impersonated) worker
  // action going forward — only populated when index.ts's
  // rowActionAttribution() resolves an active impersonation session.
  for (const column of ['real_user_id', 'real_user_name']) {
    try {
      database.exec(`ALTER TABLE worker_actions ADD COLUMN ${column} TEXT`);
    } catch {
      // Column already exists — nothing to do.
    }
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

  // Table drag-reorder + folders (SheetTabs). order_num is scoped by
  // company_id like everything else here; on a genuinely fresh install
  // this ALTER still runs (there's no separate "was this a fresh DB"
  // branch — see the file's other ALTERs for the same convention) and the
  // backfill below is a no-op since every table in that case is created
  // afterward with a real order already set by the client.
  try {
    database.exec(`ALTER TABLE tables ADD COLUMN order_num INTEGER NOT NULL DEFAULT 0`);
    // One-time backfill, only reachable the first time this ALTER succeeds
    // (a brand-new column, every existing row just defaulted to 0) — ranks
    // each company's existing tables by created_at so their current
    // relative order is preserved instead of all tying at 0. O(n²)
    // correlated subquery — fine at the dozens-of-tables-per-company scale
    // this operates at, and it only ever runs once per database.
    database.exec(`
      UPDATE tables SET order_num = (
        SELECT COUNT(*) FROM tables t2
        WHERE t2.company_id = tables.company_id
          AND (t2.created_at < tables.created_at OR (t2.created_at = tables.created_at AND t2.id < tables.id))
      )
    `);
  } catch {
    // Column already exists — nothing to do.
  }
  try {
    database.exec(`ALTER TABLE tables ADD COLUMN folder_id TEXT REFERENCES table_folders(id) ON DELETE SET NULL`);
  } catch {
    // Column already exists — nothing to do.
  }
  // Per-table ownership — see PATCH /api/tables/:id/owner and index.ts's
  // tableAccessibleToRequest/tableAccessContext for how this is enforced.
  // Nullable, no DEFAULT: unlike company_id's `DEFAULT ''` this doesn't
  // need a NOT NULL placeholder to satisfy SQLite's ALTER TABLE
  // restriction, since NULL is itself the legitimate "not yet backfilled"
  // transient state backfillTableOwners() (below) resolves on every boot.
  try {
    database.exec(`ALTER TABLE tables ADD COLUMN owner_user_id TEXT`);
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

/** Called once from index.ts's startup sequence, right after
 * backfillCompanyId (so every table already has a real, non-'' company_id
 * to look a super_admin up against). Assigns every pre-existing table
 * still carrying the owner_user_id ALTER TABLE's NULL default to its own
 * company's super_admin — under the new per-table-ownership model (see
 * PATCH /api/tables/:id/owner), a table with no explicit owner is treated
 * as private to that company's admin, never as shared with everyone, so
 * this is what makes a company's real pre-existing tables become that
 * admin's private tables instead of staying invisible to everyone
 * (NULL owner matches nobody's effectiveUser().id — see
 * tableAccessibleToRequest in index.ts). Safe on every boot: the WHERE
 * clause only ever touches owner_user_id IS NULL rows, so this is a no-op
 * once a company's tables are claimed — it also doubles as a self-healing
 * safety net if some future bug ever leaves a table's owner NULL again.
 * A company with no super_admin at all (unreachable today — see
 * getCompanySuperAdmin's own doc comment) is simply skipped, not crashed.
 *
 * Deliberate, confirmed, one-time behavior change on first deploy: a
 * company's existing workers (who currently see every one of the
 * company's tables) will see NONE of them until the admin explicitly
 * reassigns at least one via the new owner picker — see the plan this
 * feature shipped from for why this was accepted rather than avoided. */
export function backfillTableOwners(): void {
  const stmt = getDb().prepare(`UPDATE tables SET owner_user_id = ? WHERE company_id = ? AND owner_user_id IS NULL`);
  for (const company of listCompanies()) {
    const admin = getCompanySuperAdmin(company.id);
    if (admin) stmt.run(admin.id, company.id);
  }
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
  order: number;
  folderId?: string;
  /** Which user (a company's super_admin, or a specific worker) this
   * table is exclusively visible to — see index.ts's
   * tableAccessibleToRequest/tableAccessContext for the actual
   * enforcement, and backfillTableOwners' own doc comment for the
   * migration story. Undefined only ever transiently (mapped from a NULL
   * `owner_user_id` row, which backfillTableOwners resolves on every
   * boot) — never treated as "shared with everyone." */
  ownerUserId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Plain-data shape of "who is asking and are they exempt from the
 * per-table ownership filter" — built by index.ts's tableAccessContext()
 * from req.auth/effectiveUser(). This file has no Express/Request
 * dependency and shouldn't gain one just for this. */
export interface TableAccessContext {
  /** True only for a company's own super_admin in their own, real,
   * non-impersonating session — sees every table regardless of owner. */
  isRealAdmin: boolean;
  /** effectiveUser(req)'s id (the impersonated worker if a super_admin is
   * currently acting as one, else the real logged-in user) — ignored when
   * isRealAdmin is true. */
  ownerUserId: string;
}

interface TableRow {
  id: string;
  name: string;
  columns_json: string;
  daily_backup_enabled: number;
  order_num: number;
  folder_id: string | null;
  owner_user_id: string | null;
  created_at: number;
  updated_at: number;
}

function tableFromRow(r: TableRow): TableMeta {
  return {
    id: r.id,
    name: r.name,
    columns: JSON.parse(r.columns_json),
    dailyBackupEnabled: r.daily_backup_enabled === 1,
    order: r.order_num,
    folderId: r.folder_id ?? undefined,
    ownerUserId: r.owner_user_id ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** `access` omitted: every table in the company, unfiltered — the
 * behavior every internal call site (instantlyReplySync.ts's
 * findOrCreateTargetTable checking whether "Visi atsakymai" already
 * exists by name, this file's own order-backfill logic) needs to keep
 * exactly as it was before per-table ownership existed. Only index.ts's
 * GET /api/tables route and findTimedNextActionRows pass `access`. */
export function loadTables(companyId: string, access?: TableAccessContext): TableMeta[] {
  const rows = getDb()
    .prepare(`SELECT * FROM tables WHERE company_id = ? ORDER BY order_num ASC, created_at ASC`)
    .all(companyId) as TableRow[];
  const tables = rows.map(tableFromRow);
  if (!access || access.isRealAdmin) return tables;
  // A NULL/undefined owner never equals a real user's id, so an
  // unassigned table is automatically excluded here without a separate
  // branch — matches the "no owner == admin-only" rule exactly.
  return tables.filter((t) => t.ownerUserId === access.ownerUserId);
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
// order_num/folder_id/owner_user_id are only ever meaningful for the
// INSERT branch (a brand-new table) — the ON CONFLICT DO UPDATE clause
// deliberately leaves them out, same as it already leaves out created_at,
// so a re-save (the CSV-migration upsert path, restoreBackupAsNewTable)
// never clobbers a table's manual order/folder/owner with whatever stale
// value the caller happened to be holding — an existing table's owner can
// only ever change via the explicit setTableOwner() below.
export function saveTable(table: TableMeta, companyId: string): void {
  getDb()
    .prepare(
      `INSERT INTO tables (id, name, columns_json, order_num, folder_id, owner_user_id, company_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, columns_json = excluded.columns_json, updated_at = excluded.updated_at
       WHERE tables.company_id = excluded.company_id`,
    )
    .run(
      table.id,
      table.name,
      JSON.stringify(table.columns),
      table.order,
      table.folderId ?? null,
      table.ownerUserId ?? null,
      companyId,
      table.createdAt,
      table.updatedAt,
    );
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

/** SheetTabs' right-click "Priskirti aplankui"/"Išimti iš aplanko" —
 * folderId null ungroups the table. Same read-check-then-UPDATE shape as
 * updateTableName above. */
export function setTableFolder(tableId: string, folderId: string | null, companyId: string): void {
  const database = getDb();
  const existing = database.prepare(`SELECT id FROM tables WHERE id = ? AND company_id = ?`).get(tableId, companyId) as
    | { id: string }
    | undefined;
  if (!existing) return;
  database
    .prepare(`UPDATE tables SET folder_id = ?, updated_at = ? WHERE id = ? AND company_id = ?`)
    .run(folderId, Date.now(), tableId, companyId);
}

/** The one explicit way an existing table's owner ever changes after
 * creation — see index.ts's PATCH /api/tables/:id/owner. Same
 * read-check-then-UPDATE shape as setTableFolder above. */
export function setTableOwner(tableId: string, ownerUserId: string, companyId: string): void {
  const database = getDb();
  const existing = database.prepare(`SELECT id FROM tables WHERE id = ? AND company_id = ?`).get(tableId, companyId) as
    | { id: string }
    | undefined;
  if (!existing) return;
  database
    .prepare(`UPDATE tables SET owner_user_id = ?, updated_at = ? WHERE id = ? AND company_id = ?`)
    .run(ownerUserId, Date.now(), tableId, companyId);
}

/** SheetTabs' drag-reorder — one transaction for the whole batch, same
 * reasoning as saveRows below (a single request per drag, not one per
 * table). Each `order` here is already scoped to whichever sibling group
 * (ungrouped, or one specific folder) the client just reordered — this
 * function has no opinion about groups, it just writes whatever order
 * values it's given. */
export function reorderTables(updates: { id: string; order: number }[], companyId: string): void {
  if (updates.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(`UPDATE tables SET order_num = ?, updated_at = ? WHERE id = ? AND company_id = ?`);
  const now = Date.now();
  const tx = database.transaction((batch: { id: string; order: number }[]) => {
    for (const u of batch) stmt.run(u.order, now, u.id, companyId);
  });
  tx(updates);
}

// --- SheetTabs folders ------------------------------------------------------
// A plain organizational grouping for a client with many tables (country x
// sector combinations) — see types.ts's TableFolder doc comment. Modeled
// directly on accounts/db.ts's news_folders (same nullable
// ON DELETE SET NULL FK from tables.folder_id, same CRUD shape).

export interface TableFolder {
  id: string;
  name: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

interface TableFolderRow {
  id: string;
  name: string;
  order_num: number;
  created_at: number;
  updated_at: number;
}

function tableFolderFromRow(r: TableFolderRow): TableFolder {
  return { id: r.id, name: r.name, order: r.order_num, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listTableFolders(companyId: string): TableFolder[] {
  const rows = getDb()
    .prepare(`SELECT * FROM table_folders WHERE company_id = ? ORDER BY order_num ASC, created_at ASC`)
    .all(companyId) as TableFolderRow[];
  return rows.map(tableFolderFromRow);
}

/** Blind insert — the client generates the id (randomUUID(), same as every
 * other entity in this app) and the order (append-at-the-end), so there's
 * nothing to upsert/conflict-resolve here unlike saveTable. */
export function createTableFolder(folder: TableFolder, companyId: string): void {
  getDb()
    .prepare(
      `INSERT INTO table_folders (id, company_id, name, order_num, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(folder.id, companyId, folder.name, folder.order, folder.createdAt, folder.updatedAt);
}

export function renameTableFolder(id: string, name: string, companyId: string): void {
  getDb()
    .prepare(`UPDATE table_folders SET name = ?, updated_at = ? WHERE id = ? AND company_id = ?`)
    .run(name, Date.now(), id, companyId);
}

/** Tables inside this folder are ungrouped automatically via the FK's ON
 * DELETE SET NULL (see the folder_id ALTER TABLE above) — no manual
 * cleanup step needed here, same as news_folders. */
export function deleteTableFolder(id: string, companyId: string): void {
  getDb().prepare(`DELETE FROM table_folders WHERE id = ? AND company_id = ?`).run(id, companyId);
}

/** Same shape as reorderTables above, for the folder strip itself. */
export function reorderTableFolders(updates: { id: string; order: number }[], companyId: string): void {
  if (updates.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(`UPDATE table_folders SET order_num = ?, updated_at = ? WHERE id = ? AND company_id = ?`);
  const now = Date.now();
  const tx = database.transaction((batch: { id: string; order: number }[]) => {
    for (const u of batch) stmt.run(u.order, now, u.id, companyId);
  });
  tx(updates);
}
// ---------------------------------------------------------------------------

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
 * *changed*, not just what was sent. Also exported for index.ts's
 * DELETE /api/rows/:id, which has no tableId in its request at all and
 * needs to look the row's own table up first for the per-table ownership
 * check. */
export function getRowById(id: string, companyId: string): Row | null {
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

/** What saveRow/saveRows need to know about who's writing, split into two
 * independent halves that used to be conflated into one WorkerRowRestriction:
 * `restriction` gates sanitizeRowForWorker (null = full rights, no
 * sanitization — an ordinary owner/super_admin write, OR a company
 * super_admin impersonating one of their own workers, who gets full admin
 * rights by design even while acting as that worker); actingUserId/
 * actingUserName is who worker_actions attributes the change to regardless.
 * realUserId/realUserName are set only while impersonating — the REAL
 * super_admin behind the write — so an audit entry can show both "who it
 * looks like did this" and "who actually did it." */
export interface RowActionAttribution {
  restriction: WorkerRowRestriction | null;
  actingUserId: string;
  actingUserName: string;
  realUserId?: string;
  realUserName?: string;
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
  real_user_id: string | null;
  real_user_name: string | null;
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
  /** Set only when this action was performed by a company super_admin
   * impersonating the worker named above (userId/userName) — see auth.ts's
   * AuthContext.actingAs and index.ts's rowActionAttribution(). */
  realUserId?: string;
  realUserName?: string;
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
    realUserId: r.real_user_id ?? undefined,
    realUserName: r.real_user_name ?? undefined,
  };
}

function logWorkerActions(
  companyId: string,
  userId: string,
  userName: string,
  actions: WorkerActionRecord[],
  realUser?: { id: string; name: string },
): void {
  if (actions.length === 0) return;
  const stmt = getDb().prepare(
    `INSERT INTO worker_actions (id, company_id, user_id, user_name, action_type, table_id, table_name, row_id, column_id, column_name, contact_id, detail, created_at, real_user_id, real_user_name)
     VALUES (@id, @companyId, @userId, @userName, @actionType, @tableId, @tableName, @rowId, @columnId, @columnName, @contactId, @detail, @createdAt, @realUserId, @realUserName)`,
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
        realUserId: realUser?.id ?? null,
        realUserName: realUser?.name ?? null,
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
export function findTimedNextActionRows(companyId: string, access?: TableAccessContext): TimedReminderGroup[] {
  const database = getDb();
  const tables = loadTables(companyId, access);
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

/** Loads exactly the tables named in `tableIds` that also belong to
 * `companyId` — a foreign-company or made-up id is silently absent from
 * the result (mirrors getTable's own "missing id -> route maps to 404"
 * convention) rather than thrown on. The route handlers for PUT
 * /api/rows, POST /api/rows/import, and PUT /api/rows/:id call this (with
 * the distinct tableIds present in the incoming batch) before
 * saveRow(s)(), since those endpoints receive whole Row objects (each
 * carrying its own tableId) rather than a single :id param to check
 * against getTable() — and now also need each table's actual ownerUserId
 * to run through index.ts's tableAccessibleToRequest, not just a
 * count-based existence check (this replaces the old
 * allTablesBelongToCompany, which only returned a boolean). */
export function getTablesByIds(tableIds: string[], companyId: string): TableMeta[] {
  if (tableIds.length === 0) return [];
  const unique = [...new Set(tableIds)];
  const placeholders = unique.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT * FROM tables WHERE company_id = ? AND id IN (${placeholders})`)
    .all(companyId, ...unique) as TableRow[];
  return rows.map(tableFromRow);
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
 * `attribution`, when passed (only ever for a real worker's own write, or a
 * company super_admin impersonating one — an ordinary, non-impersonating
 * owner/super_admin write always passes undefined/null and skips this
 * entirely), runs the row through sanitizeRowForWorker first when
 * `attribution.restriction` is set (a real worker) — an extra SELECT +
 * SELECT of the table's columns, paid only on that path. An impersonating
 * super_admin's `attribution.restriction` is null (full admin rights, by
 * design), so the row is written exactly as sent, but the change is still
 * logged with dual attribution — see RowActionAttribution's own doc
 * comment. */
export function saveRow(row: Row, companyId: string, attribution?: RowActionAttribution | null): void {
  let toSave = row;
  if (attribution) {
    const existing = getRowById(row.id, companyId);
    const table = getTable(row.tableId, companyId);
    toSave = attribution.restriction
      ? sanitizeRowForWorker(existing, row, table?.columns ?? [], attribution.restriction)
      : row;
    const actions = detectWorkerActions(existing, toSave, table?.columns ?? [], row.tableId, table?.name ?? '');
    logWorkerActions(
      companyId,
      attribution.actingUserId,
      attribution.actingUserName,
      actions,
      attribution.realUserId ? { id: attribution.realUserId, name: attribution.realUserName ?? '' } : undefined,
    );
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
 * `attribution` — see saveRow's own doc comment; applied per-row before the
 * batch is written, with the target table's columns fetched once per
 * distinct tableId in the batch (not once per row) since a bulk save is
 * almost always all-one-table. */
export function saveRows(rows: Row[], companyId: string, attribution?: RowActionAttribution | null): void {
  if (rows.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(UPSERT_ROW_SQL);
  let toSave = rows;
  if (attribution) {
    const tablesById = new Map<string, { name: string; columns: unknown[] }>();
    const allActions: WorkerActionRecord[] = [];
    toSave = rows.map((row) => {
      if (!tablesById.has(row.tableId)) {
        const table = getTable(row.tableId, companyId);
        tablesById.set(row.tableId, { name: table?.name ?? '', columns: table?.columns ?? [] });
      }
      const { name: tableName, columns } = tablesById.get(row.tableId)!;
      const existing = getRowById(row.id, companyId);
      const sanitized = attribution.restriction
        ? sanitizeRowForWorker(existing, row, columns, attribution.restriction)
        : row;
      allActions.push(...detectWorkerActions(existing, sanitized, columns, row.tableId, tableName));
      return sanitized;
    });
    logWorkerActions(
      companyId,
      attribution.actingUserId,
      attribution.actingUserName,
      allActions,
      attribution.realUserId ? { id: attribution.realUserId, name: attribution.realUserName ?? '' } : undefined,
    );
  }
  const tx = database.transaction((batch: Row[]) => {
    for (const row of batch) stmt.run(rowToParams(row, companyId));
  });
  tx(toSave);
}

export function deleteRow(id: string, companyId: string): void {
  getDb().prepare(`DELETE FROM rows WHERE id = ? AND company_id = ?`).run(id, companyId);
}

/** Bulk counterpart to deleteRow — one SQLite transaction for the whole
 * batch, same "single round trip, not one request per row" reasoning as
 * saveRows() above. A real, reported bug: bulk-deleting many selected
 * rows used to call the frontend's one-row-at-a-time DELETE endpoint
 * once per row via Promise.all, so selecting a large chunk of a table
 * (confirmed with 10,000 rows) fired that many simultaneous HTTP
 * requests at once — exactly the same class of flood as the large-paste
 * bug this codebase already fixed for row creation, just on the delete
 * side instead. */
export function deleteRows(ids: string[], companyId: string): void {
  if (ids.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(`DELETE FROM rows WHERE id = ? AND company_id = ?`);
  const tx = database.transaction((batch: string[]) => {
    for (const id of batch) stmt.run(id, companyId);
  });
  tx(ids);
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
/** Returns how many backup rows were actually deleted, so callers know
 * whether it's worth following up with vacuumDatabase() below — deleting
 * rows alone frees space *inside* the SQLite file for future reuse, but
 * doesn't shrink the file's actual size on disk. */
export function purgeOldBackups(maxAgeDays: number): number {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  return getDb().prepare(`DELETE FROM backups WHERE created_at < ?`).run(cutoff).changes;
}

/** Rebuilds the database file to reclaim space freed by deleted rows — a
 * real, reported bug: purgeOldBackups() was already correctly deleting
 * old backup rows on schedule, but a plain SQLite DELETE never shrinks
 * the file on disk by itself (the freed pages just become internal free
 * space, reused by future writes) — confirmed live: the Render disk
 * usage metric stayed at ~800MB even right after deleting the backup
 * rows that were supposedly the whole problem. VACUUM rebuilds the file
 * into a compacted copy and swaps it in, which is what actually returns
 * the space to the OS/disk. Needs roughly as much free space as the
 * current file size to do this safely (a temporary second copy), so this
 * should only run when there's known headroom — callers decide when. */
export function vacuumDatabase(): void {
  getDb().exec('VACUUM');
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
/** `ownerUserId` — the same "one uniform table-creation rule" as every
 * other saveTable() call site (see index.ts's tableAccessibleToRequest's
 * own doc comment): omitted only from the platform-admin restore route,
 * which has no company-user context at all and falls back to that
 * company's own super_admin; the company-scoped restore route always
 * passes effectiveUser(req)?.id, so restoring while impersonating a
 * worker correctly lands the restored table as that worker's own. */
export function restoreBackupAsNewTable(id: string, companyId?: string, ownerUserId?: string): TableMeta | null {
  const backup = getBackupFull(id, companyId);
  if (!backup) return null;
  const targetCompanyId = companyId ?? backup.companyId;
  const owner = ownerUserId ?? getCompanySuperAdmin(targetCompanyId)?.id;
  const now = Date.now();
  const date = new Date(backup.createdAt).toISOString().slice(0, 10);
  // Appended at the end of the target company's ungrouped tables, same
  // "next available order" convention the client uses when creating a
  // table through the normal UI.
  const nextOrder = getDb()
    .prepare(`SELECT COALESCE(MAX(order_num), -1) + 1 AS nextOrder FROM tables WHERE company_id = ?`)
    .get(targetCompanyId) as { nextOrder: number };
  const newTable: TableMeta = {
    id: randomUUID(),
    name: `${backup.tableName} (kopija ${date})`,
    columns: backup.columns,
    dailyBackupEnabled: false,
    order: nextOrder.nextOrder,
    ownerUserId: owner,
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
