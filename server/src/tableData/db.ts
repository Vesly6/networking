import Database from 'better-sqlite3';
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
  createdAt: number;
  updatedAt: number;
}

interface TableRow {
  id: string;
  name: string;
  columns_json: string;
  created_at: number;
  updated_at: number;
}

function tableFromRow(r: TableRow): TableMeta {
  return {
    id: r.id,
    name: r.name,
    columns: JSON.parse(r.columns_json),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function loadTables(): TableMeta[] {
  const rows = getDb().prepare(`SELECT * FROM tables ORDER BY created_at ASC`).all() as TableRow[];
  return rows.map(tableFromRow);
}

export function getTable(id: string): TableMeta | null {
  const row = getDb().prepare(`SELECT * FROM tables WHERE id = ?`).get(id) as TableRow | undefined;
  return row ? tableFromRow(row) : null;
}

/** Blind upsert — matches db.ts's own `saveTable` on the client (a plain
 * `put`), used both for creating a brand-new table and for the one-time
 * migration's "write this whole table record over" step. */
export function saveTable(table: TableMeta): void {
  getDb()
    .prepare(
      `INSERT INTO tables (id, name, columns_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, columns_json = excluded.columns_json, updated_at = excluded.updated_at`,
    )
    .run(table.id, table.name, JSON.stringify(table.columns), table.createdAt, table.updatedAt);
}

/** Read-modify-write, matching the client's own `updateTableColumns` —
 * same reasoning: a caller only ever has a possibly-stale in-memory copy
 * of the OTHER fields (name), so this must not blindly overwrite them. */
export function updateTableColumns(tableId: string, columns: unknown[]): void {
  const database = getDb();
  const existing = database.prepare(`SELECT * FROM tables WHERE id = ?`).get(tableId) as TableRow | undefined;
  if (!existing) return;
  database
    .prepare(`UPDATE tables SET columns_json = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(columns), Date.now(), tableId);
}

export function updateTableName(tableId: string, name: string): void {
  const database = getDb();
  const existing = database.prepare(`SELECT id FROM tables WHERE id = ?`).get(tableId) as { id: string } | undefined;
  if (!existing) return;
  database.prepare(`UPDATE tables SET name = ?, updated_at = ? WHERE id = ?`).run(name, Date.now(), tableId);
}

/** Rows cascade via the FK (ON DELETE CASCADE) — no separate row-deletion
 * step needed here, unlike the client's own deleteTableDB, which has to
 * do that manually since IndexedDB has no foreign keys at all. */
export function deleteTable(id: string): void {
  getDb().prepare(`DELETE FROM tables WHERE id = ?`).run(id);
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

export function loadRowsForTable(tableId: string): Row[] {
  const rows = getDb().prepare(`SELECT * FROM rows WHERE table_id = ? ORDER BY order_num ASC`).all(tableId) as RowRow[];
  return rows.map(rowFromRow);
}

export function countRowsForTable(tableId: string): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM rows WHERE table_id = ?`).get(tableId) as { n: number };
  return row.n;
}

const UPSERT_ROW_SQL = `
  INSERT INTO rows (id, table_id, cells_json, colors_json, order_num, linked_contact_id, next_action_note, height, hidden, created_at, updated_at)
  VALUES (@id, @tableId, @cellsJson, @colorsJson, @order, @linkedContactId, @nextActionNote, @height, @hidden, @createdAt, @updatedAt)
  ON CONFLICT(id) DO UPDATE SET
    cells_json = excluded.cells_json,
    colors_json = excluded.colors_json,
    order_num = excluded.order_num,
    linked_contact_id = excluded.linked_contact_id,
    next_action_note = excluded.next_action_note,
    height = excluded.height,
    hidden = excluded.hidden,
    updated_at = excluded.updated_at
`;

function rowToParams(row: Row) {
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function saveRow(row: Row): void {
  getDb().prepare(UPSERT_ROW_SQL).run(rowToParams(row));
}

/** One transaction for the whole batch — critical for real usage, not
 * just style: useTableStore.ts's moveRows/insertRows/applySortOrder all
 * rewrite `order` across *every* row in a table on a single drag-reorder
 * or column-sort click, so a 14,000-row table doing that one row at a
 * time (whether as 14,000 separate SQL statements or, worse, 14,000
 * separate HTTP requests from the client) would be unusable. Matches the
 * client's own `saveRows` (one IndexedDB tx, Promise.all of puts) and the
 * `addLeads`/other bulk-insert precedent already in linkedin/db.ts. */
export function saveRows(rows: Row[]): void {
  if (rows.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(UPSERT_ROW_SQL);
  const tx = database.transaction((batch: Row[]) => {
    for (const row of batch) stmt.run(rowToParams(row));
  });
  tx(rows);
}

export function deleteRow(id: string): void {
  getDb().prepare(`DELETE FROM rows WHERE id = ?`).run(id);
}
