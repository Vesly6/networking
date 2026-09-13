import Database from 'better-sqlite3';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { dataFilePath } from '../dataDir.js';
import { ALL_PERMISSION_KEYS, LEGACY_BOOLEAN_PERMISSION_MAP, type PermissionKey } from '../permissions/registry.js';

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

    -- Who holds which permission-registry key (see
    -- server/src/permissions/registry.ts for the fixed catalog of keys —
    -- this table is the "who," the registry is the "what's possible").
    -- subject_type='company' rows are a company's own ceiling — set only
    -- by the platform Super Super Admin, and what a company's super_admin
    -- effective set always equals (see permissions/effective.ts). subject_
    -- type='user' rows are one specific worker's own grant from their
    -- company's super_admin — a worker's EFFECTIVE set is always the live
    -- intersection of their own rows here with their company's ceiling
    -- rows, computed fresh on every check, never cached/stored — see
    -- effective.ts's own doc comment for why that's load-bearing (an
    -- instant, walk-nothing revocation).
    CREATE TABLE IF NOT EXISTS permission_grants (
      id TEXT PRIMARY KEY,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      permission_key TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      granted_by TEXT NOT NULL,
      UNIQUE(subject_type, subject_id, permission_key)
    );
    CREATE INDEX IF NOT EXISTS permission_grants_subject ON permission_grants(subject_type, subject_id);

    -- Append-only, never edited/deleted from any UI — every grant/revoke,
    -- role change, company block/unblock, impersonation start/stop, and
    -- rejected access attempt. company_id is nullable (a platform-wide
    -- event, e.g. creating a company, concerns no single existing company);
    -- actor_user_id is nullable for the one seed-time actor ('platform',
    -- the one-time migration itself, never a real user id) — see
    -- appendAuditLog's own doc comment.
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      actor_user_id TEXT,
      actor_role TEXT,
      company_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_log_by_company ON audit_log(company_id, at);
    CREATE INDEX IF NOT EXISTS audit_log_by_time ON audit_log(at);

    -- One-row marker table, not a derived heuristic (e.g. "does this
    -- subject have zero permission_grants rows yet") — a worker whose
    -- super_admin has genuinely revoked every permission would look
    -- identical to "never migrated" under that heuristic, and Render's
    -- free-tier idle-restart (see dataDir.ts) would then silently re-seed
    -- their old boolean-flag permissions back on the very next boot,
    -- undoing a real revocation. This table exists purely so
    -- migratePermissionsIfNeeded() can tell "already ran" from "genuinely
    -- has nothing granted" and never re-run once it's done.
    CREATE TABLE IF NOT EXISTS permission_migration_done (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      done_at INTEGER NOT NULL
    );
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
  // Per-worker Zadarma phone number/softphone extension — first concrete
  // step of "each worker has their own phone numbers and widgets." All
  // three nullable: unset means "fall back to this company's/deployment's
  // existing shared value" (see index.ts's GET /api/webrtc/key and
  // POST /api/callback), so a company that never configures per-worker
  // numbers keeps working exactly as before.
  for (const column of ['zadarma_sip', 'zadarma_widget_sip', 'zadarma_caller_number']) {
    try {
      database.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
    } catch {
      // Column already exists — nothing to do.
    }
  }
  // Completing "each worker has their own API" beyond Zadarma — one
  // nullable override column per remaining integration that's a plain API
  // key (see index.ts's requireXKey() helpers, which now prefer this over
  // the company-wide company_integrations value). Requested explicitly as
  // a completeness/insurance measure, not because per-worker Apollo/
  // Instantly/etc. accounts are in active use yet — unset means "fall back
  // to the company-wide key," so nothing changes for any company that
  // never sets one. LinkedIn's own CDP URL is deliberately NOT included
  // here — see server/src/linkedin/browser.ts's own doc comment: it's a
  // single cached browser connection (one warm, persistent Chrome session
  // *is* the safety premise of that whole feature), not a per-request
  // credential, so "per worker" doesn't map onto it the same way without a
  // much larger restructuring of that module.
  for (const column of [
    'instantly_api_key',
    'apollo_api_key',
    'serper_api_key',
    'openai_api_key',
    'anthropic_api_key',
    'elevenlabs_api_key',
  ]) {
    try {
      database.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
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
  // Company-level suspension (platform Super Super Admin only — see
  // blockCompany/unblockCompany below and auth.ts's requireAuth, which
  // checks this on every request). NULL = active, the default for every
  // existing and newly-created company, so this is a pure opt-in with zero
  // effect until a platform admin explicitly blocks someone.
  try {
    database.exec(`ALTER TABLE companies ADD COLUMN blocked_at INTEGER`);
  } catch {
    // Column already exists — nothing to do.
  }
  // Per-provider Shared/Individual credential-fallback mode (see
  // permissions/registry.ts's api_keys.set_mode and index.ts's requireXKey
  // helpers) — 'shared' preserves today's exact worker-falls-back-to-
  // company-key behavior for every company that never touches this, so the
  // DEFAULT alone (SQLite backfills it onto every pre-existing row, not
  // just future inserts) is the complete migration for this column; no
  // separate UPDATE pass is needed.
  for (const column of [
    'apollo_mode',
    'serper_mode',
    'instantly_mode',
    'openai_mode',
    'anthropic_mode',
    'elevenlabs_mode',
  ]) {
    try {
      database.exec(`ALTER TABLE company_integrations ADD COLUMN ${column} TEXT NOT NULL DEFAULT 'shared'`);
    } catch {
      // Column already exists — nothing to do.
    }
  }
  // Company-level Zadarma SIP/widget-SIP identity — closes the cross-
  // COMPANY leak documented in the plan: GET /api/webrtc/key used to fall
  // back straight to a single process.env pair shared by every company on
  // the deployment once no per-worker override was set. These two columns
  // are that missing middle fallback tier (worker override → this →
  // nothing, no more env var in the chain) — see index.ts's startup seed
  // for how the one pre-existing deployment's env-var values get copied in
  // here once, and the webrtc/key route for the new three-tier resolution.
  for (const column of ['zadarma_sip', 'zadarma_widget_sip']) {
    try {
      database.exec(`ALTER TABLE company_integrations ADD COLUMN ${column} TEXT`);
    } catch {
      // Column already exists — nothing to do.
    }
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
  /** Set only by the platform Super Super Admin (see blockCompany below) —
   * null means active. Checked in auth.ts's requireAuth on every request,
   * so blocking takes effect immediately for every one of that company's
   * users, including one already mid-session with a live token. */
  blockedAt: number | null;
}

interface CompanyRow {
  id: string;
  name: string;
  enabled_features: string;
  created_at: number;
  blocked_at: number | null;
}

/** Parses a JSON array column, tolerating a NULL/empty/corrupted value
 * instead of throwing — a real, reported bug: an unguarded JSON.parse here
 * (or on users.visible_tabs below) took down the ENTIRE login route with a
 * generic 500 the moment either string wasn't valid JSON, since this whole
 * chain runs synchronously inside checkCredentials → userToPublic, with
 * nothing catching a parse error more specifically than the app-wide
 * catch-all. Falling back to `[]` keeps a company usable (worst case: it
 * shows as having no owner-granted features, same as immediately after
 * registration) instead of locking every one of its users out entirely. */
function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function companyFromRow(r: CompanyRow): Company {
  return {
    id: r.id,
    name: r.name,
    enabledFeatures: parseJsonArray(r.enabled_features),
    createdAt: r.created_at,
    blockedAt: r.blocked_at ?? null,
  };
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
  const company: Company = { id: randomUUID(), name, enabledFeatures: [], createdAt: Date.now(), blockedAt: null };
  getDb()
    .prepare(`INSERT INTO companies (id, name, enabled_features, created_at) VALUES (?, ?, '[]', ?)`)
    .run(company.id, company.name, company.createdAt);
  // A brand-new company's permission ceiling defaults to the FULL registry
  // — unlike enabledFeatures above (a deliberate opt-in tab list), a
  // permission gates whether this company's own super_admin can do
  // anything with their own account at all (manage their own workers,
  // create tables, use whatever integrations they configure). Starting
  // empty would brick a freshly self-registered company until the
  // platform manually intervened, which isn't how registration has ever
  // worked — see migratePermissionsIfNeeded's own doc comment for why
  // every company that existed BEFORE the permission registry shipped
  // gets this same full-ceiling default; this is that same default
  // applied to every company created from here on. The platform can
  // still narrow it later via PUT /api/admin/companies/:id/permissions,
  // same as for any other company.
  setGrantedKeys('company', company.id, ALL_PERMISSION_KEYS, 'platform');
  return company;
}

/** Owner-only — the Admin dashboard's company list (Įmonės panel). No
 * caller needed this across every company until the Admin dashboard, so
 * it simply didn't exist before now (confirmed via grep). */
export function listCompanies(): Company[] {
  const rows = getDb().prepare(`SELECT * FROM companies ORDER BY created_at ASC`).all() as CompanyRow[];
  return rows.map(companyFromRow);
}

/** Platform-wide suspension — every one of this company's users is
 * rejected by auth.ts's requireAuth on their very next request, including
 * one already mid-session with a still-unexpired token (requireAuth
 * re-reads the company fresh from the DB on every call, same "never trust
 * a cached/token-baked copy" reasoning as requirePermission/
 * requirePermission2). Deliberately does not touch any user/data row —
 * unblocking restores exactly what was there before. */
export function blockCompany(id: string): void {
  getDb().prepare(`UPDATE companies SET blocked_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function unblockCompany(id: string): void {
  getDb().prepare(`UPDATE companies SET blocked_at = NULL WHERE id = ?`).run(id);
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

/** 'shared' (the default, preserving every existing company's behavior
 * exactly) keeps today's worker-override-falls-back-to-company-key check;
 * 'individual' removes the company-wide fallback for that one provider
 * entirely — a worker (or the acting effective user generally) with no key
 * of their own gets IntegrationNotConfiguredError, full stop. See
 * index.ts's requireXKey() helpers and permissions/registry.ts's
 * api_keys.set_mode. */
export type IntegrationMode = 'shared' | 'individual';

export interface CompanyIntegrations {
  companyId: string;
  zadarmaApiKey: string | null;
  zadarmaApiSecret: string | null;
  zadarmaCallerNumber: string | null;
  /** Company-level fallback for the softphone widget's SIP identity — the
   * new middle tier between a worker's own zadarma_sip/zadarma_widget_sip
   * override and nothing, replacing the old process.env.ZADARMA_WEBRTC_SIP/
   * _WIDGET_SIP globals that used to be shared by every company on the
   * deployment (see GET /api/webrtc/key in index.ts). */
  zadarmaSip: string | null;
  zadarmaWidgetSip: string | null;
  instantlyApiKey: string | null;
  apolloApiKey: string | null;
  serperApiKey: string | null;
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  elevenlabsApiKey: string | null;
  linkedinCdpUrl: string | null;
  apolloMode: IntegrationMode;
  serperMode: IntegrationMode;
  instantlyMode: IntegrationMode;
  openaiMode: IntegrationMode;
  anthropicMode: IntegrationMode;
  elevenlabsMode: IntegrationMode;
  updatedAt: number;
}

interface CompanyIntegrationsRow {
  company_id: string;
  zadarma_api_key: string | null;
  zadarma_api_secret: string | null;
  zadarma_caller_number: string | null;
  zadarma_sip: string | null;
  zadarma_widget_sip: string | null;
  instantly_api_key: string | null;
  apollo_api_key: string | null;
  serper_api_key: string | null;
  openai_api_key: string | null;
  anthropic_api_key: string | null;
  elevenlabs_api_key: string | null;
  linkedin_cdp_url: string | null;
  apollo_mode: string;
  serper_mode: string;
  instantly_mode: string;
  openai_mode: string;
  anthropic_mode: string;
  elevenlabs_mode: string;
  updated_at: number;
}

function modeFromColumn(value: string | null | undefined): IntegrationMode {
  return value === 'individual' ? 'individual' : 'shared';
}

function integrationsFromRow(r: CompanyIntegrationsRow): CompanyIntegrations {
  return {
    companyId: r.company_id,
    zadarmaApiKey: r.zadarma_api_key,
    zadarmaApiSecret: r.zadarma_api_secret,
    zadarmaCallerNumber: r.zadarma_caller_number,
    zadarmaSip: r.zadarma_sip,
    zadarmaWidgetSip: r.zadarma_widget_sip,
    instantlyApiKey: r.instantly_api_key,
    apolloApiKey: r.apollo_api_key,
    serperApiKey: r.serper_api_key,
    openaiApiKey: r.openai_api_key,
    anthropicApiKey: r.anthropic_api_key,
    elevenlabsApiKey: r.elevenlabs_api_key,
    linkedinCdpUrl: r.linkedin_cdp_url,
    apolloMode: modeFromColumn(r.apollo_mode),
    serperMode: modeFromColumn(r.serper_mode),
    instantlyMode: modeFromColumn(r.instantly_mode),
    openaiMode: modeFromColumn(r.openai_mode),
    anthropicMode: modeFromColumn(r.anthropic_mode),
    elevenlabsMode: modeFromColumn(r.elevenlabs_mode),
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
    zadarmaSip: patch.zadarmaSip ?? existing?.zadarmaSip ?? null,
    zadarmaWidgetSip: patch.zadarmaWidgetSip ?? existing?.zadarmaWidgetSip ?? null,
    instantlyApiKey: patch.instantlyApiKey ?? existing?.instantlyApiKey ?? null,
    apolloApiKey: patch.apolloApiKey ?? existing?.apolloApiKey ?? null,
    serperApiKey: patch.serperApiKey ?? existing?.serperApiKey ?? null,
    openaiApiKey: patch.openaiApiKey ?? existing?.openaiApiKey ?? null,
    anthropicApiKey: patch.anthropicApiKey ?? existing?.anthropicApiKey ?? null,
    elevenlabsApiKey: patch.elevenlabsApiKey ?? existing?.elevenlabsApiKey ?? null,
    linkedinCdpUrl: patch.linkedinCdpUrl ?? existing?.linkedinCdpUrl ?? null,
    apolloMode: patch.apolloMode ?? existing?.apolloMode ?? 'shared',
    serperMode: patch.serperMode ?? existing?.serperMode ?? 'shared',
    instantlyMode: patch.instantlyMode ?? existing?.instantlyMode ?? 'shared',
    openaiMode: patch.openaiMode ?? existing?.openaiMode ?? 'shared',
    anthropicMode: patch.anthropicMode ?? existing?.anthropicMode ?? 'shared',
    elevenlabsMode: patch.elevenlabsMode ?? existing?.elevenlabsMode ?? 'shared',
    updatedAt: Date.now(),
  };
  database
    .prepare(
      `INSERT INTO company_integrations (
        company_id, zadarma_api_key, zadarma_api_secret, zadarma_caller_number, zadarma_sip, zadarma_widget_sip,
        instantly_api_key, apollo_api_key, serper_api_key, openai_api_key, anthropic_api_key, elevenlabs_api_key,
        linkedin_cdp_url, apollo_mode, serper_mode, instantly_mode, openai_mode, anthropic_mode, elevenlabs_mode,
        updated_at
      ) VALUES (@companyId, @zadarmaApiKey, @zadarmaApiSecret, @zadarmaCallerNumber, @zadarmaSip, @zadarmaWidgetSip,
        @instantlyApiKey, @apolloApiKey, @serperApiKey, @openaiApiKey, @anthropicApiKey, @elevenlabsApiKey,
        @linkedinCdpUrl, @apolloMode, @serperMode, @instantlyMode, @openaiMode, @anthropicMode, @elevenlabsMode,
        @updatedAt)
      ON CONFLICT(company_id) DO UPDATE SET
        zadarma_api_key = excluded.zadarma_api_key,
        zadarma_api_secret = excluded.zadarma_api_secret,
        zadarma_caller_number = excluded.zadarma_caller_number,
        zadarma_sip = excluded.zadarma_sip,
        zadarma_widget_sip = excluded.zadarma_widget_sip,
        instantly_api_key = excluded.instantly_api_key,
        apollo_api_key = excluded.apollo_api_key,
        serper_api_key = excluded.serper_api_key,
        openai_api_key = excluded.openai_api_key,
        anthropic_api_key = excluded.anthropic_api_key,
        elevenlabs_api_key = excluded.elevenlabs_api_key,
        linkedin_cdp_url = excluded.linkedin_cdp_url,
        apollo_mode = excluded.apollo_mode,
        serper_mode = excluded.serper_mode,
        instantly_mode = excluded.instantly_mode,
        openai_mode = excluded.openai_mode,
        anthropic_mode = excluded.anthropic_mode,
        elevenlabs_mode = excluded.elevenlabs_mode,
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
 * button is the only caller. Deliberately excludes the six *Mode fields —
 * unlike a secret, a mode is a NOT NULL enum column always sent as an
 * explicit value from the Shared/Individual toggle, never a "some value
 * exists but isn't re-sent" secret, so "clear it" has no meaning for it. */
export type ClearableIntegrationField = Exclude<
  keyof CompanyIntegrationsPatch,
  'apolloMode' | 'serperMode' | 'instantlyMode' | 'openaiMode' | 'anthropicMode' | 'elevenlabsMode'
>;

export function clearCompanyIntegrationField(companyId: string, field: ClearableIntegrationField): CompanyIntegrations {
  const columnByField: Record<ClearableIntegrationField, string> = {
    zadarmaApiKey: 'zadarma_api_key',
    zadarmaApiSecret: 'zadarma_api_secret',
    zadarmaCallerNumber: 'zadarma_caller_number',
    zadarmaSip: 'zadarma_sip',
    zadarmaWidgetSip: 'zadarma_widget_sip',
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
  /** Per-worker Zadarma overrides — see the migration's own comment above.
   * null/unset means "fall back to the company-wide or process.env value";
   * see index.ts's GET /api/webrtc/key and POST /api/callback. */
  zadarmaSip: string | null;
  zadarmaWidgetSip: string | null;
  zadarmaCallerNumber: string | null;
  /** Per-worker overrides for the remaining plain-API-key integrations —
   * see the migration's own comment above. null/unset means "fall back to
   * this company's company_integrations value"; see index.ts's requireXKey()
   * helpers. LinkedIn's CDP URL deliberately has no per-worker equivalent —
   * see the migration comment for why. */
  instantlyApiKey: string | null;
  apolloApiKey: string | null;
  serperApiKey: string | null;
  openaiApiKey: string | null;
  anthropicApiKey: string | null;
  elevenlabsApiKey: string | null;
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
  zadarma_sip: string | null;
  zadarma_widget_sip: string | null;
  zadarma_caller_number: string | null;
  instantly_api_key: string | null;
  apollo_api_key: string | null;
  serper_api_key: string | null;
  openai_api_key: string | null;
  anthropic_api_key: string | null;
  elevenlabs_api_key: string | null;
}

function userFromRow(r: UserRow): User {
  return {
    id: r.id,
    companyId: r.company_id,
    username: r.username,
    firstName: r.first_name,
    lastName: r.last_name,
    role: r.role as Role,
    // Same reasoning as parseJsonArray above (see its own doc comment) —
    // a malformed value here must not crash login, just fall back to null
    // (== "no restriction beyond the role's own defaults" everywhere this
    // field is read), same as it already does when the column is empty.
    visibleTabs: (() => {
      if (!r.visible_tabs) return null;
      try {
        return JSON.parse(r.visible_tabs);
      } catch {
        return null;
      }
    })(),
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
    zadarmaSip: r.zadarma_sip,
    zadarmaWidgetSip: r.zadarma_widget_sip,
    zadarmaCallerNumber: r.zadarma_caller_number,
    instantlyApiKey: r.instantly_api_key,
    apolloApiKey: r.apollo_api_key,
    serperApiKey: r.serper_api_key,
    openaiApiKey: r.openai_api_key,
    anthropicApiKey: r.anthropic_api_key,
    elevenlabsApiKey: r.elevenlabs_api_key,
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
  zadarmaSip?: string | null;
  zadarmaWidgetSip?: string | null;
  zadarmaCallerNumber?: string | null;
  instantlyApiKey?: string | null;
  apolloApiKey?: string | null;
  serperApiKey?: string | null;
  openaiApiKey?: string | null;
  anthropicApiKey?: string | null;
  elevenlabsApiKey?: string | null;
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
        created_at, zadarma_sip, zadarma_widget_sip, zadarma_caller_number,
        instantly_api_key, apollo_api_key, serper_api_key, openai_api_key, anthropic_api_key, elevenlabs_api_key
      ) VALUES (@id, @companyId, @username, @passwordHash, @firstName, @lastName, @role, @visibleTabs,
        @canDeleteRows, @canDeleteColumns, @canDeleteNotes, @canEditContacts, @canDeleteContacts, @canExportImport,
        @canInsertRows, @canInsertColumns, @canHideRowsColumns, @canClearContent,
        @createdAt, @zadarmaSip, @zadarmaWidgetSip, @zadarmaCallerNumber,
        @instantlyApiKey, @apolloApiKey, @serperApiKey, @openaiApiKey, @anthropicApiKey, @elevenlabsApiKey)`,
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
      zadarmaSip: input.zadarmaSip ?? null,
      zadarmaWidgetSip: input.zadarmaWidgetSip ?? null,
      zadarmaCallerNumber: input.zadarmaCallerNumber ?? null,
      instantlyApiKey: input.instantlyApiKey ?? null,
      apolloApiKey: input.apolloApiKey ?? null,
      serperApiKey: input.serperApiKey ?? null,
      openaiApiKey: input.openaiApiKey ?? null,
      anthropicApiKey: input.anthropicApiKey ?? null,
      elevenlabsApiKey: input.elevenlabsApiKey ?? null,
    });
  return getUserById(id)!;
}

export function listWorkers(companyId: string): User[] {
  const rows = getDb()
    .prepare(`SELECT * FROM users WHERE company_id = ? AND role = 'worker' ORDER BY created_at ASC`)
    .all(companyId) as UserRow[];
  return rows.map(userFromRow);
}

/** Exactly one per company in every reachable flow today — createCompany
 * is only ever called from POST /api/register and
 * bootstrapFirstCompanyIfNeeded, each immediately followed by creating
 * exactly one role: 'super_admin' user, and nothing else in this codebase
 * creates a company or promotes a second super_admin. Used by
 * tableData/db.ts's per-table-ownership migration/backfill and by
 * instantlyReplySync.ts's system-created "Visi atsakymai" table — both
 * contexts with no acting user of their own, where "this company's own
 * admin" is the correct default owner. Returns null rather than throwing
 * if that invariant were ever violated (e.g. a manual DB edit) — those
 * callers all run in migration/webhook contexts where "skip it" beats
 * "crash the whole request." */
export function getCompanySuperAdmin(companyId: string): User | null {
  const row = getDb().prepare(`SELECT * FROM users WHERE company_id = ? AND role = 'super_admin' LIMIT 1`).get(companyId) as
    | UserRow
    | undefined;
  return row ? userFromRow(row) : null;
}

export interface UpdateWorkerInput {
  /** Renaming a worker in place (e.g. a departing "Ivan" replaced by a new
   * hire "Sergey" reusing the same login, on explicit request — so the
   * per-worker Zadarma/API-key integration setup below doesn't need to be
   * redone for every turnover) is safe by construction: `id` never
   * changes, only these two columns do, so every existing row keyed by
   * `id` (Zadarma/API overrides right below, and every note/comment
   * already written) is completely unaffected. Note history in particular
   * already stores the author's name as a permanent snapshot on each
   * entry at write time (see app/src/utils/noteHistory.ts's
   * NoteEntry.authorName) rather than re-resolving it live from this
   * table — so past comments correctly keep showing "Ivan" after this
   * rename, and only a *new* comment written after it picks up "Sergey".
   * Omitted leaves the existing value unchanged; firstName specifically
   * never accepts a blank result (a worker must always have some name),
   * mirroring how it's already required, non-blank at creation. */
  firstName?: string;
  lastName?: string;
  visibleTabs?: string[];
  permissions?: Partial<UserPermissions>;
  /** Plain text, hashed here — omitted (not empty string) means "leave the
   * existing password unchanged", the same "omitted field ≠ blank field"
   * convention accounts/db.ts's own company-integrations patch and
   * index.ts's route validation already use elsewhere, since a worker's
   * super-admin reprints the whole edit form on every save and shouldn't
   * accidentally wipe a password just by leaving that one field blank. */
  password?: string;
  /** Same "omitted ≠ blank" convention as password above: omitted leaves
   * the existing value unchanged; an explicit '' or null clears back to the
   * company/env-wide fallback (see index.ts's GET /api/webrtc/key and
   * POST /api/callback). */
  zadarmaSip?: string | null;
  zadarmaWidgetSip?: string | null;
  zadarmaCallerNumber?: string | null;
  instantlyApiKey?: string | null;
  apolloApiKey?: string | null;
  serperApiKey?: string | null;
  openaiApiKey?: string | null;
  anthropicApiKey?: string | null;
  elevenlabsApiKey?: string | null;
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
  const nextFirstName = input.firstName !== undefined && input.firstName.trim() ? input.firstName.trim() : current.firstName;
  const nextLastName = input.lastName !== undefined ? input.lastName.trim() : current.lastName;
  const nextTabs = input.visibleTabs ?? current.visibleTabs ?? [];
  const nextPerms = { ...current.permissions, ...input.permissions };
  const nextPasswordHash = input.password ? hashPassword(input.password) : existing.password_hash;
  const nextZadarmaSip = input.zadarmaSip !== undefined ? input.zadarmaSip || null : current.zadarmaSip;
  const nextZadarmaWidgetSip =
    input.zadarmaWidgetSip !== undefined ? input.zadarmaWidgetSip || null : current.zadarmaWidgetSip;
  const nextZadarmaCallerNumber =
    input.zadarmaCallerNumber !== undefined ? input.zadarmaCallerNumber || null : current.zadarmaCallerNumber;
  const nextInstantlyApiKey = input.instantlyApiKey !== undefined ? input.instantlyApiKey || null : current.instantlyApiKey;
  const nextApolloApiKey = input.apolloApiKey !== undefined ? input.apolloApiKey || null : current.apolloApiKey;
  const nextSerperApiKey = input.serperApiKey !== undefined ? input.serperApiKey || null : current.serperApiKey;
  const nextOpenaiApiKey = input.openaiApiKey !== undefined ? input.openaiApiKey || null : current.openaiApiKey;
  const nextAnthropicApiKey = input.anthropicApiKey !== undefined ? input.anthropicApiKey || null : current.anthropicApiKey;
  const nextElevenlabsApiKey =
    input.elevenlabsApiKey !== undefined ? input.elevenlabsApiKey || null : current.elevenlabsApiKey;
  database
    .prepare(
      `UPDATE users SET first_name = ?, last_name = ?, visible_tabs = ?, password_hash = ?, can_delete_rows = ?, can_delete_columns = ?, can_delete_notes = ?, can_edit_contacts = ?, can_delete_contacts = ?, can_export_import = ?,
       can_insert_rows = ?, can_insert_columns = ?, can_hide_rows_columns = ?, can_clear_content = ?,
       zadarma_sip = ?, zadarma_widget_sip = ?, zadarma_caller_number = ?,
       instantly_api_key = ?, apollo_api_key = ?, serper_api_key = ?, openai_api_key = ?, anthropic_api_key = ?, elevenlabs_api_key = ?
       WHERE id = ? AND company_id = ?`,
    )
    .run(
      nextFirstName,
      nextLastName,
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
      nextZadarmaSip,
      nextZadarmaWidgetSip,
      nextZadarmaCallerNumber,
      nextInstantlyApiKey,
      nextApolloApiKey,
      nextSerperApiKey,
      nextOpenaiApiKey,
      nextAnthropicApiKey,
      nextElevenlabsApiKey,
      userId,
      companyId,
    );
  return getUserById(userId);
}

export function deleteWorker(userId: string, companyId: string): void {
  getDb().prepare(`DELETE FROM users WHERE id = ? AND company_id = ? AND role = 'worker'`).run(userId, companyId);
}

export interface UpdateSuperAdminInput {
  username?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
}

/** Platform-admin-only counterpart to updateWorker above, for the account
 * that function's own role='worker' scoping deliberately excludes. A
 * company's super_admin had no recovery path of their own until this: a
 * super_admin can already reset a forgotten *worker* password (see
 * updateWorker's doc comment), but nothing could reset a super_admin's
 * own — same "no email on file, no recovery question" gap, one level up.
 * Only username/password/name are editable here — never role or
 * companyId, and never more than the one super_admin row a company
 * actually has. */
export function updateCompanySuperAdmin(companyId: string, input: UpdateSuperAdminInput): User | null {
  const database = getDb();
  const existing = database.prepare(`SELECT * FROM users WHERE company_id = ? AND role = 'super_admin' LIMIT 1`).get(companyId) as
    | UserRow
    | undefined;
  if (!existing) return null;
  const nextUsername = input.username !== undefined && input.username.trim() ? input.username.trim() : existing.username;
  const nextFirstName = input.firstName !== undefined && input.firstName.trim() ? input.firstName.trim() : existing.first_name;
  const nextLastName = input.lastName !== undefined ? input.lastName.trim() : existing.last_name;
  const nextPasswordHash = input.password ? hashPassword(input.password) : existing.password_hash;
  database
    .prepare(`UPDATE users SET username = ?, first_name = ?, last_name = ?, password_hash = ? WHERE id = ? AND company_id = ?`)
    .run(nextUsername, nextFirstName, nextLastName, nextPasswordHash, existing.id, companyId);
  return getUserById(existing.id);
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

// --- Permission registry: who holds which key ---------------------------
// See permissions/registry.ts for the fixed catalog of keys (the "what's
// possible" — code) and permissions/effective.ts for how a 'company' row
// here and a 'user' row here combine into one worker's live effective set
// (the "who has what right now" — always computed fresh, never cached).

export type PermissionSubjectType = 'company' | 'user';

/** Every key currently granted directly to one subject — for a company,
 * this IS that company's ceiling (see effective.ts's companyCeiling); for
 * a user, this is their own grant, only meaningful once intersected with
 * their company's ceiling. Order is irrelevant — always consumed as a Set
 * by the caller. */
export function listGrantedKeys(subjectType: PermissionSubjectType, subjectId: string): PermissionKey[] {
  const rows = getDb()
    .prepare(`SELECT permission_key FROM permission_grants WHERE subject_type = ? AND subject_id = ?`)
    .all(subjectType, subjectId) as { permission_key: string }[];
  return rows.map((r) => r.permission_key as PermissionKey);
}

/** Blind overwrite of one subject's ENTIRE granted set in a single
 * transaction — the permission-panel UI always submits the complete
 * checked set, same "whole list, not a delta" shape as updateWorker's
 * visibleTabs/updateCompanyFeatures elsewhere in this file. `grantedBy` is
 * the acting user's id, or the literal 'platform' for the one-time startup
 * migration's own seed (see migratePermissionsIfNeeded below) — never a
 * real user id for that specific case, so it stays visually distinct in
 * the audit log. Unknown keys are the caller's responsibility to reject
 * before calling this (see index.ts's route validation) — this function
 * trusts its input, same as every other blind-overwrite function in this
 * file (updateCompanyFeatures, upsertCompanyIntegrations). */
export function setGrantedKeys(subjectType: PermissionSubjectType, subjectId: string, keys: PermissionKey[], grantedBy: string): void {
  const database = getDb();
  const tx = database.transaction((keysToInsert: PermissionKey[]) => {
    database.prepare(`DELETE FROM permission_grants WHERE subject_type = ? AND subject_id = ?`).run(subjectType, subjectId);
    const insert = database.prepare(
      `INSERT INTO permission_grants (id, subject_type, subject_id, permission_key, granted_at, granted_by) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const key of keysToInsert) insert.run(randomUUID(), subjectType, subjectId, key, now, grantedBy);
  });
  tx(keys);
}

/** Removes every permission_grants row for a subject — the counterpart
 * setGrantedKeys([], ...) would already achieve, but named separately for
 * callers that mean "this subject is gone" (e.g. deleteWorker) rather than
 * "this subject now explicitly holds zero permissions." Both end in the
 * same DB state; the distinction is only for readability at the call
 * site. */
export function clearGrantedKeys(subjectType: PermissionSubjectType, subjectId: string): void {
  getDb().prepare(`DELETE FROM permission_grants WHERE subject_type = ? AND subject_id = ?`).run(subjectType, subjectId);
}

// --- Audit log ------------------------------------------------------------
// Append-only — no update/delete function exists anywhere in this file on
// purpose, matching the requirement that this log can never be edited from
// any UI, including the platform Admin dashboard's own.

export interface AuditLogEntry {
  id: string;
  at: number;
  actorUserId: string | null;
  actorRole: string | null;
  companyId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: Record<string, unknown> | null;
}

interface AuditLogRow {
  id: string;
  at: number;
  actor_user_id: string | null;
  actor_role: string | null;
  company_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string | null;
}

function auditLogFromRow(r: AuditLogRow): AuditLogEntry {
  let detail: Record<string, unknown> | null = null;
  if (r.detail) {
    try {
      detail = JSON.parse(r.detail);
    } catch {
      detail = null;
    }
  }
  return {
    id: r.id,
    at: r.at,
    actorUserId: r.actor_user_id,
    actorRole: r.actor_role,
    companyId: r.company_id,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    detail,
  };
}

export interface AppendAuditLogInput {
  actorUserId: string | null;
  actorRole: string | null;
  companyId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  detail?: Record<string, unknown> | null;
}

export function appendAuditLog(input: AppendAuditLogInput): void {
  getDb()
    .prepare(
      `INSERT INTO audit_log (id, at, actor_user_id, actor_role, company_id, action, target_type, target_id, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(),
      Date.now(),
      input.actorUserId,
      input.actorRole,
      input.companyId,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.detail ? JSON.stringify(input.detail) : null,
    );
}

/** Platform Super Super Admin sees every company's log (companyId
 * omitted); a company's own super_admin sees only their own — same
 * optional-filter shape as listLoginLog/listWorkerActions elsewhere in
 * this codebase. */
export function listAuditLog(companyId: string | undefined, limit: number): AuditLogEntry[] {
  const rows = companyId
    ? (getDb().prepare(`SELECT * FROM audit_log WHERE company_id = ? ORDER BY at DESC LIMIT ?`).all(companyId, limit) as AuditLogRow[])
    : (getDb().prepare(`SELECT * FROM audit_log ORDER BY at DESC LIMIT ?`).all(limit) as AuditLogRow[]);
  return rows.map(auditLogFromRow);
}

// --- One-time migration: booleans/env vars → permission_grants rows -----

function isPermissionMigrationDone(): boolean {
  const row = getDb().prepare(`SELECT 1 FROM permission_migration_done WHERE id = 1`).get();
  return !!row;
}

function markPermissionMigrationDone(): void {
  getDb().prepare(`INSERT OR IGNORE INTO permission_migration_done (id, done_at) VALUES (1, ?)`).run(Date.now());
}

/** Run once, ever, at startup (see index.ts's boot sequence, alongside
 * bootstrapFirstCompanyIfNeeded/demoteOwnerUsers) — converts today's fixed
 * boolean/role model into permission_grants rows with ZERO behavior
 * change, so deploy day loses nobody any access (the account owner's own
 * explicit, hard requirement):
 *
 *   - Every existing company's CEILING (subject_type='company') is seeded
 *     to the full PERMISSIONS set — today, a company's own super_admin can
 *     implicitly do everything (there's no company-level restriction
 *     concept at all yet), so this makes that literally, explicitly true
 *     going forward rather than changing it.
 *   - Every existing worker's ten UserPermissions booleans are translated
 *     1:1 into their own subject_type='user' rows via
 *     LEGACY_BOOLEAN_PERMISSION_MAP — a worker who could delete rows
 *     before still can after, nothing else changes. Workers get NO
 *     integration/admin keys here (those didn't exist as booleans before —
 *     see the isolation-matrix audit finding this whole task started
 *     from), matching today's actual behavior where a worker's own
 *     apolloApiKey/etc. override is the only thing that ever gated
 *     per-worker integration access.
 *
 * Guarded by permission_migration_done (see above), not a derived "has
 * zero rows" check — a worker legitimately revoked down to nothing must
 * stay at nothing across a restart, not get silently re-seeded. */
export function migratePermissionsIfNeeded(): void {
  if (isPermissionMigrationDone()) return;
  const database = getDb();
  const tx = database.transaction(() => {
    const companies = database.prepare(`SELECT id FROM companies`).all() as { id: string }[];
    for (const { id } of companies) {
      setGrantedKeys('company', id, ALL_PERMISSION_KEYS, 'platform');
    }
    const workers = database.prepare(`SELECT * FROM users WHERE role = 'worker'`).all() as UserRow[];
    for (const row of workers) {
      const user = userFromRow(row);
      const keys: PermissionKey[] = [];
      for (const [boolField, permKey] of Object.entries(LEGACY_BOOLEAN_PERMISSION_MAP) as [keyof UserPermissions, PermissionKey][]) {
        if (user.permissions[boolField]) keys.push(permKey);
      }
      setGrantedKeys('user', user.id, keys, 'platform');
    }
    markPermissionMigrationDone();
  });
  tx();
}
