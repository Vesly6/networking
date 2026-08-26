import Database from 'better-sqlite3';
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
