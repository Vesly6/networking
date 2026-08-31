import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { dataFilePath } from '../dataDir.js';

// Sits next to source (server/linkedin.sqlite) by default, gitignored — a
// local, permanent file for the one feature in this whole app that
// actually needs server-side persistence. Every other feature's data
// lives only in the browser's IndexedDB (see db.ts on the frontend side),
// because server/ has otherwise been a stateless proxy. That doesn't work
// here: a scheduled connect request has to fire at, say, 10:32am whether
// or not a browser tab happens to be open, so the durable state has to
// live in the server process itself, not the browser. See dataDir.ts for
// why the actual directory is configurable (Render's free tier has no
// persistent disk otherwise).
const DB_PATH = dataFilePath('linkedin.sqlite');

let db: Database.Database | null = null;

function migrate(database: Database.Database): void {
  // Schema straight from TZ_LinkedIn_Automation.md's own data model
  // (section 4) — kept close to that design since it was already
  // well-considered (and SaaS-portable, per the TZ's own reasoning,
  // though that's not a near-term goal here).
  database.exec(`
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      daily_cap INTEGER,
      weekly_cap INTEGER,
      work_hours_start TEXT,
      work_hours_end TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      campaign_id TEXT REFERENCES campaigns(id),
      linkedin_url TEXT NOT NULL,
      name TEXT,
      title TEXT,
      company TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS sequence_steps (
      id TEXT PRIMARY KEY,
      campaign_id TEXT REFERENCES campaigns(id),
      step_order INTEGER NOT NULL,
      type TEXT NOT NULL,
      delay_days INTEGER NOT NULL DEFAULT 0,
      message_template TEXT
    );

    -- step_id is deliberately NOT foreign-keyed to any specific table (a
    -- fresh install gets this shape immediately) — see the graph-builder
    -- migration below for why: it needs to hold either a legacy
    -- sequence_steps.id (old rows) or a sequence_nodes.id (new rows) going
    -- forward, and actions_log is an insert-only historical log, not
    -- something else joins against for correctness, so strict enforcement
    -- here was never load-bearing the way it is for leads(id).
    CREATE TABLE IF NOT EXISTS actions_log (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
      step_id TEXT,
      action_type TEXT NOT NULL,
      status TEXT NOT NULL,
      target_url TEXT,
      detail TEXT,
      executed_at INTEGER NOT NULL,
      response_time_ms INTEGER,
      timing_json TEXT
    );

    -- Not in the TZ's own minimal schema — added because a real inbox UI
    -- needs to group messages into threads, and "which lead" alone isn't
    -- enough: a conversation can exist with someone who messaged first
    -- and isn't (yet, or ever) a tracked lead in any campaign.
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
      participant_name TEXT,
      participant_url TEXT NOT NULL UNIQUE,
      last_message_at INTEGER,
      last_message_preview TEXT,
      unread INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
      direction TEXT NOT NULL,
      content TEXT NOT NULL,
      personalized INTEGER NOT NULL DEFAULT 0,
      sent_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS safety_state (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      connects_sent INTEGER NOT NULL DEFAULT 0,
      messages_sent INTEGER NOT NULL DEFAULT 0,
      profile_views INTEGER NOT NULL DEFAULT 0,
      warm_up_day INTEGER NOT NULL DEFAULT 0,
      searches_used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- One row per *local calendar day in the account's own workHoursTimezone*
    -- (dailyPlan.ts), not a UTC day — generated once, the first time it's
    -- needed that day, and never regenerated afterward so the day's planned
    -- slot times stay fixed even as the scheduler ticks repeatedly.
    CREATE TABLE IF NOT EXISTS daily_schedule (
      date TEXT PRIMARY KEY,
      planned_slots TEXT NOT NULL,
      target_count INTEGER NOT NULL,
      is_weekend INTEGER NOT NULL,
      generated_at INTEGER NOT NULL
    );

    -- The visual campaign-builder graph (replaces the flat sequence_steps
    -- list — see the migration below for how existing linear campaigns
    -- carry over). Action nodes have at most one outgoing edge
    -- (branch='default'); condition nodes have exactly two ('yes'/'no').
    -- A 'wait' node is purely structural/timing — the traversal engine
    -- (scheduler.ts's resolveNextNode) walks straight through it, it's
    -- never itself "the lead's current position" and never gets its own
    -- actions_log row, so its id never needs to be stable across a re-save.
    CREATE TABLE IF NOT EXISTS sequence_nodes (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      type TEXT NOT NULL,
      message_template TEXT,
      wait_days INTEGER,
      pos_x REAL NOT NULL DEFAULT 0,
      pos_y REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sequence_edges (
      id TEXT PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      from_node_id TEXT REFERENCES sequence_nodes(id) ON DELETE CASCADE,
      to_node_id TEXT NOT NULL REFERENCES sequence_nodes(id) ON DELETE CASCADE,
      branch TEXT NOT NULL DEFAULT 'default'
    );
  `);
  // Additive migration for databases created before searches_used existed
  // — CREATE TABLE IF NOT EXISTS above is a no-op against an
  // already-existing safety_state table, same pattern accounts/db.ts uses
  // for its own post-launch columns.
  try {
    database.exec(`ALTER TABLE safety_state ADD COLUMN searches_used INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — nothing to do.
  }
  try {
    database.exec(`ALTER TABLE actions_log ADD COLUMN timing_json TEXT`);
  } catch {
    // Column already exists — nothing to do.
  }

  migrateActionsLogStepIdFk(database);
  migrateLegacySequenceStepsToGraph(database);
}

/** One-time table recreation for a database created before actions_log's
 * step_id column dropped its FK to sequence_steps(id) — SQLite has no
 * ALTER TABLE for changing/dropping a foreign key, so this is the standard
 * "create the new shape, copy every row, drop the old table, rename"
 * recipe, wrapped in a transaction (atomic — either the whole swap lands or
 * none of it does) and only run once (checked via the table's own current
 * foreign_key_list rather than a separate version flag, so it's correct
 * even if this function is somehow called twice). A fresh install never
 * hits this path at all — its actions_log is created directly in the
 * unreferenced shape above. */
function migrateActionsLogStepIdFk(database: Database.Database): void {
  const fks = database.prepare(`PRAGMA foreign_key_list(actions_log)`).all() as Array<{ table: string; from: string }>;
  const hasLegacyFk = fks.some((fk) => fk.from === 'step_id' && fk.table === 'sequence_steps');
  if (!hasLegacyFk) return;

  database.pragma('foreign_keys = OFF');
  try {
    const tx = database.transaction(() => {
      database.exec(`
        CREATE TABLE actions_log_new (
          id TEXT PRIMARY KEY,
          lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
          step_id TEXT,
          action_type TEXT NOT NULL,
          status TEXT NOT NULL,
          target_url TEXT,
          detail TEXT,
          executed_at INTEGER NOT NULL,
          response_time_ms INTEGER,
          timing_json TEXT
        );
        INSERT INTO actions_log_new (id, lead_id, step_id, action_type, status, target_url, detail, executed_at, response_time_ms)
          SELECT id, lead_id, step_id, action_type, status, target_url, detail, executed_at, response_time_ms FROM actions_log;
        DROP TABLE actions_log;
        ALTER TABLE actions_log_new RENAME TO actions_log;
      `);
    });
    tx();
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

/** For any campaign that still only has the old flat sequence_steps list
 * and no sequence_nodes yet, auto-converts it into an equivalent
 * straight-line graph — zero manual action needed (contrast with
 * migrateTableData.ts's frontend button, which exists because *that*
 * migration crosses a network boundary; this is a same-database transform,
 * nothing justifies making it manual). Each old step becomes one action
 * node — reusing the OLD step's own id — so any actions_log row already
 * pointing at that id (a lead mid-sequence) keeps resolving to the exact
 * same logical position after the swap. A step with delayDays > 0 gets a
 * synthesized 'wait' node (fresh id — never logged, see the table's own
 * comment above) spliced in just before it. */
function migrateLegacySequenceStepsToGraph(database: Database.Database): void {
  const campaignIds = database.prepare(`SELECT DISTINCT campaign_id FROM sequence_steps`).all() as Array<{ campaign_id: string }>;
  for (const { campaign_id: campaignId } of campaignIds) {
    const alreadyMigrated = database.prepare(`SELECT 1 FROM sequence_nodes WHERE campaign_id = ? LIMIT 1`).get(campaignId);
    if (alreadyMigrated) continue;

    const steps = database
      .prepare(`SELECT * FROM sequence_steps WHERE campaign_id = ? ORDER BY step_order ASC`)
      .all(campaignId) as Array<{ id: string; type: string; delay_days: number; message_template: string | null }>;
    if (steps.length === 0) continue;

    const insertNode = database.prepare(
      `INSERT INTO sequence_nodes (id, campaign_id, type, message_template, wait_days, pos_x, pos_y) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEdge = database.prepare(
      `INSERT INTO sequence_edges (id, campaign_id, from_node_id, to_node_id, branch) VALUES (?, ?, ?, ?, 'default')`,
    );

    const tx = database.transaction(() => {
      let previousNodeId: string | null = null; // null = the start edge
      let yPos = 0;
      for (const step of steps) {
        if (step.delay_days > 0) {
          const waitId = randomUUID();
          insertNode.run(waitId, campaignId, 'wait', null, step.delay_days, 0, yPos);
          insertEdge.run(randomUUID(), campaignId, previousNodeId, waitId);
          previousNodeId = waitId;
          yPos += 120;
        }
        insertNode.run(step.id, campaignId, step.type, step.message_template, null, 0, yPos);
        insertEdge.run(randomUUID(), campaignId, previousNodeId, step.id);
        previousNodeId = step.id;
        yPos += 120;
      }
    });
    tx();
  }
}

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    // better-sqlite3 enforces foreign keys by default (unlike raw SQLite,
    // where it's off unless requested) — made explicit here rather than
    // relying on that default silently, since it directly matters: without
    // the ON DELETE SET NULL on actions_log/messages' own FK columns
    // above, this enforcement blocked deleteCampaign() outright the first
    // time a campaign with any logged action was deleted (a real,
    // reproduced bug — SQLITE_CONSTRAINT_FOREIGNKEY on DELETE FROM
    // sequence_steps while actions_log still pointed at one of its rows).
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

export interface ActionLogEntry {
  id: string;
  leadId: string | null;
  stepId: string | null;
  actionType: string;
  status: 'success' | 'error';
  targetUrl: string | null;
  detail: string | null;
  executedAt: number;
  responseTimeMs: number | null;
  /** JSON-serialized per-action timing breakdown (page.ts's ConnectTiming
   * for a 'connect' action — when it navigated, scrolled, whether it
   * visited the lead's recent-activity page and for how long, when
   * Connect was actually clicked, when it was actually sent) — kept in
   * its own column rather than overloading `detail` (which stays
   * error-text-only) since the two are different shapes for different
   * purposes. Null for action types that don't build a breakdown, and for
   * any row logged before this column existed. */
  timingJson?: string | null;
}

/** Phase 0's one write path — logs the outcome of the manual test connect
 * request. `leadId`/`stepId` are null for now (no real lead/campaign
 * exists yet); once the Campaign Engine (Phase 1) exists, every automated
 * action logs through this same function with real ids attached. */
export function logAction(entry: Omit<ActionLogEntry, 'id'>): void {
  getDb()
    .prepare(
      `INSERT INTO actions_log (id, lead_id, step_id, action_type, status, target_url, detail, executed_at, response_time_ms, timing_json)
       VALUES (@id, @leadId, @stepId, @actionType, @status, @targetUrl, @detail, @executedAt, @responseTimeMs, @timingJson)`,
    )
    .run({ id: randomUUID(), ...entry, timingJson: entry.timingJson ?? null });
}

interface ActionLogRow {
  id: string;
  lead_id: string | null;
  step_id: string | null;
  action_type: string;
  status: 'success' | 'error';
  target_url: string | null;
  detail: string | null;
  executed_at: number;
  response_time_ms: number | null;
  timing_json: string | null;
}

function actionLogFromRow(r: ActionLogRow): ActionLogEntry {
  return {
    id: r.id,
    leadId: r.lead_id,
    stepId: r.step_id,
    actionType: r.action_type,
    status: r.status,
    targetUrl: r.target_url,
    detail: r.detail,
    executedAt: r.executed_at,
    responseTimeMs: r.response_time_ms,
    timingJson: r.timing_json,
  };
}

export function getRecentActions(limit = 20): ActionLogEntry[] {
  const rows = getDb()
    .prepare(`SELECT * FROM actions_log ORDER BY executed_at DESC LIMIT ?`)
    .all(limit) as ActionLogRow[];
  return rows.map(actionLogFromRow);
}

/** Every logged action since `sinceMs` (inclusive), oldest first — the raw
 * material for analytics.ts's daily-activity chart. Deliberately unbounded
 * (no LIMIT): a personal-scale tool's actions_log over even a year of
 * daily use is a few thousand rows at most, cheap enough to aggregate in
 * JS rather than needing a SQL GROUP BY / rollup table. */
export function getActionsSince(sinceMs: number): ActionLogEntry[] {
  const rows = getDb()
    .prepare(`SELECT * FROM actions_log WHERE executed_at >= ? ORDER BY executed_at ASC`)
    .all(sinceMs) as ActionLogRow[];
  return rows.map(actionLogFromRow);
}

/** Every logged action for one specific sequence step — analytics.ts's
 * per-step breakdown uses this to show success/fail counts at the exact
 * point in a campaign's sequence where leads are dropping off, which the
 * plain sent/accepted/replied funnel can't distinguish (a failed step 2
 * looks identical to "hasn't reached step 2 yet" from lead status alone). */
export function getActionsForStep(stepId: string): ActionLogEntry[] {
  const rows = getDb().prepare(`SELECT * FROM actions_log WHERE step_id = ?`).all(stepId) as ActionLogRow[];
  return rows.map(actionLogFromRow);
}

/** The single most recent logged action for one exact (lead, step) pair, if
 * any — used by scheduler.ts's findDueActions() to recognize "we already
 * tried this exact step for this exact lead and got a specific, terminal
 * answer" (currently: a connect step that failed because there's no Connect
 * button — i.e. the person is already connected/pending) without needing a
 * separate lead.status field to carry that meaning. Scoped to one (lead,
 * step) pair rather than "any action for this lead" so a lead with multiple
 * steps in its sequence doesn't have an unrelated step's outcome bleed into
 * this one's. */
export function getLastActionForLeadStep(leadId: string, stepId: string): ActionLogEntry | null {
  const row = getDb()
    .prepare(`SELECT * FROM actions_log WHERE lead_id = ? AND step_id = ? ORDER BY executed_at DESC LIMIT 1`)
    .get(leadId, stepId) as ActionLogRow | undefined;
  return row ? actionLogFromRow(row) : null;
}

// --- Settings (safety.ts's caps/work-hours/warm-up/pause knobs, and
// anything else added later) — plain key-value, UI-editable from Phase 1
// on rather than hardcoded constants, per the plan's own critique of the
// raw TZ (rate-limit numbers need to be tunable without a redeploy, since
// they'll drift as LinkedIn's own enforcement changes over time). ---

export function getSetting(key: string): string | null {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare(`SELECT key, value FROM settings`).all() as Array<{ key: string; value: string }>;
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// --- Safety state (safety.ts's daily/weekly cap counters) ---

export interface SafetyStateRow {
  date: string;
  connectsSent: number;
  messagesSent: number;
  profileViews: number;
  searchesUsed: number;
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Get-or-create today's row — safety.ts calls this before every cap
 * check, so a brand-new day's row always exists by the time anything
 * reads it, with no separate "roll over at midnight" job needed. */
export function getTodaySafetyState(): SafetyStateRow {
  const date = todayDateString();
  const database = getDb();
  const existing = database.prepare(`SELECT * FROM safety_state WHERE date = ?`).get(date) as
    | { date: string; connects_sent: number; messages_sent: number; profile_views: number; searches_used: number }
    | undefined;
  if (existing) {
    return {
      date: existing.date,
      connectsSent: existing.connects_sent,
      messagesSent: existing.messages_sent,
      profileViews: existing.profile_views,
      searchesUsed: existing.searches_used,
    };
  }
  database
    .prepare(`INSERT INTO safety_state (id, date, connects_sent, messages_sent, profile_views, warm_up_day, searches_used) VALUES (?, ?, 0, 0, 0, 0, 0)`)
    .run(randomUUID(), date);
  return { date, connectsSent: 0, messagesSent: 0, profileViews: 0, searchesUsed: 0 };
}

export function incrementSafetyCounter(field: 'connects_sent' | 'messages_sent' | 'profile_views' | 'searches_used'): void {
  getTodaySafetyState(); // ensures today's row exists before the UPDATE below
  getDb()
    .prepare(`UPDATE safety_state SET ${field} = ${field} + 1 WHERE date = ?`)
    .run(todayDateString());
}

/** Sums the last 7 calendar days (inclusive of today) — a plain rolling
 * window, not "since Monday," matching how the daily cap also isn't
 * calendar-aligned to any particular reset time beyond local midnight. */
export function getWeekSafetyTotals(): { connects: number; messages: number } {
  const sevenDaysAgo = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  const row = getDb()
    .prepare(`SELECT COALESCE(SUM(connects_sent), 0) AS connects, COALESCE(SUM(messages_sent), 0) AS messages
              FROM safety_state WHERE date >= ?`)
    .get(sevenDaysAgo) as { connects: number; messages: number };
  return row;
}

// --- Daily schedule (dailyPlan.ts's human-paced daily plan) ---

export interface DailyScheduleRow {
  date: string;
  plannedSlots: number[];
  targetCount: number;
  isWeekend: boolean;
  generatedAt: number;
}

interface RawDailyScheduleRow {
  date: string;
  planned_slots: string;
  target_count: number;
  is_weekend: number;
  generated_at: number;
}

function dailyScheduleFromRow(r: RawDailyScheduleRow): DailyScheduleRow {
  return {
    date: r.date,
    plannedSlots: JSON.parse(r.planned_slots) as number[],
    targetCount: r.target_count,
    isWeekend: r.is_weekend === 1,
    generatedAt: r.generated_at,
  };
}

/** `date` is a *local calendar date in the account's own workHoursTimezone*
 * (see safety.ts's getZonedDateParts), not a UTC date — deliberately a
 * different notion of "today" than safety_state's own todayDateString()
 * above, since this is specifically about when the account owner's day
 * actually starts/ends, not about a fixed cap-counting window. */
export function getDailySchedule(date: string): DailyScheduleRow | null {
  const row = getDb().prepare(`SELECT * FROM daily_schedule WHERE date = ?`).get(date) as RawDailyScheduleRow | undefined;
  return row ? dailyScheduleFromRow(row) : null;
}

export function saveDailySchedule(schedule: DailyScheduleRow): void {
  getDb()
    .prepare(
      `INSERT INTO daily_schedule (date, planned_slots, target_count, is_weekend, generated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO NOTHING`,
    )
    .run(
      schedule.date,
      JSON.stringify(schedule.plannedSlots),
      schedule.targetCount,
      schedule.isWeekend ? 1 : 0,
      schedule.generatedAt,
    );
}

// --- Campaigns ---

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed';

export interface Campaign {
  id: string;
  name: string;
  status: CampaignStatus;
  dailyCap: number | null;
  weeklyCap: number | null;
  workHoursStart: string | null;
  workHoursEnd: string | null;
  createdAt: number;
  leadCount: number;
}

interface CampaignRow {
  id: string;
  name: string;
  status: CampaignStatus;
  daily_cap: number | null;
  weekly_cap: number | null;
  work_hours_start: string | null;
  work_hours_end: string | null;
  created_at: number;
  lead_count: number;
}

function campaignFromRow(r: CampaignRow): Campaign {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    dailyCap: r.daily_cap,
    weeklyCap: r.weekly_cap,
    workHoursStart: r.work_hours_start,
    workHoursEnd: r.work_hours_end,
    createdAt: r.created_at,
    leadCount: r.lead_count,
  };
}

export function createCampaign(name: string): Campaign {
  const id = randomUUID();
  const createdAt = Date.now();
  getDb()
    .prepare(`INSERT INTO campaigns (id, name, status, created_at) VALUES (?, ?, 'draft', ?)`)
    .run(id, name, createdAt);
  return { id, name, status: 'draft', dailyCap: null, weeklyCap: null, workHoursStart: null, workHoursEnd: null, createdAt, leadCount: 0 };
}

// LEFT JOIN + COUNT so a campaign with zero leads still comes back with
// leadCount: 0 instead of being silently missing from the aggregate.
const CAMPAIGN_SELECT = `
  SELECT c.*, COUNT(l.id) AS lead_count
  FROM campaigns c
  LEFT JOIN leads l ON l.campaign_id = c.id
  GROUP BY c.id
`;

export function listCampaigns(): Campaign[] {
  const rows = getDb().prepare(`${CAMPAIGN_SELECT} ORDER BY c.created_at DESC`).all() as CampaignRow[];
  return rows.map(campaignFromRow);
}

export function getCampaign(id: string): Campaign | null {
  const row = getDb().prepare(`${CAMPAIGN_SELECT.replace('GROUP BY c.id', 'WHERE c.id = ? GROUP BY c.id')}`).get(id) as
    | CampaignRow
    | undefined;
  return row ? campaignFromRow(row) : null;
}

export function updateCampaignStatus(id: string, status: CampaignStatus): void {
  getDb().prepare(`UPDATE campaigns SET status = ? WHERE id = ?`).run(status, id);
}

/** Deletes the campaign and everything scoped to it (leads, sequence
 * steps) in one transaction — actions_log rows are kept, with lead_id
 * simply pointing at a now-gone lead, since the log is a historical
 * record of what actually happened and shouldn't disappear just because
 * the campaign that triggered it was later deleted. */
export function deleteCampaign(id: string): void {
  const database = getDb();
  const tx = database.transaction(() => {
    database.prepare(`DELETE FROM leads WHERE campaign_id = ?`).run(id);
    database.prepare(`DELETE FROM sequence_steps WHERE campaign_id = ?`).run(id);
    // Edges before nodes — both are also ON DELETE CASCADE from
    // sequence_nodes, but deleting explicitly here (rather than relying
    // solely on the cascade) keeps this function's own intent readable
    // without needing to cross-reference the schema to know what happens.
    database.prepare(`DELETE FROM sequence_edges WHERE campaign_id = ?`).run(id);
    database.prepare(`DELETE FROM sequence_nodes WHERE campaign_id = ?`).run(id);
    database.prepare(`DELETE FROM campaigns WHERE id = ?`).run(id);
  });
  tx();
}

// --- Leads ---

// 'withdrawn' (Phase 3): the account owner pulled back a connection
// request that sat 'pending' too long with no response — see
// scheduler.ts's findStaleInvites/withdrawInvite. Distinct from 'skipped'
// (a lead the user deliberately decided not to pursue at all, from the
// Pending Approval panel) even though both permanently stop the sequence
// for that lead — collapsing them into one status would lose *why* a
// given lead stopped when reviewing history later.
export type LeadStatus = 'new' | 'connected' | 'pending' | 'replied' | 'skipped' | 'withdrawn';

export interface Lead {
  id: string;
  campaignId: string;
  linkedinUrl: string;
  name: string | null;
  title: string | null;
  company: string | null;
  status: LeadStatus;
  source: string | null;
  /** When the connect request was actually sent (the most recent
   * successful 'connect' action for this lead), or null if never sent —
   * lets the UI split/filter "requests sent, awaiting response" from
   * everything else, and filter by day (real, explicit request: "I want to
   * see today's 5 additions later"). */
  connectSentAt: number | null;
  /** When this lead was detected as accepted — either a successful
   * 'connect' action's own follow-through (rare — LinkedIn's confirm step
   * doesn't distinguish "sent" from "instantly accepted"), or, in
   * practice, almost always inbox.ts's syncInbox() promoting a 'pending'
   * lead to 'connected' once a real conversation exists. See inbox.ts's own
   * comment on why that promotion now logs an action (it didn't originally
   * — there was no timestamp for "when did this become connected" at all
   * until this was added). */
  connectedAt: number | null;
  /** When the sequence's message step last successfully sent to this
   * lead — null if no message has gone out yet. */
  messageSentAt: number | null;
}

interface LeadRow {
  id: string;
  campaign_id: string;
  linkedin_url: string;
  name: string | null;
  title: string | null;
  company: string | null;
  status: LeadStatus;
  source: string | null;
}

function leadFromRow(r: LeadRow, timestamps?: LeadTimestamps): Lead {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    linkedinUrl: r.linkedin_url,
    name: r.name,
    title: r.title,
    company: r.company,
    status: r.status,
    source: r.source,
    connectSentAt: timestamps?.connectSentAt ?? null,
    connectedAt: timestamps?.connectedAt ?? null,
    messageSentAt: timestamps?.messageSentAt ?? null,
  };
}

interface LeadTimestamps {
  connectSentAt: number | null;
  connectedAt: number | null;
  messageSentAt: number | null;
}

/** One query for the whole campaign (not one per lead — personal-scale
 * lead counts make N+1 fine correctness-wise, but there's no reason to pay
 * for it when a single GROUP BY does the same job): the latest successful
 * 'connect' action per lead (connectSentAt), the latest 'connection_accepted'
 * action per lead (connectedAt — see inbox.ts), and the latest successful
 * 'message' action per lead (messageSentAt). */
function getLeadTimestampsForCampaign(campaignId: string): Map<string, LeadTimestamps> {
  const rows = getDb()
    .prepare(
      `SELECT a.lead_id AS lead_id, a.action_type AS action_type, MAX(a.executed_at) AS latest
       FROM actions_log a
       JOIN leads l ON l.id = a.lead_id
       WHERE l.campaign_id = ?
         AND ((a.action_type = 'connect' AND a.status = 'success')
              OR a.action_type = 'connection_accepted'
              OR (a.action_type = 'message' AND a.status = 'success'))
       GROUP BY a.lead_id, a.action_type`,
    )
    .all(campaignId) as Array<{ lead_id: string; action_type: string; latest: number }>;

  const map = new Map<string, LeadTimestamps>();
  for (const row of rows) {
    const entry = map.get(row.lead_id) ?? { connectSentAt: null, connectedAt: null, messageSentAt: null };
    if (row.action_type === 'connect') entry.connectSentAt = row.latest;
    else if (row.action_type === 'connection_accepted') entry.connectedAt = row.latest;
    else if (row.action_type === 'message') entry.messageSentAt = row.latest;
    map.set(row.lead_id, entry);
  }
  return map;
}

export interface NewLead {
  linkedinUrl: string;
  name?: string;
  title?: string;
  company?: string;
  source?: string;
}

/** Canonicalizes a LinkedIn profile URL so the *same person* always
 * produces the *same string*, regardless of how the URL was obtained —
 * pasted/CSV-imported (often `http://`, sometimes with tracking query
 * params) vs. scraped live off LinkedIn's own DOM (page.ts always builds
 * `https://www.linkedin.com/...` via `new URL(href, 'https://www.linkedin.com')`,
 * no query string). Without this, findLeadByLinkedinUrl()'s exact-match
 * lookup — which is what promotes a lead to 'connected' and auto-stops the
 * sequence on a reply (inbox.ts's syncInbox) — would silently never match
 * a lead that was imported as `http://` against the `https://` URL the
 * inbox sync scrapes later, breaking that safety mechanism with no visible
 * error. Forces https, lowercases the host (LinkedIn URLs are case-
 * sensitive in the handle but not the host), strips a trailing slash and
 * any query string/fragment (tracking params like `?miniProfileUrn=...`
 * aren't part of the person's identity). Applied both when a lead is
 * inserted (addLeads, below) and when one is looked up
 * (findLeadByLinkedinUrl) — normalizing only one side would still leave
 * the other free to drift. */
export function normalizeLinkedInUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.protocol = 'https:';
    u.hostname = u.hostname.toLowerCase();
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return url.trim().replace(/\/$/, '');
  }
}

