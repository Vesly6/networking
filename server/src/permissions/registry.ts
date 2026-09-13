// The single source-controlled catalog of every atomic, permission-gated
// action in the app — mirrors app/src/utils/permissions.ts on the client
// (same keys/labels, kept in sync by hand since the two sides can't share
// a module across the frontend/backend boundary). Compiled from this app's
// actual existing checks: the ten UserPermissions booleans that used to be
// the only thing this app could grant (accounts/db.ts), plus the
// integration-use/api-key-management/admin-action keys this task's own
// three-tier RBAC redesign needs — see CLAUDE.md's "Multi-tenant accounts"
// section and the account owner's original security report.
//
// This is deliberately CODE, not a DB table — adding a new gated action is
// "add one line here," no migration needed. WHO holds which key is the
// part that has to be data (see accounts/db.ts's permission_grants table
// and effective.ts's live intersection computation) — that's what actually
// needs to be grantable/revocable at runtime.
export const PERMISSIONS = {
  'rows.delete': 'Trinti eilutes',
  'columns.delete': 'Trinti stulpelius',
  'notes.delete_edit': 'Trinti/redaguoti komentarus',
  'contacts.edit': 'Redaguoti kontaktus',
  'contacts.delete': 'Trinti kontaktus',
  'data.export_import': 'CSV eksportas/importas',
  'rows.insert': 'Įterpti eilutes',
  'columns.insert': 'Įterpti stulpelius',
  'rows_columns.hide': 'Slėpti eilutes/stulpelius',
  'cells.clear': 'Išvalyti langelių turinį',
  'integrations.apollo.use': 'Naudoti Apollo',
  'integrations.zadarma.use': 'Naudoti Zadarma (skambučiai, SMS)',
  'integrations.serper.use': 'Naudoti Serper (naujienos, paieška)',
  'integrations.instantly.use': 'Naudoti Instantly',
  'integrations.openai.use': 'Naudoti OpenAI funkcijas',
  'integrations.anthropic.use': 'Naudoti el. laiškų generatorių',
  'integrations.elevenlabs.use': 'Naudoti balso atpažinimą',
  // Deliberately NOT part of DEFAULT_NEW_COMPANY_KEYS below, unlike every
  // other integration key — see that constant's own doc comment.
  'integrations.linkedin.use': 'Naudoti LinkedIn automatizaciją',
  'api_keys.view': 'Matyti API raktus',
  'api_keys.edit': 'Redaguoti API raktus',
  'api_keys.set_mode': 'Keisti Shared/Individual režimą',
  // Coarse admin actions — replace the blunt requireNotWorker role check
  // with the same permission-registry granularity as everything else,
  // kept at today's existing three-way granularity deliberately (see the
  // plan's "What this pass does NOT do" — splitting further later is a
  // registry data change, not a code change).
  'workers.manage': 'Valdyti darbuotojus',
  'tables.manage': 'Valdyti lenteles (kurti/trinti/pervadinti)',
  'backups.manage': 'Valdyti atsargines kopijas',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PERMISSIONS, value);
}

/** Keys a brand-new company must NOT receive by default, unlike every
 * other key (accounts/db.ts's createCompany grants
 * DEFAULT_NEW_COMPANY_KEYS below, not the full ALL_PERMISSION_KEYS list).
 * Currently just LinkedIn: that feature is built around one single shared
 * Chrome/browser session for the *entire deployment* (see linkedin/
 * browser.ts — one module-level browser handle, one CDP connection), not
 * one session per company. Auto-granting it to every new company the
 * instant they register would let a second company's campaign trigger a
 * real LinkedIn send from the FIRST company's own logged-in account — the
 * platform grants this explicitly, per company, only once a real,
 * dedicated browser/account setup actually exists for that company. */
export const KEYS_EXCLUDED_FROM_NEW_COMPANY_DEFAULT: readonly PermissionKey[] = ['integrations.linkedin.use'];

export const DEFAULT_NEW_COMPANY_KEYS: PermissionKey[] = ALL_PERMISSION_KEYS.filter(
  (key) => !KEYS_EXCLUDED_FROM_NEW_COMPANY_DEFAULT.includes(key),
);

/** The 1:1 rename mapping from today's fixed UserPermissions booleans
 * (accounts/db.ts) onto the new registry keys — used exactly once, by the
 * startup migration that converts every existing worker's boolean columns
 * into permission_grants rows. Never used for anything else: once the
 * migration has run, the boolean columns and the registry are two
 * independent representations kept for one release (see the plan), not a
 * live mapping either side reads from at request time. */
export const LEGACY_BOOLEAN_PERMISSION_MAP = {
  canDeleteRows: 'rows.delete',
  canDeleteColumns: 'columns.delete',
  canDeleteNotes: 'notes.delete_edit',
  canEditContacts: 'contacts.edit',
  canDeleteContacts: 'contacts.delete',
  canExportImport: 'data.export_import',
  canInsertRows: 'rows.insert',
  canInsertColumns: 'columns.insert',
  canHideRowsColumns: 'rows_columns.hide',
  canClearContent: 'cells.clear',
} as const satisfies Record<string, PermissionKey>;
