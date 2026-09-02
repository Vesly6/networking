import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dataFilePath } from '../dataDir.js';

/** Durable, timestamped record of every Instantly reply webhook this
 * server has ever received — added after a real, reported incident: the
 * webhook route (index.ts) only ever logged via console.log/console.error,
 * which isn't queryable after the fact and isn't watched in production, so
 * there was no way to answer "did event X even arrive, and if so what
 * happened to it" without having been staring at a live log stream at the
 * exact moment. Same reasoning/shape as smsInbox/db.ts's incoming_sms (an
 * event can land at any time regardless of whether anyone's watching, so
 * the durable copy has to be a real row, not a log line) — its own
 * dedicated file, gitignored, rather than sharing table-data.sqlite (this
 * is operational/diagnostic data about the sync pipeline itself, not CRM
 * data).
 *
 * One row per webhook POST, updated in place as it moves through the
 * pipeline (insert on receipt, then a few UPDATEs as later stages
 * complete) rather than one row per stage — a single row's fields *are*
 * the timeline the user asked for: receivedAt -> responseSentAt ->
 * processingStartedAt -> processingFinishedAt, plus whatever the sync
 * actually did (repliesFound/rowsCreated/tableId/tableName) or why it
 * didn't (outcome/errorMessage). */
const DB_PATH = dataFilePath('instantly-webhook-log.sqlite');

let db: Database.Database | null = null;

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      event_type TEXT,
      campaign_id TEXT,
      raw_body TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      response_status INTEGER,
      response_sent_at INTEGER,
      processing_started_at INTEGER,
      processing_finished_at INTEGER,
      outcome TEXT,
      error_message TEXT,
      replies_found INTEGER,
      rows_created INTEGER,
      skipped_duplicate INTEGER,
      table_id TEXT,
      table_name TEXT
    );
    CREATE INDEX IF NOT EXISTS webhook_events_by_company ON webhook_events(company_id, received_at DESC);
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

export interface WebhookEventRecord {
  id: string;
  companyId: string;
  eventType: string | null;
  campaignId: string | null;
  rawBody: string;
  receivedAt: number;
  responseStatus: number | null;
  responseSentAt: number | null;
  processingStartedAt: number | null;
  processingFinishedAt: number | null;
  /** 'ignored' (not a reply_received event, or no campaign_id) |
   * 'no_api_key' (company has no Instantly key configured) | 'coalesced'
   * (a sync for this company+campaign was already running; this event's
   * data will be picked up by that pass's rerun, not a dedicated one of
   * its own — see runInstantlyWebhookSync's rerunPending) | 'success' |
   * 'error'. Null while still in flight (received but not yet resolved),
   * which is itself useful — a row stuck at outcome=null well past its
   * receivedAt means processing never finished, whether from a crash, a
   * process restart, or an unhandled hang. */
  outcome: 'ignored' | 'no_api_key' | 'coalesced' | 'success' | 'error' | null;
  errorMessage: string | null;
  repliesFound: number | null;
  rowsCreated: number | null;
  skippedDuplicate: number | null;
  tableId: string | null;
  tableName: string | null;
}

interface WebhookEventRow {
  id: string;
  company_id: string;
  event_type: string | null;
  campaign_id: string | null;
  raw_body: string;
  received_at: number;
  response_status: number | null;
  response_sent_at: number | null;
  processing_started_at: number | null;
  processing_finished_at: number | null;
  outcome: string | null;
  error_message: string | null;
  replies_found: number | null;
  rows_created: number | null;
  skipped_duplicate: number | null;
  table_id: string | null;
  table_name: string | null;
}

function fromRow(r: WebhookEventRow): WebhookEventRecord {
  return {
    id: r.id,
    companyId: r.company_id,
    eventType: r.event_type,
    campaignId: r.campaign_id,
    rawBody: r.raw_body,
    receivedAt: r.received_at,
    responseStatus: r.response_status,
    responseSentAt: r.response_sent_at,
    processingStartedAt: r.processing_started_at,
    processingFinishedAt: r.processing_finished_at,
    outcome: r.outcome as WebhookEventRecord['outcome'],
    errorMessage: r.error_message,
    repliesFound: r.replies_found,
    rowsCreated: r.rows_created,
    skippedDuplicate: r.skipped_duplicate,
    tableId: r.table_id,
    tableName: r.table_name,
  };
}

/** Called the instant the POST handler starts, before anything else — so
 * even a request that crashes the process immediately afterward still
 * left a real row behind proving it arrived. Returns the new row's id,
 * threaded through the later update* calls below as the pipeline
 * progresses. */
export function insertWebhookEvent(entry: {
  companyId: string;
  eventType: string | null;
  campaignId: string | null;
  rawBody: string;
}): string {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO webhook_events (id, company_id, event_type, campaign_id, raw_body, received_at)
       VALUES (@id, @companyId, @eventType, @campaignId, @rawBody, @receivedAt)`,
    )
    .run({ id, receivedAt: Date.now(), ...entry });
  return id;
}

export function recordResponseSent(id: string, status: number): void {
  getDb()
    .prepare(`UPDATE webhook_events SET response_status = ?, response_sent_at = ? WHERE id = ?`)
    .run(status, Date.now(), id);
}

export function recordIgnored(id: string, outcome: 'ignored' | 'no_api_key'): void {
  getDb().prepare(`UPDATE webhook_events SET outcome = ?, processing_finished_at = ? WHERE id = ?`).run(outcome, Date.now(), id);
}

export function recordProcessingStarted(id: string): void {
  getDb().prepare(`UPDATE webhook_events SET processing_started_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function recordCoalesced(id: string): void {
  // A rerun triggered by coalescing doesn't get its own dedicated
  // processing window — its data is folded into whichever pass picks up
  // rerunPending, so there's no separate started/finished timestamp to
  // record here beyond marking why this particular event never ran on
  // its own.
  getDb().prepare(`UPDATE webhook_events SET outcome = 'coalesced', processing_finished_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function recordSuccess(
  id: string,
  result: { repliesFound: number; rowsCreated: number; skippedDuplicate: number; tableId: string; tableName: string },
): void {
  getDb()
    .prepare(
      `UPDATE webhook_events
       SET outcome = 'success', processing_finished_at = @finishedAt, replies_found = @repliesFound,
           rows_created = @rowsCreated, skipped_duplicate = @skippedDuplicate, table_id = @tableId, table_name = @tableName
       WHERE id = @id`,
    )
    .run({ id, finishedAt: Date.now(), ...result });
}

export function recordError(id: string, message: string): void {
  getDb()
    .prepare(`UPDATE webhook_events SET outcome = 'error', processing_finished_at = ?, error_message = ? WHERE id = ?`)
    .run(Date.now(), message, id);
}

export function listWebhookEvents(companyId: string, limit = 100): WebhookEventRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM webhook_events WHERE company_id = ? ORDER BY received_at DESC LIMIT ?`)
    .all(companyId, limit) as WebhookEventRow[];
  return rows.map(fromRow);
}

export function getWebhookEvent(id: string): WebhookEventRecord | null {
  const row = getDb().prepare(`SELECT * FROM webhook_events WHERE id = ?`).get(id) as WebhookEventRow | undefined;
  return row ? fromRow(row) : null;
}