/** Bulk insert in one transaction — a real CSV import can be hundreds of
 * rows, and one-insert-per-row without a transaction would be both slow
 * and leave a partial import on any mid-way failure. Silently skips a row
 * with no linkedin_url (nothing to act on) rather than inserting a
 * useless lead; returns how many were actually inserted so the UI can
 * report "added N of M rows" accurately. */
export function addLeads(campaignId: string, leads: NewLead[]): number {
  const database = getDb();
  const insert = database.prepare(
    `INSERT INTO leads (id, campaign_id, linkedin_url, name, title, company, status, source)
     VALUES (?, ?, ?, ?, ?, ?, 'new', ?)`,
  );
  let inserted = 0;
  const tx = database.transaction((rows: NewLead[]) => {
    for (const lead of rows) {
      const url = lead.linkedinUrl?.trim();
      if (!url) continue;
      insert.run(
        randomUUID(),
        campaignId,
        normalizeLinkedInUrl(url),
        lead.name ?? null,
        lead.title ?? null,
        lead.company ?? null,
        lead.source ?? null,
      );
      inserted++;
    }
  });
  tx(leads);
  return inserted;
}

export function listLeadsForCampaign(campaignId: string): Lead[] {
  const rows = getDb()
    .prepare(`SELECT * FROM leads WHERE campaign_id = ? ORDER BY rowid ASC`)
    .all(campaignId) as LeadRow[];
  const timestamps = getLeadTimestampsForCampaign(campaignId);
  return rows.map((r) => leadFromRow(r, timestamps.get(r.id)));
}

