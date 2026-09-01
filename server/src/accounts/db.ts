import Database from 'better-sqlite3';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { dataFilePath } from '../dataDir.js';

// Own SQLite file, same "one small file per feature" convention as
// linkedin.sqlite/sms-inbox.sqlite/table-data.sqlite — see dataDir.ts for
// why this survives a Render restart/deploy. Holds the real multi-tenant
// account model this app didn't have until now (see auth.ts's own doc
// comment, which used to describe this as deliberately single-account —
// that's no longer true; this file is what replaced it).
const DB_PATH = dataFilePath('accounts.sqlite');

let db: Database.Database | null = null;

export type Role = 'super_admin' | 'worker';

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled_features TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      role TEXT NOT NULL,
      visible_tabs TEXT,
      can_delete_rows INTEGER NOT NULL DEFAULT 0,
      can_delete_columns INTEGER NOT NULL DEFAULT 0,
      can_delete_notes INTEGER NOT NULL DEFAULT 0,
      can_edit_contacts INTEGER NOT NULL DEFAULT 0,
      can_delete_contacts INTEGER NOT NULL DEFAULT 0,
      can_export_import INTEGER NOT NULL DEFAULT 0,
      can_insert_rows INTEGER NOT NULL DEFAULT 0,
      can_insert_columns INTEGER NOT NULL DEFAULT 0,
      can_hide_rows_columns INTEGER NOT NULL DEFAULT 0,
      can_clear_content INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS users_by_company ON users(company_id);

    CREATE TABLE IF NOT EXISTS company_integrations (
      company_id TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      zadarma_api_key TEXT,
      zadarma_api_secret TEXT,
      zadarma_caller_number TEXT,
      instantly_api_key TEXT,
      apollo_api_key TEXT,
      serper_api_key TEXT,
      openai_api_key TEXT,
      anthropic_api_key TEXT,
      elevenlabs_api_key TEXT,
      linkedin_cdp_url TEXT,
      updated_at INTEGER NOT NULL
    );

    -- Purely organizational — groups topics and/or saved articles. Flat
    -- (no nesting), company-scoped like everything else in this feature.
    -- Created before news_topics/news_saved_items below since both
    -- reference it.
    CREATE TABLE IF NOT EXISTS news_folders (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS news_folders_by_company ON news_folders(company_id);

    CREATE TABLE IF NOT EXISTS news_topics (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      query TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      folder_id TEXT REFERENCES news_folders(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS news_topics_by_company ON news_topics(company_id);

    -- One row per (company, article link) ever shown in the News tab —
    -- purely a "have they seen this" marker, not a cache of the article's
    -- own content (that always comes fresh from serper.dev/the short-lived
    -- in-memory cache in index.ts). Insert-only: a row's presence is the
    -- fact itself, first_seen_at is display-only (never updated).
    CREATE TABLE IF NOT EXISTS news_seen_links (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      link TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      PRIMARY KEY (company_id, link)
    );

    -- Remembers which destination table a given Instantly campaign's
    -- replies should be pushed into from "Visi atsakymai" (the
    -- reply-mapping feature) — a per-campaign choice the company makes
    -- once (in PushReplyRowsModal.tsx) and gets suggested/pre-filled on
    -- every later export of that same campaign, rather than a separate
    -- upfront settings screen. One row per (company, campaign) — a later
    -- save for the same campaign just overwrites the earlier choice.
    CREATE TABLE IF NOT EXISTS company_instantly_table_map (
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      campaign_name TEXT NOT NULL,
      table_name TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (company_id, campaign_name)
    );

    -- A user-bookmarked article — a real snapshot of the article's own
    -- fields at save time (title/snippet/source/date/imageUrl), not just
    -- the link, since News items themselves are never persisted anywhere
    -- else (they're re-fetched fresh from serper.dev on every load/cache
    -- window) and a re-search later isn't guaranteed to surface the exact
    -- same result again for the user to re-save from.
    CREATE TABLE IF NOT EXISTS news_saved_items (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      folder_id TEXT REFERENCES news_folders(id) ON DELETE SET NULL,
      link TEXT NOT NULL,
      title TEXT,
      snippet TEXT,
      source TEXT,
      date TEXT,
      image_url TEXT,
      saved_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS news_saved_items_by_company ON news_saved_items(company_id);

    -- Platform-wide login history for the owner's Admin dashboard ("who
    -- connected when" — insert-only, one row per successful /api/auth/login,
    -- across every company, not scoped/filtered the way worker_actions in
    -- tableData/db.ts is to one company's own super-admin. username/role are
    -- denormalized (captured at login time) so this stays readable even if
    -- the user is later renamed or deleted.
    CREATE TABLE IF NOT EXISTS login_log (
      id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      logged_in_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS login_log_by_company ON login_log(company_id, logged_in_at);
    CREATE INDEX IF NOT EXISTS login_log_by_time ON login_log(logged_in_at);
  `);
  // Additive migration for databases created before these four existed —
  // CREATE TABLE IF NOT EXISTS above is a no-op against an already-existing
  // users table, so a column added after the fact needs an explicit ALTER
  // TABLE, guarded by try/catch since it throws "duplicate column name" on
  // a fresh install where CREATE TABLE above already included it. Same
  // pattern as tableData/db.ts's own `hidden` column migration.
  for (const column of ['can_insert_rows', 'can_insert_columns', 'can_hide_rows_columns', 'can_clear_content']) {
    try {
      database.exec(`ALTER TABLE users ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists — nothing to do.
    }
  }
  // Same additive-migration shape, for news_topics.active — added after
  // the initial ship (soft delete replacing a hard DELETE), so a database
  // that already has news_topics from before this needs the column added
  // explicitly rather than relying on CREATE TABLE IF NOT EXISTS above.
  try {
    database.exec(`ALTER TABLE news_topics ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
  } catch {
    // Column already exists — nothing to do.
  }
  // Same shape again for news_topics.folder_id (folders shipped after
  // news_topics/active). SQLite allows adding a column with a REFERENCES
  // clause via ALTER TABLE same as any other column.
  try {
    database.exec(`ALTER TABLE news_topics ADD COLUMN folder_id TEXT REFERENCES news_folders(id) ON DELETE SET NULL`);
  } catch {
    // Column already exists — nothing to do.
  }
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

// --- Password hashing — node:crypto's scrypt, not bcrypt: this server has
// no password-hashing dependency at all today, and every other secret-
// handling in this codebase (auth.ts's HMAC session tokens, zadarma.ts's
// request signing) is hand-rolled node:crypto rather than a new package.
// Format: "<saltHex>:<hashHex>", so verification never needs to guess the
// salt length or re-derive parameters.
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  // Constant-time — same reasoning as every other credential comparison
  // in this codebase (auth.ts's token signature check, checkCredentials'
  // password compare).
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}

export interface Company {
  id: string;
  name: string;
  enabledFeatures: string[];
  createdAt: number;
}

interface CompanyRow {
  id: string;
  name: string;
  enabled_features: string;
  created_at: number;
}

function companyFromRow(r: CompanyRow): Company {
  return { id: r.id, name: r.name, enabledFeatures: JSON.parse(r.enabled_features), createdAt: r.created_at };
}

export function getCompany(id: string): Company | null {
  const row = getDb().prepare(`SELECT * FROM companies WHERE id = ?`).get(id) as CompanyRow | undefined;
  return row ? companyFromRow(row) : null;
}

/** A freshly registered company starts with zero owner-granted features
 * (just the always-on table/calendar, added by companyWithFeatures() in
 * index.ts — never stored here) — the owner grants everything else
 * explicitly, company by company, via the Admin dashboard's Funkcijos
 * panel (see updateCompanyFeatures below). This is a deliberate reversal
 * of the brief "tabs auto-derive from configured integrations" era (see
 * updateCompanyFeatures's own doc comment) — API keys are owner-managed
 * now too, so there's no self-service moment for a feature to "just
 * appear" from anymore. */
export function createCompany(name: string): Company {
  const company: Company = { id: randomUUID(), name, enabledFeatures: [], createdAt: Date.now() };
  getDb()
    .prepare(`INSERT INTO companies (id, name, enabled_features, created_at) VALUES (?, ?, '[]', ?)`)
    .run(company.id, company.name, company.createdAt);
  return company;
}

/** Owner-only — the Admin dashboard's company list (Įmonės panel). No
 * caller needed this across every company until the Admin dashboard, so
 * it simply didn't exist before now (confirmed via grep). */
export function listCompanies(): Company[] {
  const rows = getDb().prepare(`SELECT * FROM companies ORDER BY created_at ASC`).all() as CompanyRow[];
  return rows.map(companyFromRow);
}

/** Direct, owner-set replacement for the brief "derive tabs from which
 * integrations are configured" era (computeAvailableFeatures, removed —
 * see index.ts's own history) — reverted on explicit request now that the
 * owner is also the one who sets up a client's integrations, so there's
 * no self-service moment left for a feature to auto-appear from. A blind
 * overwrite (not read-modify-write): the Funkcijos panel always sends the
 * complete checked set, same "whole list, not a delta" shape as
 * updateWorker's visibleTabs. */
export function updateCompanyFeatures(companyId: string, features: string[]): void {
  getDb().prepare(`UPDATE companies SET enabled_features = ? WHERE id = ?`).run(JSON.stringify(features), companyId);
}

// --- Per-company integration credentials ------------------------------
// Replaces the old owner-managed enabled_features checkbox model: a
// client's own super-admin pastes in their own API keys (IntegrationsView
// on the client), and a tab simply appears once the relevant integration
// is configured — see computeAvailableFeatures below. All fields nullable
// — a company only ever fills in what it actually uses.

export interface CompanyIntegrations {
  companyId: string;
  zadarmaApiKey: string | null;
  zadarmaApiSecret: string | null;
  zadarmaCallerNumber: string | null;
  instantlyApiKey: string | null;
  apolloApiKey: string | null;
  serperApiKey: string | null;
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  elevenlabsApiKey: string | null;
  linkedinCdpUrl: string | null;
  updatedAt: number;
}

interface CompanyIntegrationsRow {
  company_id: string;
  zadarma_api_key: string | null;
  zadarma_api_secret: string | null;
  zadarma_caller_number: string | null;
  instantly_api_key: string | null;
  apollo_api_key: string | null;
  serper_api_key: string | null;
  openai_api_key: string | null;
  anthropic_api_key: string | null;
  elevenlabs_api_key: string | null;
  linkedin_cdp_url: string | null;
  updated_at: number;
}

function integrationsFromRow(r: CompanyIntegrationsRow): CompanyIntegrations {
  return {
    companyId: r.company_id,
    zadarmaApiKey: r.zadarma_api_key,
    zadarmaApiSecret: r.zadarma_api_secret,
    zadarmaCallerNumber: r.zadarma_caller_number,
    instantlyApiKey: r.instantly_api_key,
    apolloApiKey: r.apollo_api_key,
    serperApiKey: r.serper_api_key,
    openaiApiKey: r.openai_api_key,
    anthropicApiKey: r.anthropic_api_key,
    elevenlabsApiKey: r.elevenlabs_api_key,
    linkedinCdpUrl: r.linkedin_cdp_url,
    updatedAt: r.updated_at,
  };
}

export function getCompanyIntegrations(companyId: string): CompanyIntegrations | null {
  const row = getDb().prepare(`SELECT * FROM company_integrations WHERE company_id = ?`).get(companyId) as
    | CompanyIntegrationsRow
    | undefined;
  return row ? integrationsFromRow(row) : null;
}

export type CompanyIntegrationsPatch = Partial<Omit<CompanyIntegrations, 'companyId' | 'updatedAt'>>;

/** Read-modify-write, same reasoning as updateWorker above — only the keys
 * actually present in `patch` are changed, so submitting the settings
 * form without retyping an already-set key never wipes it. Also the one
 * function the startup migration (index.ts) calls to seed the owner's own
 * row from the pre-existing env vars. */
export function upsertCompanyIntegrations(companyId: string, patch: CompanyIntegrationsPatch): CompanyIntegrations {
  const database = getDb();
  const existing = getCompanyIntegrations(companyId);
  const next: CompanyIntegrations = {
    companyId,
    zadarmaApiKey: patch.zadarmaApiKey ?? existing?.zadarmaApiKey ?? null,
    zadarmaApiSecret: patch.zadarmaApiSecret ?? existing?.zadarmaApiSecret ?? null,
    zadarmaCallerNumber: patch.zadarmaCallerNumber ?? existing?.zadarmaCallerNumber ?? null,
    instantlyApiKey: patch.instantlyApiKey ?? existing?.instantlyApiKey ?? null,
    apolloApiKey: patch.apolloApiKey ?? existing?.apolloApiKey ?? null,
    serperApiKey: patch.serperApiKey ?? existing?.serperApiKey ?? null,
    openaiApiKey: patch.openaiApiKey ?? existing?.openaiApiKey ?? null,
    anthropicApiKey: patch.anthropicApiKey ?? existing?.anthropicApiKey ?? null,
    elevenlabsApiKey: patch.elevenlabsApiKey ?? existing?.elevenlabsApiKey ?? null,
    linkedinCdpUrl: patch.linkedinCdpUrl ?? existing?.linkedinCdpUrl ?? null,
    updatedAt: Date.now(),
  };
  database
    .prepare(
      `INSERT INTO company_integrations (
        company_id, zadarma_api_key, zadarma_api_secret, zadarma_caller_number, instantly_api_key,
        apollo_api_key, serper_api_key, openai_api_key, anthropic_api_key, elevenlabs_api_key, linkedin_cdp_url,
        updated_at
      ) VALUES (@companyId, @zadarmaApiKey, @zadarmaApiSecret, @zadarmaCallerNumber, @instantlyApiKey,
        @apolloApiKey, @serperApiKey, @openaiApiKey, @anthropicApiKey, @elevenlabsApiKey, @linkedinCdpUrl,
        @updatedAt)
      ON CONFLICT(company_id) DO UPDATE SET
        zadarma_api_key = excluded.zadarma_api_key,
        zadarma_api_secret = excluded.zadarma_api_secret,
        zadarma_caller_number = excluded.zadarma_caller_number,
        instantly_api_key = excluded.instantly_api_key,
        apollo_api_key = excluded.apollo_api_key,
        serper_api_key = excluded.serper_api_key,
        openai_api_key = excluded.openai_api_key,
        anthropic_api_key = excluded.anthropic_api_key,
        elevenlabs_api_key = excluded.elevenlabs_api_key,
        linkedin_cdp_url = excluded.linkedin_cdp_url,
        updated_at = excluded.updated_at`,
    )
    .run(next);
  return next;
}

/** Explicit per-field clear — distinct from "not included in a PATCH
 * body" (which upsertCompanyIntegrations above treats as "leave
 * unchanged"), since a real secret is never re-sent to the browser after
 * saving, so an empty form field can't be trusted to mean "the user wants
 * this blank" the way it normally would. IntegrationsView's "✕ Išvalyti"
 * button is the only caller. */
export function clearCompanyIntegrationField(companyId: string, field: keyof CompanyIntegrationsPatch): CompanyIntegrations {
  const columnByField: Record<keyof CompanyIntegrationsPatch, string> = {
    zadarmaApiKey: 'zadarma_api_key',
    zadarmaApiSecret: 'zadarma_api_secret',
    zadarmaCallerNumber: 'zadarma_caller_number',
    instantlyApiKey: 'instantly_api_key',
    apolloApiKey: 'apollo_api_key',
    serperApiKey: 'serper_api_key',
    openaiApiKey: 'openai_api_key',
    anthropicApiKey: 'anthropic_api_key',
    elevenlabsApiKey: 'elevenlabs_api_key',
    linkedinCdpUrl: 'linkedin_cdp_url',
  };
  const column = columnByField[field];
  getDb()
    .prepare(
      `INSERT INTO company_integrations (company_id, updated_at) VALUES (?, ?)
       ON CONFLICT(company_id) DO UPDATE SET ${column} = NULL, updated_at = excluded.updated_at`,
    )
    .run(companyId, Date.now());
  return getCompanyIntegrations(companyId)!;
}

/** The only two tabs that can never be turned off — the core CRM itself.
 * Everything else (including 'lessons', which used to be hardcoded
 * always-on here too) is now a real, owner-toggleable per-company feature
 * — see updateCompanyFeatures above and index.ts's companyWithFeatures,
 * which merges this constant into whatever the company's own
 * enabledFeatures list holds so an owner can never accidentally lock a
 * company out of the app entirely by leaving both unchecked. */
export const ALWAYS_ON_FEATURES = ['table', 'calendar'];
// ---------------------------------------------------------------------

export interface NewsTopic {
  id: string;
  companyId: string;
  query: string;
  active: boolean;
  folderId: string | null;
  createdAt: number;
}

interface NewsTopicRow {
  id: string;
  company_id: string;
  query: string;
  active: number;
  folder_id: string | null;
  created_at: number;
}

function newsTopicFromRow(r: NewsTopicRow): NewsTopic {
  return {
    id: r.id,
    companyId: r.company_id,
    query: r.query,
    active: r.active === 1,
    folderId: r.folder_id,
    createdAt: r.created_at,
  };
}

/** Every topic ever added, active or not — a real, reported data-loss
 * incident (an automated test script's own cleanup step removed a real
 * saved topic, since the old version hard-deleted rows) is why "×" on a
 * topic chip no longer deletes anything at all; see deleteNewsTopic below.
 * The frontend splits this single list into the active chip row vs. a
 * "history" section itself rather than this file exposing two separate
 * functions for what's really one list with a flag. */
export function listNewsTopics(companyId: string): NewsTopic[] {
  const rows = getDb()
    .prepare(`SELECT * FROM news_topics WHERE company_id = ? ORDER BY created_at ASC`)
    .all(companyId) as NewsTopicRow[];
  return rows.map(newsTopicFromRow);
}

/** Re-activates an existing (possibly soft-deleted) topic with the exact
 * same query instead of creating a duplicate row, so "remove then re-add
 * the same search" doesn't silently pile up near-identical rows over
 * time. Comparison is case-insensitive/trimmed — same casual-matching
 * expectation as everywhere else in this app that compares user-typed
 * text (e.g. CSV import's column-name matching). */
export function createNewsTopic(companyId: string, query: string, folderId: string | null = null): NewsTopic {
  const trimmed = query.trim();
  const existing = getDb()
    .prepare(`SELECT * FROM news_topics WHERE company_id = ? AND lower(query) = lower(?)`)
    .get(companyId, trimmed) as NewsTopicRow | undefined;
  if (existing) {
    // Reactivating an existing topic also lets it move into a different
    // folder (e.g. re-adding from the history chip after creating a
    // folder that didn't exist yet) — only actually overwrites folder_id
    // when a non-null one is explicitly passed, so a plain reactivate
    // (folderId omitted) doesn't silently un-file an already-organized
    // topic.
    const nextFolderId = folderId ?? existing.folder_id;
    getDb().prepare(`UPDATE news_topics SET active = 1, folder_id = ? WHERE id = ?`).run(nextFolderId, existing.id);
    return newsTopicFromRow({ ...existing, active: 1, folder_id: nextFolderId });
  }
  const topic: NewsTopic = { id: randomUUID(), companyId, query: trimmed, active: true, folderId, createdAt: Date.now() };
  getDb()
    .prepare(`INSERT INTO news_topics (id, company_id, query, active, folder_id, created_at) VALUES (?, ?, ?, 1, ?, ?)`)
    .run(topic.id, topic.companyId, topic.query, topic.folderId, topic.createdAt);
  return topic;
}

/** Moves an existing topic into a different folder (or ungrouped, via
 * `null`) without touching its active/query state — a separate action
 * from createNewsTopic's own folder-on-reactivate behavior, for simply
 * re-filing an already-active topic. */
export function moveNewsTopic(companyId: string, id: string, folderId: string | null): void {
  getDb().prepare(`UPDATE news_topics SET folder_id = ? WHERE id = ? AND company_id = ?`).run(folderId, id, companyId);
}

/** Soft delete only — flips `active` to 0, never removes the row. Nothing
 * the user has ever searched for is allowed to actually disappear (see
 * listNewsTopics' own doc comment for the incident that motivated this);
 * "×" on a chip just stops it from being actively searched (and billed)
 * going forward, recoverable any time via createNewsTopic's reactivation
 * path above. Scoped to companyId so one company can never touch
 * another's topic by guessing/reusing an id. */
export function deleteNewsTopic(companyId: string, id: string): void {
  getDb().prepare(`UPDATE news_topics SET active = 0 WHERE id = ? AND company_id = ?`).run(id, companyId);
}

/** Records that `link` has now been shown to `companyId` in the News tab
 * and reports whether this is the *first* time — `INSERT OR IGNORE` means
 * a link already seen is a no-op (its original first_seen_at survives),
 * and better-sqlite3's `changes` count is what distinguishes "just
 * inserted" (1, i.e. genuinely new) from "already existed" (0, i.e.
 * already seen before) without a separate SELECT-then-INSERT round trip. */
export function markNewsLinkSeen(companyId: string, link: string): boolean {
  const result = getDb()
    .prepare(`INSERT OR IGNORE INTO news_seen_links (company_id, link, first_seen_at) VALUES (?, ?, ?)`)
    .run(companyId, link, Date.now());
  return result.changes > 0;
}

/** The Instantly reply-mapping feature's saved campaign→table choices for
 * one company, as a plain lookup object (campaign name -> table name) —
 * the shape PushReplyRowsModal.tsx actually wants for a suggestion
 * lookup, not a row array. */
export function getInstantlyTableMap(companyId: string): Record<string, string> {
  const rows = getDb()
    .prepare(`SELECT campaign_name, table_name FROM company_instantly_table_map WHERE company_id = ?`)
    .all(companyId) as { campaign_name: string; table_name: string }[];
  return Object.fromEntries(rows.map((r) => [r.campaign_name, r.table_name]));
}

export function setInstantlyTableMapping(companyId: string, campaignName: string, tableName: string): void {
  getDb()
    .prepare(
      `INSERT INTO company_instantly_table_map (company_id, campaign_name, table_name, updated_at)
       VALUES (@companyId, @campaignName, @tableName, @updatedAt)
       ON CONFLICT(company_id, campaign_name) DO UPDATE SET
         table_name = excluded.table_name,
         updated_at = excluded.updated_at`,
    )
    .run({ companyId, campaignName, tableName, updatedAt: Date.now() });
}

export interface NewsFolder {
  id: string;
  companyId: string;
  name: string;
  createdAt: number;
}

interface NewsFolderRow {
  id: string;
  company_id: string;
  name: string;
  created_at: number;
}

function newsFolderFromRow(r: NewsFolderRow): NewsFolder {
  return { id: r.id, companyId: r.company_id, name: r.name, createdAt: r.created_at };
}

export function listNewsFolders(companyId: string): NewsFolder[] {
  const rows = getDb()
    .prepare(`SELECT * FROM news_folders WHERE company_id = ? ORDER BY created_at ASC`)
    .all(companyId) as NewsFolderRow[];
  return rows.map(newsFolderFromRow);
}

export function createNewsFolder(companyId: string, name: string): NewsFolder {
  const folder: NewsFolder = { id: randomUUID(), companyId, name: name.trim(), createdAt: Date.now() };
  getDb()
    .prepare(`INSERT INTO news_folders (id, company_id, name, created_at) VALUES (?, ?, ?, ?)`)
    .run(folder.id, folder.companyId, folder.name, folder.createdAt);
  return folder;
}

/** A real delete (not soft) — a folder is just an organizing label, not
 * user-authored content, so there's nothing worth preserving about the
 * folder row itself. Topics survive via the FK's own ON DELETE SET NULL
 * (they just become ungrouped again — a topic is a search, meaningful on
 * its own regardless of folder). Saved items are different: confirmed
 * with the user that a saved article only exists *as* belonging to a
 * folder ("оно может быть только как папка") — there's no ungrouped
 * "Išsaugota" bucket to fall back into, so this explicitly deletes them
 * first, application-level, rather than relying on (or changing) the
 * column's own FK behavior, which stays SET NULL in the schema — a
 * migration to CASCADE would mean recreating this table, and it already
 * holds real, user-saved articles that a botched migration could lose. */
export function deleteNewsFolder(companyId: string, id: string): void {
  getDb().prepare(`DELETE FROM news_saved_items WHERE company_id = ? AND folder_id = ?`).run(companyId, id);
  getDb().prepare(`DELETE FROM news_folders WHERE id = ? AND company_id = ?`).run(id, companyId);
}

export interface NewsSavedItem {
  id: string;
  companyId: string;
  folderId: string | null;
  link: string;
  title: string | null;
  snippet: string | null;
  source: string | null;
  date: string | null;
  imageUrl: string | null;
  savedAt: number;
}

interface NewsSavedItemRow {
  id: string;
  company_id: string;
  folder_id: string | null;
  link: string;
  title: string | null;
  snippet: string | null;
  source: string | null;
  date: string | null;
  image_url: string | null;
  saved_at: number;
}

function newsSavedItemFromRow(r: NewsSavedItemRow): NewsSavedItem {
  return {
    id: r.id,
    companyId: r.company_id,
    folderId: r.folder_id,
    link: r.link,
    title: r.title,
    snippet: r.snippet,
    source: r.source,
    date: r.date,
    imageUrl: r.image_url,
    savedAt: r.saved_at,
  };
}

export function listNewsSavedItems(companyId: string): NewsSavedItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM news_saved_items WHERE company_id = ? ORDER BY saved_at DESC`)
    .all(companyId) as NewsSavedItemRow[];
  return rows.map(newsSavedItemFromRow);
}

export interface SaveNewsItemInput {
  folderId: string | null;
  link: string;
  title: string | null;
  snippet: string | null;
  source: string | null;
  date: string | null;
  imageUrl: string | null;
}

export function saveNewsItem(companyId: string, input: SaveNewsItemInput): NewsSavedItem {
  const item: NewsSavedItem = { id: randomUUID(), companyId, savedAt: Date.now(), ...input };
  getDb()
    .prepare(
      `INSERT INTO news_saved_items (id, company_id, folder_id, link, title, snippet, source, date, image_url, saved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.id,
      item.companyId,
      item.folderId,
      item.link,
      item.title,
      item.snippet,
      item.source,
      item.date,
      item.imageUrl,
      item.savedAt,
    );
  return item;
}

export function deleteNewsSavedItem(companyId: string, id: string): void {
  getDb().prepare(`DELETE FROM news_saved_items WHERE id = ? AND company_id = ?`).run(id, companyId);
}

export function moveNewsSavedItem(companyId: string, id: string, folderId: string | null): void {
  getDb()
    .prepare(`UPDATE news_saved_items SET folder_id = ? WHERE id = ? AND company_id = ?`)
    .run(folderId, id, companyId);
}

export interface UserPermissions {
  canDeleteRows: boolean;
  canDeleteColumns: boolean;
  canDeleteNotes: boolean;
  canEditContacts: boolean;
  canDeleteContacts: boolean;
  canExportImport: boolean;
  /** Right-click "Įterpti eilutę virš/žemiau" — UI-only gate (hides the
   * menu items), not independently server-enforceable: a positional insert
   * and a plain "+ Add row" append are indistinguishable once they reach
   * PUT /api/rows (both are just "a new row id in this batch"), and a
   * worker must always be able to add ordinary rows regardless of this
   * flag (that's the everyday CRM workflow). Same accepted-limitation
   * reasoning the original plan used for CSV export being UI-only. */
  canInsertRows: boolean;
  /** Right-click "Įterpti stulpelį kairėje/dešinėje" — same UI-only
   * reasoning as canInsertRows above, mirrored for columns: an inserted
   * column and one appended via "+ Add column" are indistinguishable once
   * they reach PATCH /api/tables/:id/columns (both are just "a new column
   * id in the incoming list"). */
  canInsertColumns: boolean;
  /** Hiding a row/column — unlike insert, this modifies an *existing* id's
   * own field (no new id appears), so it's cleanly diffable and IS
   * enforced server-side too (see index.ts's PATCH /api/tables/:id/columns
   * for columns, and tableData/db.ts's sanitizeRowForWorker for rows). One
   * shared flag for both, matching how the request grouped them. */
  canHideRowsColumns: boolean;
  /** Gates the "Išvalyti turinį" context-menu item only — for text/phone/
   * company/link cells and note/contact entries, clearing is already
   * blocked unconditionally by the append-only/edit-lock rules in
   * tableData/db.ts's sanitizeRowForWorker regardless of this flag; it
   * only meaningfully still controls date/dropdown cells, which the
   * original plan deliberately leaves freely editable for the calendar/
   * status workflow — so this stays a client-side convenience gate on the
   * "clear the whole selection" power tool, not a hard server rule. */
  canClearContent: boolean;
}

export interface User {
  id: string;
  companyId: string;
  username: string;
  firstName: string;
  lastName: string;
  role: Role;
  /** null for owner/super_admin — they always see every tab their company
   * has enabled; only a worker's tab set is ever restricted further. */
  visibleTabs: string[] | null;
  permissions: UserPermissions;
  createdAt: number;
}

interface UserRow {
  id: string;
  company_id: string;
  username: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  role: string;
  visible_tabs: string | null;
  can_delete_rows: number;
  can_delete_columns: number;
  can_delete_notes: number;
  can_edit_contacts: number;
  can_delete_contacts: number;
  can_export_import: number;
  can_insert_rows: number;
  can_insert_columns: number;
  can_hide_rows_columns: number;
  can_clear_content: number;
  created_at: number;
}

function userFromRow(r: UserRow): User {
  return {
    id: r.id,
    companyId: r.company_id,
    username: r.username,
    firstName: r.first_name,
    lastName: r.last_name,
    role: r.role as Role,
    visibleTabs: r.visible_tabs ? JSON.parse(r.visible_tabs) : null,
    permissions: {
      canDeleteRows: r.can_delete_rows === 1,
      canDeleteColumns: r.can_delete_columns === 1,
      canDeleteNotes: r.can_delete_notes === 1,
      canEditContacts: r.can_edit_contacts === 1,
      canDeleteContacts: r.can_delete_contacts === 1,
      canExportImport: r.can_export_import === 1,
      canInsertRows: r.can_insert_rows === 1,
      canInsertColumns: r.can_insert_columns === 1,
      canHideRowsColumns: r.can_hide_rows_columns === 1,
      canClearContent: r.can_clear_content === 1,
    },
    createdAt: r.created_at,
  };
}

export function getUserById(id: string): User | null {
  const row = getDb().prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
  return row ? userFromRow(row) : null;
}

export function getUserByUsername(username: string): User | null {
  const row = getDb().prepare(`SELECT * FROM users WHERE username = ?`).get(username) as UserRow | undefined;
  return row ? userFromRow(row) : null;
}

/** Only for verifying a login attempt — never returned to a client. */
export function getPasswordHash(username: string): string | null {
  const row = getDb().prepare(`SELECT password_hash FROM users WHERE username = ?`).get(username) as
    | { password_hash: string }
    | undefined;
  return row?.password_hash ?? null;
}

export function countUsers(): number {
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number };
  return row.n;
}

export interface CreateUserInput {
  companyId: string;
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  role: Role;
  visibleTabs?: string[] | null;
  permissions?: Partial<UserPermissions>;
}

export function createUser(input: CreateUserInput): User {
  const id = randomUUID();
  const now = Date.now();
  const p = input.permissions ?? {};
  getDb()
    .prepare(
      `INSERT INTO users (
        id, company_id, username, password_hash, first_name, last_name, role, visible_tabs,
        can_delete_rows, can_delete_columns, can_delete_notes, can_edit_contacts, can_delete_contacts, can_export_import,
        can_insert_rows, can_insert_columns, can_hide_rows_columns, can_clear_content,
        created_at
      ) VALUES (@id, @companyId, @username, @passwordHash, @firstName, @lastName, @role, @visibleTabs,
        @canDeleteRows, @canDeleteColumns, @canDeleteNotes, @canEditContacts, @canDeleteContacts, @canExportImport,
        @canInsertRows, @canInsertColumns, @canHideRowsColumns, @canClearContent,
        @createdAt)`,
    )
    .run({
      id,
      companyId: input.companyId,
      username: input.username,
      passwordHash: hashPassword(input.password),
      firstName: input.firstName,
      lastName: input.lastName,
      role: input.role,
      visibleTabs: input.visibleTabs ? JSON.stringify(input.visibleTabs) : null,
      canDeleteRows: p.canDeleteRows ? 1 : 0,
      canDeleteColumns: p.canDeleteColumns ? 1 : 0,
      canDeleteNotes: p.canDeleteNotes ? 1 : 0,
      canEditContacts: p.canEditContacts ? 1 : 0,
      canDeleteContacts: p.canDeleteContacts ? 1 : 0,
      canExportImport: p.canExportImport ? 1 : 0,
      canInsertRows: p.canInsertRows ? 1 : 0,
      canInsertColumns: p.canInsertColumns ? 1 : 0,
      canHideRowsColumns: p.canHideRowsColumns ? 1 : 0,
      canClearContent: p.canClearContent ? 1 : 0,
      createdAt: now,
    });
  return getUserById(id)!;
}

export function listWorkers(companyId: string): User[] {
  const rows = getDb()
    .prepare(`SELECT * FROM users WHERE company_id = ? AND role = 'worker' ORDER BY created_at ASC`)
    .all(companyId) as UserRow[];
  return rows.map(userFromRow);
}

export interface UpdateWorkerInput {
  visibleTabs?: string[];
  permissions?: Partial<UserPermissions>;
  /** Plain text, hashed here — omitted (not empty string) means "leave the
   * existing password unchanged", the same "omitted field ≠ blank field"
   * convention accounts/db.ts's own company-integrations patch and
   * index.ts's route validation already use elsewhere, since a worker's
   * super-admin reprints the whole edit form on every save and shouldn't
   * accidentally wipe a password just by leaving that one field blank. */
  password?: string;
}

/** Read-modify-write on the permission flags — same reasoning as
 * tableData/db.ts's updateTableColumns: a caller only ever has a possibly-
 * stale snapshot of the other fields, so this must not blindly overwrite
 * whichever ones weren't part of this particular edit. Scoped to
 * `companyId` so a super-admin can only ever touch their own workers —
 * including resetting a forgotten password, since a worker has no self-
 * service password-reset flow of their own (no email on file, no recovery
 * question — the super-admin who created the account is the only path
 * back in). */
export function updateWorker(userId: string, companyId: string, input: UpdateWorkerInput): User | null {
  const database = getDb();
  const existing = database.prepare(`SELECT * FROM users WHERE id = ? AND company_id = ? AND role = 'worker'`).get(userId, companyId) as
    | UserRow
    | undefined;
  if (!existing) return null;
  const current = userFromRow(existing);
  const nextTabs = input.visibleTabs ?? current.visibleTabs ?? [];
  const nextPerms = { ...current.permissions, ...input.permissions };
  const nextPasswordHash = input.password ? hashPassword(input.password) : existing.password_hash;
  database
    .prepare(
      `UPDATE users SET visible_tabs = ?, password_hash = ?, can_delete_rows = ?, can_delete_columns = ?, can_delete_notes = ?, can_edit_contacts = ?, can_delete_contacts = ?, can_export_import = ?,
       can_insert_rows = ?, can_insert_columns = ?, can_hide_rows_columns = ?, can_clear_content = ?
       WHERE id = ? AND company_id = ?`,
    )
    .run(
      JSON.stringify(nextTabs),
      nextPasswordHash,
      nextPerms.canDeleteRows ? 1 : 0,
      nextPerms.canDeleteColumns ? 1 : 0,
      nextPerms.canDeleteNotes ? 1 : 0,
      nextPerms.canEditContacts ? 1 : 0,
      nextPerms.canDeleteContacts ? 1 : 0,
      nextPerms.canExportImport ? 1 : 0,
      nextPerms.canInsertRows ? 1 : 0,
      nextPerms.canInsertColumns ? 1 : 0,
      nextPerms.canHideRowsColumns ? 1 : 0,
      nextPerms.canClearContent ? 1 : 0,
      userId,
      companyId,
    );
  return getUserById(userId);
}

export function deleteWorker(userId: string, companyId: string): void {
  getDb().prepare(`DELETE FROM users WHERE id = ? AND company_id = ? AND role = 'worker'`).run(userId, companyId);
}

// --- Login history (owner's Admin dashboard) --------------------------

export interface LoginLogEntry {
  id: string;
  companyId: string;
  userId: string;
  username: string;
  role: Role;
  loggedInAt: number;
}

interface LoginLogRow {
  id: string;
  company_id: string;
  user_id: string;
  username: string;
  role: string;
  logged_in_at: number;
}

function loginLogFromRow(r: LoginLogRow): LoginLogEntry {
  return { id: r.id, companyId: r.company_id, userId: r.user_id, username: r.username, role: r.role as Role, loggedInAt: r.logged_in_at };
}

/** Called from POST /api/auth/login on every successful login — never on
 * a failed attempt (this is a "who's actually using the app" history, not
 * a security/intrusion log). */
export function recordLogin(user: User): void {
  getDb()
    .prepare(`INSERT INTO login_log (id, company_id, user_id, username, role, logged_in_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), user.companyId, user.id, user.username, user.role, Date.now());
}

/** Owner-only. `companyId` omitted = every company (the Admin dashboard's
 * default view); passed = one company's own history, same optional-filter
 * shape as tableData/db.ts's listWorkerActions. */
export function listLoginLog(companyId: string | undefined, limit: number): LoginLogEntry[] {
  const rows = companyId
    ? (getDb().prepare(`SELECT * FROM login_log WHERE company_id = ? ORDER BY logged_in_at DESC LIMIT ?`).all(companyId, limit) as LoginLogRow[])
    : (getDb().prepare(`SELECT * FROM login_log ORDER BY logged_in_at DESC LIMIT ?`).all(limit) as LoginLogRow[]);
  return rows.map(loginLogFromRow);
}

/** One-time startup bootstrap — if there are no users at all yet, this is
 * either a brand-new install or the very first boot after this
 * multi-tenant model replaced the old single-shared-account one. Either
 * way, today's AUTH_USERNAME/AUTH_PASSWORD becomes the first user of a
 * freshly created "Company #1", which is also what the pre-existing
 * table-data.sqlite rows get backfilled onto (see tableData/db.ts's own
 * backfillCompanyId, called right after this from index.ts's startup
 * sequence) — so that account's existing real rows keep working exactly as
 * before, just now formally owned by that company. Returns that company's
 * id either way (freshly created, or the existing first one on every later
 * boot) so the caller can always backfill/verify against it.
 *
 * Renamed from bootstrapOwnerIfNeeded() — the first company's own user
 * used to be tagged `role: 'owner'`, giving it platform-wide admin powers
 * just by virtue of being logged into that one specific account. On
 * explicit request, admin access is now a fully independent identity (see
 * requireSuperAdmin in auth.ts) with no per-user role at all, so the first
 * company's own user is a completely ordinary 'super_admin' now — this
 * function only ever ensures a first company/account exists, nothing
 * about admin rights. */
export function bootstrapFirstCompanyIfNeeded(): { companyId: string } {
  if (countUsers() > 0) {
    const companies = listCompanies();
    if (companies.length > 0) return { companyId: companies[0].id };
  }
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;
  if (!username || !password) {
    throw new Error('AUTH_USERNAME/AUTH_PASSWORD are not set — check server/.env (needed for the one-time first-company bootstrap)');
  }
  const company = createCompany('Company #1');
  createUser({
    companyId: company.id,
    username,
    password,
    firstName: 'Owner',
    lastName: '',
    role: 'super_admin',
  });
  return { companyId: company.id };
}

/** One-time migration, run once at every startup alongside
 * bootstrapFirstCompanyIfNeeded() above — converts any pre-existing
 * `role = 'owner'` row (the real account this app ran with before admin
 * access became independent of any per-user role) into an ordinary
 * `super_admin`, in place: same id, same company, same data, same
 * login credentials, just no longer carrying special platform-wide
 * powers. Idempotent — after the first successful run, no row ever
 * matches 'owner' again, so this is a plain no-op on every later boot. */
export function demoteOwnerUsers(): void {
  getDb().prepare(`UPDATE users SET role = 'super_admin' WHERE role = 'owner'`).run();
}
