import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dataFilePath } from '../dataDir.js';
import type { LinkedinProfileType } from './contactParsing.js';

/** LinkedIn Planner — a manual task queue and status tracker, nothing
 * more. This module (and everything under server/src/linkedinPlanner/)
 * NEVER opens LinkedIn, never authenticates as a user, never stores a
 * LinkedIn credential/cookie/session, and never sends a connection
 * request or message on anyone's behalf. Every status here is set by a
 * human, by hand, after they did the actual sending themselves in their
 * own browser — see server/src/index.ts's LinkedIn Planner routes for
 * the enforcement of that (there is deliberately no route that could ever
 * trigger an outbound LinkedIn action). This is a completely separate,
 * fresh SQLite file/schema from the old (now flag-disabled)
 * server/src/linkedin/db.ts — no code or data is shared between them, by
 * design, since this is a new feature replacing a retired one, not a
 * rework of it. */
const DB_PATH = dataFilePath('linkedin-planner.sqlite');

let db: Database.Database | null = null;

function migrate(database: Database.Database): void {
  database.exec(`
    -- One row per unique real person (or company page), per company —
    -- the dedup key is (company_id, normalized_linkedin_url), never the
    -- occurrence: the same person found via three different tables'
    -- contact columns is still exactly one task.
    CREATE TABLE IF NOT EXISTS planner_tasks (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      normalized_linkedin_url TEXT NOT NULL,
      profile_type TEXT NOT NULL,
      primary_table_id TEXT NOT NULL,
      primary_row_id TEXT NOT NULL,
      primary_contact_id TEXT,
      status TEXT NOT NULL DEFAULT 'planned',
      assigned_worker_id TEXT,
      scheduled_date TEXT,
      note TEXT,
      not_confirmed_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(company_id, normalized_linkedin_url)
    );
    CREATE INDEX IF NOT EXISTS planner_tasks_by_company ON planner_tasks(company_id);
    CREATE INDEX IF NOT EXISTS planner_tasks_by_assigned ON planner_tasks(assigned_worker_id);
    CREATE INDEX IF NOT EXISTS planner_tasks_by_status ON planner_tasks(company_id, status);

    -- Every place a task's own person/company was actually found. Lets a
    -- task survive one source row/contact being deleted or edited by
    -- falling back to another still-active occurrence, and is the join
    -- table used to decide "can worker X see this task" (X can see it if
    -- ANY of its active occurrences' table_id is one X has access to).
    CREATE TABLE IF NOT EXISTS planner_task_occurrences (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES planner_tasks(id) ON DELETE CASCADE,
      table_id TEXT NOT NULL,
      row_id TEXT NOT NULL,
      contact_id TEXT,
      source_column_id TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS occurrences_by_task ON planner_task_occurrences(task_id);
    CREATE INDEX IF NOT EXISTS occurrences_by_table_row ON planner_task_occurrences(table_id, row_id);

    -- Append-only — every status change is worker-entered (the system
    -- can never know what actually happened on linkedin.com), so this is
    -- purely a historical record, same shape as the old feature's
    -- actions_log.
    CREATE TABLE IF NOT EXISTS planner_task_history (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      changed_by_user_id TEXT NOT NULL,
      changed_at INTEGER NOT NULL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS history_by_task ON planner_task_history(task_id, changed_at);

    CREATE TABLE IF NOT EXISTS planner_templates (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS templates_by_company ON planner_templates(company_id);

    -- A large write (CSV import, or the one-time historical backfill this
    -- feature needs on first deploy) enqueues here instead of being
    -- scanned inline, so a several-thousand-row write never blocks the
    -- request that made it — see sync.ts's own doc comment.
    CREATE TABLE IF NOT EXISTS planner_sync_queue (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      table_id TEXT NOT NULL,
      row_id TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sync_queue_order ON planner_sync_queue(enqueued_at);

    -- One-row-per-key scratch table — currently only holds the "has the
    -- one-time historical backfill already been queued" marker, so a
    -- server restart doesn't needlessly re-enqueue every row in the
    -- company every time it boots (enqueueing itself is harmless/
    -- idempotent, but pointless repeat work at real scale).
    CREATE TABLE IF NOT EXISTS planner_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    -- Sending a LinkedIn connect request is a per-WORKER action, not a
    -- one-time fact about the task — on explicit request: each worker has
    -- their own real LinkedIn account/network, so worker A having already
    -- sent this person a request doesn't mean worker B has (or should be
    -- silently prevented from also sending their own). One row = "this
    -- worker has an active, not-yet-reversed send to this task"; deleting
    -- it (the "Nepatvirtino" action, see removeTaskSend) reverses only
    -- THIS worker's own send, leaving every other worker's row untouched.
    -- A task's own Siuntimui/Išsiųsta bucketing (see buildStatusClause's
    -- sentFilter) is entirely per-viewer, derived from row existence here
    -- — not from planner_tasks.status, which no longer changes at all for
    -- the send/not-confirm flow (see index.ts's /send, /not-confirmed).
    CREATE TABLE IF NOT EXISTS planner_task_sends (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES planner_tasks(id) ON DELETE CASCADE,
      worker_id TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      UNIQUE(task_id, worker_id)
    );
    CREATE INDEX IF NOT EXISTS task_sends_by_task ON planner_task_sends(task_id);
    CREATE INDEX IF NOT EXISTS task_sends_by_worker ON planner_task_sends(worker_id);
  `);
  // Additive migration for databases created before "Nepatvirtino" existed
  // — CREATE TABLE IF NOT EXISTS above is a no-op against an already-
  // existing planner_tasks table, so this column needs an explicit ALTER
  // TABLE, guarded by try/catch since it throws "duplicate column name" on
  // a fresh install where CREATE TABLE above already included it. Same
  // pattern as accounts/db.ts's own additive-column migrations.
  try {
    database.exec(`ALTER TABLE planner_tasks ADD COLUMN not_confirmed_count INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — nothing to do.
  }
}

export function isBackfillDone(): boolean {
  const row = getDb().prepare(`SELECT value FROM planner_meta WHERE key = 'backfill_done'`).get() as { value: string } | undefined;
  return row?.value === 'true';
}

export function markBackfillDone(): void {
  getDb().prepare(`INSERT INTO planner_meta (key, value) VALUES ('backfill_done', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'`).run();
}

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

export type PlannerTaskStatus =
  | 'planned'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'no_response'
  | 'replied'
  | 'skipped'
  | 'withdrawn'
  | 'needs_review'
  | 'removed';

export interface PlannerTask {
  id: string;
  companyId: string;
  normalizedLinkedinUrl: string;
  profileType: LinkedinProfileType;
  primaryTableId: string;
  primaryRowId: string;
  primaryContactId: string | null;
  status: PlannerTaskStatus;
  assignedWorkerId: string | null;
  scheduledDate: string | null;
  note: string | null;
  /** How many times ANY worker's send to this exact task has bounced back
   * via the "Nepatvirtino" action — see removeTaskSend's own doc comment.
   * Shown as a small badge on the task row once >0, so a lead that's
   * already failed once doesn't silently look brand-new the second time
   * around. */
  notConfirmedCount: number;
  createdAt: number;
  updatedAt: number;
}

interface TaskRow {
  id: string;
  company_id: string;
  normalized_linkedin_url: string;
  profile_type: string;
  primary_table_id: string;
  primary_row_id: string;
  primary_contact_id: string | null;
  status: string;
  assigned_worker_id: string | null;
  scheduled_date: string | null;
  note: string | null;
  not_confirmed_count: number;
  created_at: number;
  updated_at: number;
}

function taskFromRow(r: TaskRow): PlannerTask {
  return {
    id: r.id,
    companyId: r.company_id,
    normalizedLinkedinUrl: r.normalized_linkedin_url,
    profileType: r.profile_type as LinkedinProfileType,
    primaryTableId: r.primary_table_id,
    primaryRowId: r.primary_row_id,
    primaryContactId: r.primary_contact_id,
    status: r.status as PlannerTaskStatus,
    assignedWorkerId: r.assigned_worker_id,
    scheduledDate: r.scheduled_date,
    note: r.note,
    notConfirmedCount: r.not_confirmed_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getTaskById(id: string, companyId: string): PlannerTask | null {
  const row = getDb().prepare(`SELECT * FROM planner_tasks WHERE id = ? AND company_id = ?`).get(id, companyId) as TaskRow | undefined;
  return row ? taskFromRow(row) : null;
}

export function getTaskByUrl(companyId: string, normalizedUrl: string): PlannerTask | null {
  const row = getDb()
    .prepare(`SELECT * FROM planner_tasks WHERE company_id = ? AND normalized_linkedin_url = ?`)
    .get(companyId, normalizedUrl) as TaskRow | undefined;
  return row ? taskFromRow(row) : null;
}

export interface NewOccurrence {
  tableId: string;
  rowId: string;
  contactId: string | null;
  columnId: string;
}

/** Finds this person's existing task by normalized URL, or creates one
 * (primary occurrence = this one) — then always records/updates the
 * occurrence for (tableId, rowId, contactId), reactivating it if it had
 * been marked inactive before (e.g. the contact re-added the link after
 * removing it). Returns the task id. */
export function upsertTaskAndOccurrence(
  companyId: string,
  normalizedUrl: string,
  profileType: LinkedinProfileType,
  occurrence: NewOccurrence,
  now: number,
): string {
  const database = getDb();
  const existingTask = getTaskByUrl(companyId, normalizedUrl);
  let taskId: string;
  if (existingTask) {
    taskId = existingTask.id;
  } else {
    taskId = randomUUID();
    // An 'unrecognized' link (linkedin.com-shaped but not a /in/ or
    // /company/ path) starts in needs_review, not the active queue — see
    // contactParsing.ts's classifyLinkedinUrl doc comment.
    const initialStatus = profileType === 'unrecognized' ? 'needs_review' : 'planned';
    database
      .prepare(
        `INSERT INTO planner_tasks
           (id, company_id, normalized_linkedin_url, profile_type, primary_table_id, primary_row_id, primary_contact_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(taskId, companyId, normalizedUrl, profileType, occurrence.tableId, occurrence.rowId, occurrence.contactId, initialStatus, now, now);
  }

  const existingOccurrence = database
    .prepare(`SELECT id FROM planner_task_occurrences WHERE task_id = ? AND table_id = ? AND row_id = ? AND contact_id IS ?`)
    .get(taskId, occurrence.tableId, occurrence.rowId, occurrence.contactId) as { id: string } | undefined;
  if (existingOccurrence) {
    database.prepare(`UPDATE planner_task_occurrences SET active = 1 WHERE id = ?`).run(existingOccurrence.id);
  } else {
    database
      .prepare(
        `INSERT INTO planner_task_occurrences (id, task_id, table_id, row_id, contact_id, source_column_id, first_seen_at, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(randomUUID(), taskId, occurrence.tableId, occurrence.rowId, occurrence.contactId, occurrence.columnId, now);
  }
  return taskId;
}

/** Lists every currently-active occurrence recorded for one specific
 * (tableId, rowId) — the "what does this row currently have on file"
 * side of sync.ts's reconciliation, compared each write against what the
 * row's live cells actually contain right now. */
/** Includes each occurrence's task's own normalized URL (a join, not
 * stored redundantly on the occurrence itself) — sync.ts's reconciliation
 * needs this to tell "this slot's link is unchanged" apart from "this
 * slot's link changed to point at a different person," which look
 * identical without it (same contactId/columnId, different URL). */
export function getActiveOccurrencesForRow(
  tableId: string,
  rowId: string,
): { id: string; taskId: string; contactId: string | null; columnId: string; normalizedUrl: string }[] {
  const rows = getDb()
    .prepare(
      `SELECT o.id, o.task_id, o.contact_id, o.source_column_id, t.normalized_linkedin_url
       FROM planner_task_occurrences o
       JOIN planner_tasks t ON t.id = o.task_id
       WHERE o.table_id = ? AND o.row_id = ? AND o.active = 1`,
    )
    .all(tableId, rowId) as { id: string; task_id: string; contact_id: string | null; source_column_id: string; normalized_linkedin_url: string }[];
  return rows.map((r) => ({ id: r.id, taskId: r.task_id, contactId: r.contact_id, columnId: r.source_column_id, normalizedUrl: r.normalized_linkedin_url }));
}

/** The link that produced this occurrence disappeared (row/contact
 * deleted, or the LinkedIn URL removed/changed) — deactivates it, and if
 * it was its task's primary source, promotes another still-active
 * occurrence of the same task if one exists; otherwise marks the task
 * itself `removed` (row kept for history, just filtered out of the live
 * queue — see getTasksForCompany's own status filtering). */
export interface TaskSendEntry {
  taskId: string;
  workerId: string;
  sentAt: number;
}

/** Records that THIS worker personally sent a connect request for this
 * task — idempotent (a repeat call just refreshes sentAt) since the UI
 * only ever offers the send action once per worker anyway (it disappears
 * the moment this worker has an active row here). Returns whether this
 * was a genuinely NEW send (vs. an idempotent repeat) — index.ts uses
 * this to only auto-log the "LinkedIn užklausa {name}" note once, not on
 * every retried call. */
export function recordTaskSend(taskId: string, companyId: string, workerId: string, now: number): boolean {
  const database = getDb();
  // ON CONFLICT ... DO UPDATE always reports one row changed regardless of
  // which branch fired, so "was this genuinely new" has to be checked by
  // existence *before* the upsert, not read off .changes afterward.
  const existing = database.prepare(`SELECT 1 FROM planner_task_sends WHERE task_id = ? AND worker_id = ?`).get(taskId, workerId);
  database
    .prepare(
      `INSERT INTO planner_task_sends (id, task_id, worker_id, sent_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(task_id, worker_id) DO UPDATE SET sent_at = excluded.sent_at`,
    )
    .run(randomUUID(), taskId, workerId, now);
  database.prepare(`UPDATE planner_tasks SET updated_at = ? WHERE id = ? AND company_id = ?`).run(now, taskId, companyId);
  if (!existing) {
    database
      .prepare(
        `INSERT INTO planner_task_history (id, task_id, company_id, from_status, to_status, changed_by_user_id, changed_at, note)
         VALUES (?, ?, ?, 'planned', 'sent', ?, ?, NULL)`,
      )
      .run(randomUUID(), taskId, companyId, workerId, now);
  }
  return !existing;
}

/** "Nepatvirtino" — reverses THIS worker's own send only; every other
 * worker's send for the same task is untouched (see the table's own doc
 * comment in migrate() for why this is per-worker, not per-task). Returns
 * false if this worker hadn't actually sent anything to undo. Also bumps
 * the task-wide not_confirmed_count — a tally of how many times ANY
 * worker's send to this specific person has bounced back, not scoped to
 * one worker, since it's really a fact about the lead ("this person keeps
 * not confirming"), not about whichever worker happened to try last. */
export function removeTaskSend(taskId: string, companyId: string, workerId: string, now: number): boolean {
  const database = getDb();
  const result = database.prepare(`DELETE FROM planner_task_sends WHERE task_id = ? AND worker_id = ?`).run(taskId, workerId);
  if (result.changes === 0) return false;
  database
    .prepare(`UPDATE planner_tasks SET not_confirmed_count = not_confirmed_count + 1, updated_at = ? WHERE id = ? AND company_id = ?`)
    .run(now, taskId, companyId);
  database
    .prepare(
      `INSERT INTO planner_task_history (id, task_id, company_id, from_status, to_status, changed_by_user_id, changed_at, note)
       VALUES (?, ?, ?, 'sent', 'planned', ?, ?, ?)`,
    )
    .run(randomUUID(), taskId, companyId, workerId, now, 'Nepatvirtino kvietimo');
  return true;
}

export function hasWorkerSent(taskId: string, workerId: string): boolean {
  return !!getDb().prepare(`SELECT 1 FROM planner_task_sends WHERE task_id = ? AND worker_id = ?`).get(taskId, workerId);
}

export function getSendersForTask(taskId: string): TaskSendEntry[] {
  const rows = getDb()
    .prepare(`SELECT task_id, worker_id, sent_at FROM planner_task_sends WHERE task_id = ? ORDER BY sent_at ASC`)
    .all(taskId) as { task_id: string; worker_id: string; sent_at: number }[];
  return rows.map((r) => ({ taskId: r.task_id, workerId: r.worker_id, sentAt: r.sent_at }));
}

/** Bulk version for the task LIST (LinkedInPlannerView) — avoids N+1
 * queries when rendering a page of tasks, same "resolve only what's on
 * this page" reasoning as resolveTaskDisplay's own doc comment. */
export function getSendersForTasks(taskIds: string[]): Map<string, TaskSendEntry[]> {
  const map = new Map<string, TaskSendEntry[]>();
  if (taskIds.length === 0) return map;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT task_id, worker_id, sent_at FROM planner_task_sends WHERE task_id IN (${placeholders}) ORDER BY sent_at ASC`)
    .all(...taskIds) as { task_id: string; worker_id: string; sent_at: number }[];
  for (const r of rows) {
    const list = map.get(r.task_id) ?? [];
    list.push({ taskId: r.task_id, workerId: r.worker_id, sentAt: r.sent_at });
    map.set(r.task_id, list);
  }
  return map;
}

export interface TaskNotConfirmedEntry {
  taskId: string;
  workerId: string;
  changedAt: number;
}

/** Every "Nepatvirtino" event for this task, in order — who, and when.
 * 'planned' only ever becomes a task's to_status via removeTaskSend (the
 * generic /status route explicitly refuses to set it directly, see
 * index.ts), so filtering on to_status alone is an unambiguous marker for
 * this exact event, no need to also match the note text. Bulk version for
 * the task LIST (LinkedInPlannerView's own hover tooltip on "Nepatvirtino
 * × N"), same "resolve only what's on this page" reasoning as
 * getSendersForTasks right above. */
export function getNotConfirmedForTask(taskId: string): TaskNotConfirmedEntry[] {
  const rows = getDb()
    .prepare(`SELECT task_id, changed_by_user_id, changed_at FROM planner_task_history WHERE task_id = ? AND to_status = 'planned' ORDER BY changed_at ASC`)
    .all(taskId) as { task_id: string; changed_by_user_id: string; changed_at: number }[];
  return rows.map((r) => ({ taskId: r.task_id, workerId: r.changed_by_user_id, changedAt: r.changed_at }));
}

export function getNotConfirmedForTasks(taskIds: string[]): Map<string, TaskNotConfirmedEntry[]> {
  const map = new Map<string, TaskNotConfirmedEntry[]>();
  if (taskIds.length === 0) return map;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT task_id, changed_by_user_id, changed_at FROM planner_task_history
       WHERE task_id IN (${placeholders}) AND to_status = 'planned' ORDER BY changed_at ASC`,
    )
    .all(...taskIds) as { task_id: string; changed_by_user_id: string; changed_at: number }[];
  for (const r of rows) {
    const list = map.get(r.task_id) ?? [];
    list.push({ taskId: r.task_id, workerId: r.changed_by_user_id, changedAt: r.changed_at });
    map.set(r.task_id, list);
  }
  return map;
}

export interface RowTaskInfo {
  contactId: string;
  taskId: string;
  notConfirmedCount: number;
  senders: TaskSendEntry[];
}

/** For the contact-card badge (CellHoverEditor.tsx) — every active
 * occurrence recorded against this exact row, with its task's full
 * sender list (who's personally sent, in send order) and bounce-back
 * tally, keyed by contact id. A `link`-column-sourced occurrence has
 * `contactId: null` and isn't matchable to any specific contact entry, so
 * it's naturally excluded here (nothing to badge). */
export function getTaskInfoForRow(tableId: string, rowId: string): RowTaskInfo[] {
  const occRows = getDb()
    .prepare(
      `SELECT o.contact_id, o.task_id, t.not_confirmed_count FROM planner_task_occurrences o
       JOIN planner_tasks t ON t.id = o.task_id
       WHERE o.table_id = ? AND o.row_id = ? AND o.active = 1 AND o.contact_id IS NOT NULL`,
    )
    .all(tableId, rowId) as { contact_id: string; task_id: string; not_confirmed_count: number }[];
  if (occRows.length === 0) return [];
  const sendersByTask = getSendersForTasks(occRows.map((r) => r.task_id));
  return occRows.map((r) => ({
    contactId: r.contact_id,
    taskId: r.task_id,
    notConfirmedCount: r.not_confirmed_count,
    senders: sendersByTask.get(r.task_id) ?? [],
  }));
}

/** A whole row was deleted — every occurrence it was the source of needs
 * to go through the same "deactivate, maybe fall back or remove" logic
 * deactivateOccurrence already does, one at a time (there's rarely more
 * than a couple per row, so no batching needed here). */
export function deactivateOccurrencesForRow(tableId: string, rowId: string, now: number): void {
  const occurrences = getActiveOccurrencesForRow(tableId, rowId);
  for (const occ of occurrences) deactivateOccurrence(occ.id, now);
}

export function deactivateOccurrence(occurrenceId: string, now: number): void {
  const database = getDb();
  const occ = database.prepare(`SELECT task_id, table_id, row_id, contact_id FROM planner_task_occurrences WHERE id = ?`).get(occurrenceId) as
    | { task_id: string; table_id: string; row_id: string; contact_id: string | null }
    | undefined;
  if (!occ) return;
  database.prepare(`UPDATE planner_task_occurrences SET active = 0 WHERE id = ?`).run(occurrenceId);

  const task = database.prepare(`SELECT primary_table_id, primary_row_id, primary_contact_id FROM planner_tasks WHERE id = ?`).get(occ.task_id) as
    | { primary_table_id: string; primary_row_id: string; primary_contact_id: string | null }
    | undefined;
  if (!task) return;
  const wasPrimary = task.primary_table_id === occ.table_id && task.primary_row_id === occ.row_id && task.primary_contact_id === occ.contact_id;
  if (!wasPrimary) return;

  const fallback = database
    .prepare(`SELECT table_id, row_id, contact_id FROM planner_task_occurrences WHERE task_id = ? AND active = 1 LIMIT 1`)
    .get(occ.task_id) as { table_id: string; row_id: string; contact_id: string | null } | undefined;
  if (fallback) {
    database
      .prepare(`UPDATE planner_tasks SET primary_table_id = ?, primary_row_id = ?, primary_contact_id = ?, updated_at = ? WHERE id = ?`)
      .run(fallback.table_id, fallback.row_id, fallback.contact_id, now, occ.task_id);
  } else {
    database.prepare(`UPDATE planner_tasks SET status = 'removed', updated_at = ? WHERE id = ?`).run(now, occ.task_id);
  }
}

/** Every table id at least one active occurrence of this task currently
 * points at — used both for worker-visibility filtering and for the
 * dedup badge ("also found in N other tables"). */
export function getOccurrenceTableIds(taskId: string): string[] {
  const rows = getDb().prepare(`SELECT DISTINCT table_id FROM planner_task_occurrences WHERE task_id = ? AND active = 1`).all(taskId) as {
    table_id: string;
  }[];
  return rows.map((r) => r.table_id);
}

/** Tasks visible to a given requester: every task (admin/view_all) or
 * only tasks with at least one active occurrence in `accessibleTableIds`
 * (an ordinary worker) — computed application-side against the caller's
 * own already-resolved accessible-table-id list (see
 * tableData/db.ts's loadTables), never a cross-database SQL join. */
export interface TaskListOptions {
  statusIn?: PlannerTaskStatus[];
  statusNotIn?: PlannerTaskStatus[];
  profileTypeIn?: LinkedinProfileType[];
  /** Siuntimui/Išsiųsta bucketing is per-VIEWER now (see planner_task_sends'
   * own doc comment) — 'unsent' means "viewerWorkerId has no active send
   * row here," 'sent' means the opposite. viewerWorkerId omitted (the
   * super_admin/view_all-only "Visi" filter option) widens this to ANY
   * worker at all: 'unsent' then means nobody has sent yet, 'sent' means
   * at least one worker has. */
  sentFilter?: 'sent' | 'unsent';
  viewerWorkerId?: string;
  limit: number;
  offset: number;
}

export interface TaskListResult {
  tasks: PlannerTask[];
  total: number;
}

// Status/profile-type filtering pushed into SQL (not applied after the
// fact in JS) is the whole point here — with real production scale
// already past 8,000 tasks in one company, resolving display data
// (2 DB reads per task — see display.ts) for every task on every list
// request, only to then throw most of them away in JS, would make this
// endpoint slower with every table this feature gets used on. Only the
// free-text search filter (name/company/title — not columns this table
// has) still needs to happen after display resolution; see index.ts's
// route for how that's kept bounded too.
function buildStatusClause(options: TaskListOptions, columnPrefix = ''): { clause: string; params: unknown[] } {
  const statusCol = `${columnPrefix}status`;
  const typeCol = `${columnPrefix}profile_type`;
  const parts: string[] = [];
  const params: unknown[] = [];
  if (options.statusIn?.length) {
    parts.push(`${statusCol} IN (${options.statusIn.map(() => '?').join(',')})`);
    params.push(...options.statusIn);
  }
  if (options.statusNotIn?.length) {
    parts.push(`${statusCol} NOT IN (${options.statusNotIn.map(() => '?').join(',')})`);
    params.push(...options.statusNotIn);
  }
  if (options.profileTypeIn?.length) {
    parts.push(`${typeCol} IN (${options.profileTypeIn.map(() => '?').join(',')})`);
    params.push(...options.profileTypeIn);
  }
  if (options.sentFilter) {
    const idCol = `${columnPrefix}id`;
    const exists = options.viewerWorkerId
      ? `EXISTS (SELECT 1 FROM planner_task_sends s WHERE s.task_id = ${idCol} AND s.worker_id = ?)`
      : `EXISTS (SELECT 1 FROM planner_task_sends s WHERE s.task_id = ${idCol})`;
    parts.push(options.sentFilter === 'sent' ? exists : `NOT ${exists}`);
    if (options.viewerWorkerId) params.push(options.viewerWorkerId);
  }
  return { clause: parts.length > 0 ? ` AND ${parts.join(' AND ')}` : '', params };
}

export function getTasksForCompany(companyId: string, accessibleTableIds: string[] | null, options: TaskListOptions): TaskListResult {
  const database = getDb();

  if (accessibleTableIds === null) {
    // Aliased as `t` (and buildStatusClause called with the SAME 't.'
    // prefix as the other branch below) specifically so the sentFilter's
    // correlated subquery — `... WHERE s.task_id = <idCol>` — can't
    // silently bind its unqualified `id` to planner_task_sends' OWN `id`
    // column instead of this outer table's, which is exactly what a bare
    // `id` (no prefix) did here before: SQLite resolves an unqualified
    // name to the innermost matching table first, and planner_task_sends
    // has its own `id` primary key, so the correlation silently broke,
    // making EXISTS(...) always false — a real, found bug where a
    // super_admin's (or any linkedin_planner.view_all holder's) own send
    // never moved a task from Siuntimui into Išsiųsta, but only when
    // viewing across every table at once (no tableId filter) — the other
    // branch below was never affected, since its `t.` prefix already
    // qualified `t.id` explicitly.
    const { clause, params } = buildStatusClause(options, 't.');
    const where = `t.company_id = ?${clause}`;
    const total = (database.prepare(`SELECT COUNT(*) AS n FROM planner_tasks t WHERE ${where}`).get(companyId, ...params) as { n: number }).n;
    const rows = database
      .prepare(`SELECT t.* FROM planner_tasks t WHERE ${where} ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`)
      .all(companyId, ...params, options.limit, options.offset) as TaskRow[];
    return { tasks: rows.map(taskFromRow), total };
  }

  if (accessibleTableIds.length === 0) return { tasks: [], total: 0 };
  const { clause, params } = buildStatusClause(options, 't.');
  const tablePlaceholders = accessibleTableIds.map(() => '?').join(',');
  const where = `t.company_id = ?${clause} AND o.table_id IN (${tablePlaceholders})`;
  const total = (
    database
      .prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM planner_tasks t JOIN planner_task_occurrences o ON o.task_id = t.id AND o.active = 1 WHERE ${where}`)
      .get(companyId, ...params, ...accessibleTableIds) as { n: number }
  ).n;
  const rows = database
    .prepare(
      `SELECT DISTINCT t.* FROM planner_tasks t
       JOIN planner_task_occurrences o ON o.task_id = t.id AND o.active = 1
       WHERE ${where}
       ORDER BY t.updated_at DESC LIMIT ? OFFSET ?`,
    )
    .all(companyId, ...params, ...accessibleTableIds, options.limit, options.offset) as TaskRow[];
  return { tasks: rows.map(taskFromRow), total };
}

export function claimTask(taskId: string, companyId: string, workerId: string, now: number): boolean {
  const result = getDb()
    .prepare(`UPDATE planner_tasks SET assigned_worker_id = ?, updated_at = ? WHERE id = ? AND company_id = ? AND assigned_worker_id IS NULL`)
    .run(workerId, now, taskId, companyId);
  return result.changes > 0;
}

export function reassignTask(taskId: string, companyId: string, workerId: string | null, now: number): void {
  getDb().prepare(`UPDATE planner_tasks SET assigned_worker_id = ?, updated_at = ? WHERE id = ? AND company_id = ?`).run(workerId, now, taskId, companyId);
}

export function setTaskSchedule(taskId: string, companyId: string, scheduledDate: string | null, now: number): void {
  getDb().prepare(`UPDATE planner_tasks SET scheduled_date = ?, updated_at = ? WHERE id = ? AND company_id = ?`).run(scheduledDate, now, taskId, companyId);
}

export function setTaskNote(taskId: string, companyId: string, note: string | null, now: number): void {
  getDb().prepare(`UPDATE planner_tasks SET note = ?, updated_at = ? WHERE id = ? AND company_id = ?`).run(note, now, taskId, companyId);
}

/** The only way a task's status ever changes — always paired with an
 * append-only history row naming who did it and when, since the system
 * itself never knows what actually happened on linkedin.com; a worker is
 * reporting a real-world fact, not triggering an action. */
export function changeTaskStatus(
  taskId: string,
  companyId: string,
  toStatus: PlannerTaskStatus,
  actorUserId: string,
  note: string | undefined,
  now: number,
): PlannerTask | null {
  const database = getDb();
  const existing = getTaskById(taskId, companyId);
  if (!existing) return null;
  database.prepare(`UPDATE planner_tasks SET status = ?, updated_at = ? WHERE id = ? AND company_id = ?`).run(toStatus, now, taskId, companyId);
  database
    .prepare(
      `INSERT INTO planner_task_history (id, task_id, company_id, from_status, to_status, changed_by_user_id, changed_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(randomUUID(), taskId, companyId, existing.status, toStatus, actorUserId, now, note ?? null);
  return getTaskById(taskId, companyId);
}

export interface PlannerTaskHistoryEntry {
  id: string;
  taskId: string;
  fromStatus: PlannerTaskStatus | null;
  toStatus: PlannerTaskStatus;
  changedByUserId: string;
  changedAt: number;
  note: string | null;
}

/** Counts how many tasks this worker has actually marked "sent" since
 * `sinceTs` — the daily-limit counter's real source of truth ("Šiandien:
 * N iš M" in the header). Deliberately only `to_status = 'sent'`, not
 * every history row: accepting/declining/etc. an already-sent task later
 * isn't a new outreach action and shouldn't count against today's send
 * limit a second time. `sinceTs` is computed by the caller from the
 * requester's own browser timezone (see index.ts's route) — this module
 * has no opinion about timezones at all, it just filters by timestamp. */
export function countSentSince(companyId: string, workerId: string, sinceTs: number): number {
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM planner_task_history WHERE company_id = ? AND changed_by_user_id = ? AND to_status = 'sent' AND changed_at >= ?`)
    .get(companyId, workerId, sinceTs) as { n: number };
  return row.n;
}

/** Team Activity Dashboard's "LinkedIn connections sent" metric — same
 * `to_status = 'sent'` filter as countSentSince above (a status change
 * back to 'sent', not any touch of the task), grouped by who sent it
 * within one bounded [since, until) window (a single calendar day, when
 * called from the dashboard's rollup job) rather than one query per
 * worker. */
export function countSentGroupedByWorker(companyId: string, range: { since: number; until: number }): { workerId: string; count: number }[] {
  const rows = getDb()
    .prepare(
      `SELECT changed_by_user_id AS worker_id, COUNT(*) AS n FROM planner_task_history
       WHERE company_id = ? AND to_status = 'sent' AND changed_at >= ? AND changed_at < ?
       GROUP BY changed_by_user_id`,
    )
    .all(companyId, range.since, range.until) as { worker_id: string; n: number }[];
  return rows.map((r) => ({ workerId: r.worker_id, count: r.n }));
}

export interface SentEventEntry {
  id: string;
  taskId: string;
  changedAt: number;
  note: string | null;
  linkedinUrl: string;
  tableId: string;
  rowId: string;
  columnId?: string;
  contactId?: string;
}

/** Team Activity Dashboard's "Atverti" drill-down for the LinkedIn metric —
 * one row per real 'sent' status change (same to_status = 'sent' filter as
 * countSentSince/countSentGroupedByWorker above), carrying enough to jump
 * straight to the lead's row: the task's own primary_table_id/row_id,
 * joined against its still-active primary occurrence (if any) for a
 * columnId/contactId pair so the jump can open the exact contact entry,
 * not just the row — same two-level jump (row vs. contact) that
 * tableData/db.ts's listWorkerActions already offers for notes/contacts.
 * Falls back to the task's own primary_contact_id (no columnId) when that
 * occurrence has since been deactivated — a plain row-level jump then,
 * which is still strictly more useful than nothing. */
export function listSentEventsForWorker(companyId: string, workerId: string, range: { since: number; until: number }, limit = 200): SentEventEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT h.id, h.task_id, h.changed_at, h.note,
              t.primary_table_id, t.primary_row_id, t.primary_contact_id, t.normalized_linkedin_url,
              o.source_column_id
       FROM planner_task_history h
       JOIN planner_tasks t ON t.id = h.task_id
       LEFT JOIN planner_task_occurrences o
         ON o.task_id = h.task_id AND o.table_id = t.primary_table_id AND o.row_id = t.primary_row_id AND o.active = 1
       WHERE h.company_id = ? AND h.changed_by_user_id = ? AND h.to_status = 'sent'
         AND h.changed_at >= ? AND h.changed_at < ?
       ORDER BY h.changed_at DESC
       LIMIT ?`,
    )
    .all(companyId, workerId, range.since, range.until, limit) as {
    id: string;
    task_id: string;
    changed_at: number;
    note: string | null;
    primary_table_id: string;
    primary_row_id: string;
    primary_contact_id: string | null;
    normalized_linkedin_url: string;
    source_column_id: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    changedAt: r.changed_at,
    note: r.note,
    linkedinUrl: r.normalized_linkedin_url,
    tableId: r.primary_table_id,
    rowId: r.primary_row_id,
    columnId: r.source_column_id ?? undefined,
    contactId: r.primary_contact_id ?? undefined,
  }));
}

export function getTaskHistory(taskId: string, companyId: string): PlannerTaskHistoryEntry[] {
  const rows = getDb()
    .prepare(`SELECT * FROM planner_task_history WHERE task_id = ? AND company_id = ? ORDER BY changed_at ASC`)
    .all(taskId, companyId) as {
    id: string;
    task_id: string;
    from_status: string | null;
    to_status: string;
    changed_by_user_id: string;
    changed_at: number;
    note: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    taskId: r.task_id,
    fromStatus: r.from_status as PlannerTaskStatus | null,
    toStatus: r.to_status as PlannerTaskStatus,
    changedByUserId: r.changed_by_user_id,
    changedAt: r.changed_at,
    note: r.note,
  }));
}

// --- Templates ---

export interface PlannerTemplate {
  id: string;
  companyId: string;
  name: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

function templateFromRow(r: {
  id: string;
  company_id: string;
  name: string;
  body: string;
  created_at: number;
  updated_at: number;
}): PlannerTemplate {
  return { id: r.id, companyId: r.company_id, name: r.name, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at };
}

export function listTemplates(companyId: string): PlannerTemplate[] {
  const rows = getDb().prepare(`SELECT * FROM planner_templates WHERE company_id = ? ORDER BY created_at ASC`).all(companyId) as Parameters<
    typeof templateFromRow
  >[0][];
  return rows.map(templateFromRow);
}

export function createTemplate(companyId: string, name: string, body: string, now: number): PlannerTemplate {
  const id = randomUUID();
  getDb()
    .prepare(`INSERT INTO planner_templates (id, company_id, name, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, companyId, name, body, now, now);
  return { id, companyId, name, body, createdAt: now, updatedAt: now };
}

export function updateTemplate(id: string, companyId: string, name: string, body: string, now: number): boolean {
  const result = getDb()
    .prepare(`UPDATE planner_templates SET name = ?, body = ?, updated_at = ? WHERE id = ? AND company_id = ?`)
    .run(name, body, now, id, companyId);
  return result.changes > 0;
}

export function deleteTemplate(id: string, companyId: string): void {
  getDb().prepare(`DELETE FROM planner_templates WHERE id = ? AND company_id = ?`).run(id, companyId);
}

// --- Sync queue (large-write deferral — see sync.ts) ---

export function enqueueRowsForSync(companyId: string, tableId: string, rowIds: string[], now: number): void {
  if (rowIds.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(`INSERT INTO planner_sync_queue (id, company_id, table_id, row_id, enqueued_at) VALUES (?, ?, ?, ?, ?)`);
  const tx = database.transaction((ids: string[]) => {
    for (const rowId of ids) stmt.run(randomUUID(), companyId, tableId, rowId, now);
  });
  tx(rowIds);
}

export function dequeueSyncBatch(limit: number): { id: string; companyId: string; tableId: string; rowId: string }[] {
  const rows = getDb().prepare(`SELECT * FROM planner_sync_queue ORDER BY enqueued_at ASC LIMIT ?`).all(limit) as {
    id: string;
    company_id: string;
    table_id: string;
    row_id: string;
  }[];
  return rows.map((r) => ({ id: r.id, companyId: r.company_id, tableId: r.table_id, rowId: r.row_id }));
}

export function removeSyncQueueEntries(ids: string[]): void {
  if (ids.length === 0) return;
  const database = getDb();
  const stmt = database.prepare(`DELETE FROM planner_sync_queue WHERE id = ?`);
  const tx = database.transaction((entryIds: string[]) => {
    for (const id of entryIds) stmt.run(id);
  });
  tx(ids);
}