export function getLead(id: string): Lead | null {
  const row = getDb().prepare(`SELECT * FROM leads WHERE id = ?`).get(id) as LeadRow | undefined;
  return row ? leadFromRow(row) : null;
}

export function updateLeadStatus(id: string, status: LeadStatus): void {
  getDb().prepare(`UPDATE leads SET status = ? WHERE id = ?`).run(status, id);
}

export function deleteLead(id: string): void {
  getDb().prepare(`DELETE FROM leads WHERE id = ?`).run(id);
}

// The old flat sequence_steps CRUD (addSequenceStep/listSequenceSteps/
// deleteSequenceStep/updateSequenceStep) is gone — the visual graph
// builder (sequence_nodes/sequence_edges, below) is the live source of
// truth now. The sequence_steps *table* itself is deliberately still
// created (see migrate() above) and never dropped: it's what
// migrateLegacySequenceStepsToGraph() reads from to convert an old
// campaign on first load after upgrading, and dropping it would destroy
// that one-time migration's own source data before it's had a chance to
// run against every existing database.

// --- Campaign graph (the visual builder — replaces sequence_steps as the
// live source of truth; see migrateLegacySequenceStepsToGraph above for
// how an old flat campaign gets converted). ---

// The "coming soon" types (condition_followed_back/profile_visited/
// post_liked/custom, inmail, endorse, find_email) are real, storable
// values — the frontend palette just renders them disabled — so a
// half-built graph a user experimented with before they were wired up
// doesn't silently lose those nodes.
export type SequenceNodeType =
  | 'connect'
  | 'message'
  | 'withdraw'
  | 'view_profile'
  | 'follow'
  | 'like_post'
  | 'wait'
  | 'end'
  | 'condition_connected'
  | 'condition_replied'
  | 'condition_followed_back'
  | 'condition_profile_visited'
  | 'condition_post_liked'
  | 'condition_custom'
  | 'inmail'
  | 'endorse'
  | 'find_email';

