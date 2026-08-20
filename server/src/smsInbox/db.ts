import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dataFilePath } from '../dataDir.js';

// Same reasoning as linkedin/db.ts: an incoming SMS webhook can land at any
// time, whether or not a browser tab is open — the durable copy has to live
// in the server process itself, not IndexedDB. Sits next to source
// (server/sms-inbox.sqlite) by default, gitignored, its own separate
// SQLite file rather than sharing linkedin.sqlite — this feature has
// nothing to do with LinkedIn, and each server-side feature in this app
// owns its own small persistence file rather than a shared multi-feature
// database. See dataDir.ts for why the actual directory is configurable.
const DB_PATH = dataFilePath('sms-inbox.sqlite');

let db: Database.Database | null = null;

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS incoming_sms (
      id TEXT PRIMARY KEY,
      event TEXT,
      from_number TEXT,
      to_number TEXT,
      message TEXT,
      raw_payload TEXT NOT NULL,
      signature TEXT,
      received_at INTEGER NOT NULL
    );
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

export interface IncomingSmsRecord {
  id: string;
  event: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  message: string | null;
  rawPayload: string;
  signature: string | null;
  receivedAt: number;
}

/** Insert-only — a webhook receipt is a fact, never edited afterward.
 * `rawPayload` is always saved in full (JSON-stringified form body)
 * regardless of whether from/to/message could be confidently guessed, since
 * Zadarma's exact SMS webhook field names aren't documented anywhere (see
 * server/src/index.ts's receiver route for why) — the raw copy is what
 * lets a future field-name fix be applied retroactively by re-reading it,
 * instead of the guess being baked in permanently at receipt time. */
export function insertIncomingSms(entry: Omit<IncomingSmsRecord, 'id' | 'receivedAt'>): void {
  getDb()
    .prepare(
      `INSERT INTO incoming_sms (id, event, from_number, to_number, message, raw_payload, signature, received_at)
       VALUES (@id, @event, @fromNumber, @toNumber, @message, @rawPayload, @signature, @receivedAt)`,
    )
    .run({ id: randomUUID(), receivedAt: Date.now(), ...entry });
}

interface IncomingSmsRow {
  id: string;
  event: string | null;
  from_number: string | null;
  to_number: string | null;
  message: string | null;
  raw_payload: string;
  signature: string | null;
  received_at: number;
}

export function listIncomingSms(limit = 200): IncomingSmsRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM incoming_sms ORDER BY received_at DESC LIMIT ?`)
    .all(limit) as IncomingSmsRow[];
  return rows.map((r) => ({
    id: r.id,
    event: r.event,
    fromNumber: r.from_number,
    toNumber: r.to_number,
    message: r.message,
    rawPayload: r.raw_payload,
    signature: r.signature,
    receivedAt: r.received_at,
  }));
}
