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

export type Role = 'owner' | 'super_admin' | 'worker';

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

/** `enabled_features` is written here only to satisfy the column's NOT
 * NULL constraint (kept in the schema rather than dropped, to avoid a
 * DROP COLUMN migration) — it's never read again. What tabs a company
 * actually has is now *computed* from computeAvailableFeatures() below,
 * driven by which integrations that company has actually configured, not
 * a value anyone sets directly. See CompaniesView's removal and
 * IntegrationsView's addition (this session's own history) for why. */
export function createCompany(name: string): Company {
  const company: Company = { id: randomUUID(), name, enabledFeatures: [], createdAt: Date.now() };
  getDb()
    .prepare(`INSERT INTO companies (id, name, enabled_features, created_at) VALUES (?, ?, '[]', ?)`)
    .run(company.id, company.name, company.createdAt);
  return company;
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

/** The new replacement for the old owner-managed enabled_features
 * checkbox list — a tab is available the moment the integration it needs
 * is actually configured, nothing to toggle separately. table/calendar/
 * lessons need no external API at all, so they're always on. */
export function computeAvailableFeatures(integrations: CompanyIntegrations | null): string[] {
  const features = ['table', 'calendar', 'lessons'];
  if (!integrations) return features;
  if (integrations.zadarmaApiKey && integrations.zadarmaApiSecret) features.push('calls');
  if (integrations.instantlyApiKey) features.push('instantly');
  if (integrations.apolloApiKey) features.push('search');
  if (integrations.anthropicApiKey) features.push('email');
  if (integrations.linkedinCdpUrl) features.push('linkedin');
  return features;
}
// ---------------------------------------------------------------------

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

/** One-time startup bootstrap — if there are no users at all yet, this is
 * either a brand-new install or the very first boot after this
 * multi-tenant model replaced the old single-shared-account one. Either
 * way, today's AUTH_USERNAME/AUTH_PASSWORD becomes the 'owner' user of a
 * freshly created "Company #1", which is also what the pre-existing
 * table-data.sqlite rows get backfilled onto (see tableData/db.ts's own
 * backfillCompanyId, called right after this from index.ts's startup
 * sequence) — so the owner's existing ~7,500 real rows keep working
 * exactly as before, just now formally owned by that company. Returns the
 * owner's companyId either way (freshly created, or the existing one on
 * every later boot) so the caller can always backfill/verify against it. */
export function bootstrapOwnerIfNeeded(): { companyId: string } {
  if (countUsers() > 0) {
    const owner = getDb().prepare(`SELECT * FROM users WHERE role = 'owner'`).get() as UserRow | undefined;
    if (owner) return { companyId: owner.company_id };
  }
  const username = process.env.AUTH_USERNAME;
  const password = process.env.AUTH_PASSWORD;
  if (!username || !password) {
    throw new Error('AUTH_USERNAME/AUTH_PASSWORD are not set — check server/.env (needed for the one-time owner bootstrap)');
  }
  const company = createCompany('Company #1');
  createUser({
    companyId: company.id,
    username,
    password,
    firstName: 'Owner',
    lastName: '',
    role: 'owner',
  });
  return { companyId: company.id };
}