export interface SequenceNode {
  id: string;
  campaignId: string;
  type: SequenceNodeType;
  messageTemplate: string | null;
  waitDays: number | null;
  posX: number;
  posY: number;
}

export interface SequenceEdge {
  id: string;
  campaignId: string;
  /** null = the graph's single start edge (points at the first node). */
  fromNodeId: string | null;
  toNodeId: string;
  branch: 'default' | 'yes' | 'no';
}

interface SequenceNodeRow {
  id: string;
  campaign_id: string;
  type: SequenceNodeType;
  message_template: string | null;
  wait_days: number | null;
  pos_x: number;
  pos_y: number;
}

interface SequenceEdgeRow {
  id: string;
  campaign_id: string;
  from_node_id: string | null;
  to_node_id: string;
  branch: 'default' | 'yes' | 'no';
}

function nodeFromRow(r: SequenceNodeRow): SequenceNode {
  return { id: r.id, campaignId: r.campaign_id, type: r.type, messageTemplate: r.message_template, waitDays: r.wait_days, posX: r.pos_x, posY: r.pos_y };
}

function edgeFromRow(r: SequenceEdgeRow): SequenceEdge {
  return { id: r.id, campaignId: r.campaign_id, fromNodeId: r.from_node_id, toNodeId: r.to_node_id, branch: r.branch };
}

