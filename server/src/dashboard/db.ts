import { dataFilePath } from '../dataDir.js';
import Database from 'better-sqlite3';

/** Team Activity Dashboard — a single unified pre-aggregation table for
 * every metric this feature shows, internal (notes/contacts/companies
 * added/LinkedIn connections sent) and external (calls, later Apollo/
 * Instantly) alike. One table, one "updated_at" concept, one freshness
 * label on the whole dashboard, rather than two different code paths for
 * "our own data" vs "synced from a provider." Own SQLite file, same
 * dataFilePath()/lazy-singleton/migrate() convention as every other
 * server-side store (linkedin-planner.sqlite, table-data.sqlite, etc.) —
 * gitignored, survives a Render restart/deploy via the attached disk. */
const DB_PATH = dataFilePath('dashboard-metrics.sqlite');

let db: Database.Database | null = null;

export type DashboardMetric = 'notes' | 'contacts' | 'companies_added' | 'linkedin_sent' | 'calls' | 'emails_sent' | 'email_replies';

/** Sources this app can sync into daily_metrics — kept as an open string
 * union (not restricted to a DB CHECK) since new external providers get
 * added in later phases without a migration. */
export type DashboardSyncSource = 'internal' | 'zadarma' | 'apollo' | 'instantly';

function migrate(database: Database.Database): void {
  database.exec(`
    -- One row per (company, worker-or-company-wide, metric, day). worker_id
    -- is NULL for a company-wide total row — used both as the "everyone
    -- summed" convenience row (so a summary card is one lookup, not a
    -- SUM(...) across every worker every time) and for metrics that have
    -- no per-worker split at all (email/credits, later phases).
    -- No UNIQUE(company_id, worker_id, metric, date) here — SQL's own NULL
    -- semantics mean a UNIQUE index never treats two NULLs as equal, so
    -- such a constraint silently fails to deduplicate the company-wide
    -- rows (worker_id IS NULL) it was meant to cover, and re-upserting one
    -- collides on the PRIMARY KEY (id) instead of routing through
    -- ON CONFLICT -- a real, live-caught bug. The id column already
    -- deterministically encodes all four fields (see metricRowId, using a
    -- '__company__' sentinel in place of NULL specifically to sidestep
    -- this), so it alone is both the uniqueness guarantee AND the ON
    -- CONFLICT target.
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      worker_id TEXT,
      metric TEXT NOT NULL,
      date TEXT NOT NULL,
      value INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS daily_metrics_by_company_range ON daily_metrics(company_id, metric, date);

    -- Freshness/error tracking per (company, source) — what "Обновлено N
    -- minučių atgal" reads, and what the later diagnostics screen's
    -- per-integration status column reads. One row per source actually
    -- attempted for that company, not pre-seeded for every possible source.
    CREATE TABLE IF NOT EXISTS dashboard_sync_state (
      company_id TEXT NOT NULL,
      source TEXT NOT NULL,
      last_synced_at INTEGER,
      last_error TEXT,
      PRIMARY KEY (company_id, source)
    );

    -- The account owner's own explicit request: a way to see "how this
    -- actually looks from the real side" — the exact request params and
    -- raw response body a sync call got back from an external provider,
    -- so a computed dashboard number can be cross-checked against the
    -- provider's own real dashboard for the same range. One row per
    -- (company, source), overwritten on every sync — this is a snapshot
    -- of "the last real call and what it returned," not a growing log.
    CREATE TABLE IF NOT EXISTS dashboard_sync_log (
      company_id TEXT NOT NULL,
      source TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      request_params TEXT NOT NULL,
      raw_response TEXT NOT NULL,
      PRIMARY KEY (company_id, source)
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

interface DailyMetricRow {
  id: string;
  company_id: string;
  worker_id: string | null;
  metric: string;
  date: string;
  value: number;
  updated_at: number;
}

export interface DailyMetricEntry {
  workerId: string | null;
  metric: DashboardMetric;
  date: string;
  value: number;
  updatedAt: number;
}

function metricRowId(companyId: string, workerId: string | null, metric: string, date: string): string {
  return `${companyId}:${workerId ?? '__company__'}:${metric}:${date}`;
}

/** Replaces (never increments) the value for one (company, worker, metric,
 * day) bucket — every caller (the internal-metrics rollup, the live-today
 * path, the external sync jobs) always computes a fresh, complete count
 * for the bucket it's writing, so upsert-by-replace is correct; there's no
 * scenario where two independent partial writes to the same bucket need to
 * be summed together. `workerId: null` writes the company-wide row. */
export function upsertDailyMetric(companyId: string, workerId: string | null, metric: DashboardMetric, date: string, value: number): void {
  getDb()
    .prepare(
      `INSERT INTO daily_metrics (id, company_id, worker_id, metric, date, value, updated_at)
       VALUES (@id, @companyId, @workerId, @metric, @date, @value, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run({
      id: metricRowId(companyId, workerId, metric, date),
      companyId,
      workerId,
      metric,
      date,
      value,
      updatedAt: Date.now(),
    });
}

/** Bulk write for one rollup pass (e.g. one company's one day, every
 * metric/worker at once) — a single transaction rather than N separate
 * statements, same "batch writes into one tx" convention this codebase
 * already uses everywhere a rollup/sync writes more than one row. */
export function upsertDailyMetrics(entries: { companyId: string; workerId: string | null; metric: DashboardMetric; date: string; value: number }[]): void {
  if (entries.length === 0) return;
  const tx = getDb().transaction((batch: typeof entries) => {
    for (const e of batch) upsertDailyMetric(e.companyId, e.workerId, e.metric, e.date, e.value);
  });
  tx(entries);
}

/** Reads a range of already-finalized days for a company — the dashboard's
 * only read path for anything but today (see aggregate.ts's live-today
 * helper for that). `workerId` narrows to one worker's own rows (still
 * matches company-wide rows too, since those carry `worker_id: null` and
 * are only ever fetched by an explicit separate call, never mixed into a
 * per-worker query by accident here). */
export function getMetricsForRange(
  companyId: string,
  opts: { workerId?: string | null; metrics?: DashboardMetric[]; from: string; to: string },
): DailyMetricEntry[] {
  const clauses = ['company_id = ?', 'date >= ?', 'date <= ?'];
  const params: (string | number)[] = [companyId, opts.from, opts.to];
  if (opts.workerId !== undefined) {
    if (opts.workerId === null) {
      clauses.push('worker_id IS NULL');
    } else {
      clauses.push('worker_id = ?');
      params.push(opts.workerId);
    }
  }
  if (opts.metrics && opts.metrics.length > 0) {
    clauses.push(`metric IN (${opts.metrics.map(() => '?').join(', ')})`);
    params.push(...opts.metrics);
  }
  const rows = getDb()
    .prepare(`SELECT * FROM daily_metrics WHERE ${clauses.join(' AND ')}`)
    .all(...params) as DailyMetricRow[];
  return rows.map((r) => ({
    workerId: r.worker_id,
    metric: r.metric as DashboardMetric,
    date: r.date,
    value: r.value,
    updatedAt: r.updated_at,
  }));
}

export interface DashboardSyncStateEntry {
  companyId: string;
  source: DashboardSyncSource;
  lastSyncedAt: number | null;
  lastError: string | null;
}

export function getSyncState(companyId: string, source: DashboardSyncSource): DashboardSyncStateEntry | null {
  const row = getDb()
    .prepare(`SELECT * FROM dashboard_sync_state WHERE company_id = ? AND source = ?`)
    .get(companyId, source) as { company_id: string; source: string; last_synced_at: number | null; last_error: string | null } | undefined;
  if (!row) return null;
  return { companyId: row.company_id, source: row.source as DashboardSyncSource, lastSyncedAt: row.last_synced_at, lastError: row.last_error };
}

/** Every source this company has EVER synced (used to compute the single
 * "Обновлено N minučių atgal" freshness label as the OLDEST of all of
 * them, not just one) — small, at most a handful of rows per company. */
export function listSyncStates(companyId: string): DashboardSyncStateEntry[] {
  const rows = getDb().prepare(`SELECT * FROM dashboard_sync_state WHERE company_id = ?`).all(companyId) as {
    company_id: string;
    source: string;
    last_synced_at: number | null;
    last_error: string | null;
  }[];
  return rows.map((r) => ({ companyId: r.company_id, source: r.source as DashboardSyncSource, lastSyncedAt: r.last_synced_at, lastError: r.last_error }));
}

export function setSyncState(companyId: string, source: DashboardSyncSource, result: { ok: true } | { ok: false; error: string }): void {
  getDb()
    .prepare(
      `INSERT INTO dashboard_sync_state (company_id, source, last_synced_at, last_error)
       VALUES (@companyId, @source, @lastSyncedAt, @lastError)
       ON CONFLICT(company_id, source) DO UPDATE SET last_synced_at = excluded.last_synced_at, last_error = excluded.last_error`,
    )
    .run({
      companyId,
      source,
      lastSyncedAt: result.ok ? Date.now() : (getSyncState(companyId, source)?.lastSyncedAt ?? null),
      lastError: result.ok ? null : result.error,
    });
}

export interface DashboardSyncLogEntry {
  companyId: string;
  source: DashboardSyncSource;
  requestedAt: number;
  requestParams: unknown;
  rawResponse: unknown;
}

/** Overwrites this (company, source)'s log with the exact params sent and
 * exact raw body received on the LAST real call — the account owner's own
 * "let me see how this actually looks from the real side" request, so a
 * computed dashboard number can be cross-checked against the provider's
 * own dashboard for the identical request. */
export function setSyncLog(companyId: string, source: DashboardSyncSource, requestParams: unknown, rawResponse: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO dashboard_sync_log (company_id, source, requested_at, request_params, raw_response)
       VALUES (@companyId, @source, @requestedAt, @requestParams, @rawResponse)
       ON CONFLICT(company_id, source) DO UPDATE SET requested_at = excluded.requested_at, request_params = excluded.request_params, raw_response = excluded.raw_response`,
    )
    .run({ companyId, source, requestedAt: Date.now(), requestParams: JSON.stringify(requestParams), rawResponse: JSON.stringify(rawResponse) });
}

export function getSyncLog(companyId: string, source: DashboardSyncSource): DashboardSyncLogEntry | null {
  const row = getDb().prepare(`SELECT * FROM dashboard_sync_log WHERE company_id = ? AND source = ?`).get(companyId, source) as
    | { company_id: string; source: string; requested_at: number; request_params: string; raw_response: string }
    | undefined;
  if (!row) return null;
  return {
    companyId: row.company_id,
    source: row.source as DashboardSyncSource,
    requestedAt: row.requested_at,
    requestParams: JSON.parse(row.request_params),
    rawResponse: JSON.parse(row.raw_response),
  };
}
