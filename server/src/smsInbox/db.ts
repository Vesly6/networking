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
  // Multi-tenant isolation (see accounts/db.ts) — this table predates real
  // company accounts, so every company on the deployment shared one global
  // inbox until this retrofit (see index.ts's webhook receiver routes for
  // how a company gets attributed at write time: the new per-company
  // webhook URL segment, or the bootstrap company as a fallback for the
  // legacy company-less URL). Same "DEFAULT '', immediately overwritten by
  // the boot-time backfill" idiom as every other company_id retrofit in
  // this app — deliberately not added to the CREATE TABLE text above so a
  // fresh install and an existing one go through the identical code path.
  try {
    database.exec(`ALTER TABLE incoming_sms ADD COLUMN company_id TEXT NOT NULL DEFAULT ''`);
  } catch {
    // Column already exists — nothing to do.
  }
  database.exec(`CREATE INDEX IF NOT EXISTS incoming_sms_by_company ON incoming_sms(company_id)`);
}

/** Called once from index.ts's startup sequence, right alongside
 * linkedin/db.ts's own backfillLinkedInCompanyId — assigns every
 * pre-existing row (still company_id = '') to that company, so any SMS
 * already recorded before this retrofit keeps showing up for the one real
 * company that's actually been receiving them. A no-op on every boot
 * after the first. */
export function backfillSmsInboxCompanyId(companyId: string): void {
  getDb().prepare(`UPDATE incoming_sms SET company_id = ? WHERE company_id = ''`).run(companyId);
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
  companyId: string;
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
 * instead of the guess being baked in permanently at receipt time.
 * `companyId` is resolved by the caller (index.ts) from either the new
 * per-company webhook URL segment or, for the legacy company-less URL, the
 * bootstrap company as a fallback — see that route's own doc comment. */
export function insertIncomingSms(entry: Omit<IncomingSmsRecord, 'id' | 'receivedAt'>): void {
  getDb()
    .prepare(
      `INSERT INTO incoming_sms (id, company_id, event, from_number, to_number, message, raw_payload, signature, received_at)
       VALUES (@id, @companyId, @event, @fromNumber, @toNumber, @message, @rawPayload, @signature, @receivedAt)`,
    )
    .run({ id: randomUUID(), receivedAt: Date.now(), ...entry });
}

interface IncomingSmsRow {
  id: string;
  company_id: string;
  event: string | null;
  from_number: string | null;
  to_number: string | null;
  message: string | null;
  raw_payload: string;
  signature: string | null;
  received_at: number;
}

export function listIncomingSms(companyId: string, limit = 200): IncomingSmsRecord[] {
  const rows = getDb()
    .prepare(`SELECT * FROM incoming_sms WHERE company_id = ? ORDER BY received_at DESC LIMIT ?`)
    .all(companyId, limit) as IncomingSmsRow[];
  return rows.map((r) => ({
    id: r.id,
    companyId: r.company_id,
    event: r.event,
    fromNumber: r.from_number,
    toNumber: r.to_number,
    message: r.message,
    rawPayload: r.raw_payload,
    signature: r.signature,
    receivedAt: r.received_at,
  }));
}