export function getCampaignGraph(campaignId: string): { nodes: SequenceNode[]; edges: SequenceEdge[] } {
  const database = getDb();
  const nodes = (database.prepare(`SELECT * FROM sequence_nodes WHERE campaign_id = ?`).all(campaignId) as SequenceNodeRow[]).map(nodeFromRow);
  const edges = (database.prepare(`SELECT * FROM sequence_edges WHERE campaign_id = ?`).all(campaignId) as SequenceEdgeRow[]).map(edgeFromRow);
  return { nodes, edges };
}

export interface NewSequenceNode {
  id: string;
  type: SequenceNodeType;
  messageTemplate: string | null;
  waitDays: number | null;
  posX: number;
  posY: number;
}

export interface NewSequenceEdge {
  fromNodeId: string | null;
  toNodeId: string;
  branch: 'default' | 'yes' | 'no';
}

/** Bulk replace, one transaction — an editor session naturally touches many
 * nodes/edges at once (add a few, rewire a few, drag several into new
 * positions), same "one bulk endpoint, not N per-item calls" reasoning as
 * useTableStore's saveRows()/PUT /api/rows. Client-supplied node ids are
 * kept as-is (not regenerated) specifically so a node that already has
 * actions_log history against its id keeps that history attached across a
 * save — only genuinely new nodes get a fresh id, assigned client-side
 * before this is called. */
export function saveCampaignGraph(campaignId: string, nodes: NewSequenceNode[], edges: NewSequenceEdge[]): void {
  const database = getDb();
  const tx = database.transaction(() => {
    database.prepare(`DELETE FROM sequence_edges WHERE campaign_id = ?`).run(campaignId);
    database.prepare(`DELETE FROM sequence_nodes WHERE campaign_id = ?`).run(campaignId);
    const insertNode = database.prepare(
      `INSERT INTO sequence_nodes (id, campaign_id, type, message_template, wait_days, pos_x, pos_y) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const n of nodes) {
      insertNode.run(n.id, campaignId, n.type, n.messageTemplate, n.waitDays, n.posX, n.posY);
    }
    const insertEdge = database.prepare(
      `INSERT INTO sequence_edges (id, campaign_id, from_node_id, to_node_id, branch) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const e of edges) {
      insertEdge.run(randomUUID(), campaignId, e.fromNodeId, e.toNodeId, e.branch);
    }
  });
  tx();
}

// --- Lead progress (derived from actions_log, not a separate tracked
// column) — "what node this lead is currently at" is always computed
// from its own history of successful actions rather than stored
// redundantly, so the two can never drift out of sync with each other. ---

/** The id of the sequence_nodes row for the most recent *successful*
 * action taken for this lead, or null if none yet (meaning the lead
 * hasn't started the graph at all — its next node is whatever the start
 * edge points to). Deliberately just reads actions_log.step_id back
 * verbatim and trusts it as a node id — see actions_log's own schema
 * comment on why that column dropped its FK: this is exactly the
 * "resolve it as whatever the current model calls a position" flexibility
 * that bought, working unchanged for both a legacy-migrated node (which
 * kept its old sequence_steps id, see migrateLegacySequenceStepsToGraph)
 * and a brand new one. */
export function getLastCompletedNodeId(leadId: string): string | null {
  const row = getDb()
    .prepare(`SELECT step_id FROM actions_log WHERE lead_id = ? AND status = 'success' AND step_id IS NOT NULL ORDER BY executed_at DESC LIMIT 1`)
    .get(leadId) as { step_id: string } | undefined;
  return row?.step_id ?? null;
}

export function getLastActionTime(leadId: string): number | null {
  const row = getDb()
    .prepare(`SELECT executed_at FROM actions_log WHERE lead_id = ? AND status = 'success' ORDER BY executed_at DESC LIMIT 1`)
    .get(leadId) as { executed_at: number } | undefined;
  return row?.executed_at ?? null;
}

/** Finds a lead by an exact LinkedIn URL match — used to link a scraped
 * conversation participant back to a tracked lead, and (in inbox.ts) to
 * promote a 'pending' lead to 'connected' once a real conversation with
 * them exists (LinkedIn only allows messaging a 1st-degree connection, so
 * a conversation existing at all is itself proof the invite was
 * accepted). Both sides go through normalizeLinkedInUrl() — addLeads()
 * already stores every lead's URL canonicalized, so this normalizes the
 * *incoming* url the same way rather than trusting it already matches;
 * without this, a scraped `https://www.linkedin.com/in/x` would silently
 * fail to match a lead if it had ever been stored any other way (a stale
 * pre-normalization row, or a future insert path that forgets to
 * normalize) — better to normalize defensively on both the write and the
 * read side than to rely on every writer getting it right forever. */
export function findLeadByLinkedinUrl(url: string): Lead | null {
  const normalized = normalizeLinkedInUrl(url);
  const row = getDb()
    .prepare(`SELECT * FROM leads WHERE linkedin_url = ?`)
    .get(normalized) as LeadRow | undefined;
  return row ? leadFromRow(row) : null;
}

// --- Conversations / messages (the Inbox) ---

export interface Conversation {
  id: string;
  leadId: string | null;
  participantName: string | null;
  participantUrl: string;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  unread: boolean;
}

interface ConversationRow {
  id: string;
  lead_id: string | null;
  participant_name: string | null;
  participant_url: string;
  last_message_at: number | null;
  last_message_preview: string | null;
  unread: number;
}

function conversationFromRow(r: ConversationRow): Conversation {
  return {
    id: r.id,
    leadId: r.lead_id,
    participantName: r.participant_name,
    participantUrl: r.participant_url,
    lastMessageAt: r.last_message_at,
    lastMessagePreview: r.last_message_preview,
    unread: r.unread === 1,
  };
}

/** Find-or-create by participant_url (unique) — inbox.ts calls this once
 * per scraped conversation on every sync, so a person only ever gets one
 * conversation row no matter how many times they're seen. Also
 * (re-)links `lead_id` via findLeadByLinkedinUrl() every time, in case a
 * matching lead is imported *after* the conversation was first synced. */
export function upsertConversation(opts: {
  participantUrl: string;
  participantName: string | null;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  unread: boolean;
}): Conversation {
  const database = getDb();
  const lead = findLeadByLinkedinUrl(opts.participantUrl);
  const existing = database.prepare(`SELECT * FROM conversations WHERE participant_url = ?`).get(opts.participantUrl) as
    | ConversationRow
    | undefined;
  if (existing) {
    database
      .prepare(
        `UPDATE conversations SET lead_id = ?, participant_name = ?, last_message_at = ?, last_message_preview = ?, unread = ?
         WHERE id = ?`,
      )
      .run(
        lead?.id ?? existing.lead_id,
        opts.participantName ?? existing.participant_name,
        opts.lastMessageAt ?? existing.last_message_at,
        opts.lastMessagePreview ?? existing.last_message_preview,
        opts.unread ? 1 : 0,
        existing.id,
      );
    return conversationFromRow({ ...existing, lead_id: lead?.id ?? existing.lead_id, unread: opts.unread ? 1 : 0 });
  }
  const id = randomUUID();
  database
    .prepare(
      `INSERT INTO conversations (id, lead_id, participant_name, participant_url, last_message_at, last_message_preview, unread)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, lead?.id ?? null, opts.participantName, opts.participantUrl, opts.lastMessageAt, opts.lastMessagePreview, opts.unread ? 1 : 0);
  return {
    id,
    leadId: lead?.id ?? null,
    participantName: opts.participantName,
    participantUrl: opts.participantUrl,
    lastMessageAt: opts.lastMessageAt,
    lastMessagePreview: opts.lastMessagePreview,
    unread: opts.unread,
  };
}

export function listConversations(): Conversation[] {
  const rows = getDb().prepare(`SELECT * FROM conversations ORDER BY last_message_at DESC`).all() as ConversationRow[];
  return rows.map(conversationFromRow);
}

export function getConversation(id: string): Conversation | null {
  const row = getDb().prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as ConversationRow | undefined;
  return row ? conversationFromRow(row) : null;
}

export function markConversationRead(id: string): void {
  getDb().prepare(`UPDATE conversations SET unread = 0 WHERE id = ?`).run(id);
}

export type MessageDirection = 'in' | 'out';

export interface Message {
  id: string;
  conversationId: string;
  leadId: string | null;
  direction: MessageDirection;
  content: string;
  sentAt: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  lead_id: string | null;
  direction: MessageDirection;
  content: string;
  sent_at: number;
}

function messageFromRow(r: MessageRow): Message {
  return { id: r.id, conversationId: r.conversation_id, leadId: r.lead_id, direction: r.direction, content: r.content, sentAt: r.sent_at };
}

/** Skips inserting a duplicate — inbox.ts re-scrapes each conversation's
 * *full* visible message history on every sync (LinkedIn's DOM gives no
 * cheap "since when" cursor), so without this every sync would
 * re-insert every message it's already seen. Dedup key: same
 * conversation + direction + content + sent_at within the same minute
 * (scraped timestamps are approximate — "2m ago," "1h ago" — not exact,
 * so an exact-timestamp match would be too strict). */
export function addMessageIfNew(conversationId: string, leadId: string | null, direction: MessageDirection, content: string, sentAt: number): boolean {
  const database = getDb();
  const existing = database
    .prepare(
      `SELECT id FROM messages WHERE conversation_id = ? AND direction = ? AND content = ? AND ABS(sent_at - ?) < 60000`,
    )
    .get(conversationId, direction, content, sentAt);
  if (existing) return false;
  database
    .prepare(`INSERT INTO messages (id, conversation_id, lead_id, direction, content, personalized, sent_at) VALUES (?, ?, ?, ?, ?, 0, ?)`)
    .run(randomUUID(), conversationId, leadId, direction, content, sentAt);
  return true;
}

export function listMessagesForConversation(conversationId: string): Message[] {
  const rows = getDb()
    .prepare(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY sent_at ASC`)
    .all(conversationId) as MessageRow[];
  return rows.map(messageFromRow);
}
