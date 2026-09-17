// Client-side mirror of server/src/permissions/registry.ts — kept in sync
// by hand (a permission-key registry changes rarely, and this app has no
// mechanism to share a module across the frontend/backend boundary). The
// backend is always the enforcement boundary regardless of what this file
// says (see every requireXKey()/requirePermission2() call in index.ts) —
// this only drives what the UI shows/greys out, same "hide the button,
// but the server independently rejects it too" split this app already
// uses everywhere else (requireNotWorker, canDeleteRows, etc.).
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
  // Deliberately not granted to a new company by default server-side (see
  // server/src/permissions/registry.ts's DEFAULT_NEW_COMPANY_KEYS) — the
  // feature is built around one single shared LinkedIn/Chrome session for
  // the whole deployment, not one per company.
  'integrations.linkedin.use': 'Naudoti LinkedIn automatizaciją',
  // LinkedIn Planner — the manual (non-automated) replacement, a
  // completely separate permission family from the retired key above.
  'linkedin_planner.view': 'Matyti LinkedIn planuoklį',
  'linkedin_planner.execute': 'Keisti savo LinkedIn planuoklio užduočių statusą',
  'linkedin_planner.view_all': 'Matyti visos įmonės LinkedIn planuoklį',
  'linkedin_planner.assign': 'Priskirti LinkedIn planuoklio užduotis',
  'linkedin_planner.templates.edit': 'Redaguoti LinkedIn žinučių šablonus',
  'api_keys.view': 'Matyti API raktus',
  'api_keys.edit': 'Redaguoti API raktus',
  'api_keys.set_mode': 'Keisti Shared/Individual režimą',
  'workers.manage': 'Valdyti darbuotojus',
  'tables.manage': 'Valdyti lenteles (kurti/trinti/pervadinti)',
  'backups.manage': 'Valdyti atsargines kopijas',
  // Separate from 'data.export_import' (CSV import only, see that key's own
  // group below) — exporting a company's full contact/email list is a
  // materially more sensitive action than importing rows.
  'export.execute': 'Eksportuoti duomenis (CSV/XLSX)',
  'export.contacts': 'Eksportuoti su kontaktais (kontaktų/el. pašto duomenimis)',
  // Team Activity Dashboard.
  'dashboard.view_own': 'Matyti savo aktyvumo statistiką',
  'dashboard.view_team': 'Matyti visos komandos aktyvumo statistiką',
  'dashboard.view_credits': 'Matyti likusius kreditus',
  'dashboard.settings.edit': 'Keisti aktyvumo skydelio nustatymus',
  'dashboard.integrations.diagnose': 'Tikrinti duomenų šaltinių būseną',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

/** Grouped for the permission-grant checkbox panels (AdminView's
 * PermissionsPanel, WorkersView) — plain UI structure, not part of the
 * registry itself. */
export const PERMISSION_GROUPS: { title: string; keys: PermissionKey[] }[] = [
  {
    title: 'Lentelės',
    keys: ['rows.delete', 'columns.delete', 'rows.insert', 'columns.insert', 'rows_columns.hide', 'cells.clear', 'data.export_import'],
  },
  { title: 'Kontaktai ir komentarai', keys: ['contacts.edit', 'contacts.delete', 'notes.delete_edit'] },
  {
    title: 'Integracijos',
    // 'integrations.linkedin.use' (the old, retired browser-automation
    // feature) deliberately has no entry here right now, on explicit
    // request — same "not appear anywhere" treatment as the 'linkedin' tab
    // itself (see tabLabels.ts's own doc comment on why that has no
    // TAB_LABELS entry). The key itself still exists in the registry
    // (server/src/permissions/registry.ts) and is functionally inert
    // either way (LINKEDIN_AUTOMATION_ENABLED 404s the routes regardless
    // of any grant) — this only hides the checkbox from this list. Re-add
    // the line (`'integrations.linkedin.use',`) if this feature ever
    // comes back.
    keys: [
      'integrations.apollo.use',
      'integrations.zadarma.use',
      'integrations.serper.use',
      'integrations.instantly.use',
      'integrations.openai.use',
      'integrations.anthropic.use',
      'integrations.elevenlabs.use',
    ],
  },
  {
    title: 'LinkedIn planuoklis',
    // 'linkedin_planner.view' deliberately has no checkbox here, on
    // explicit request — it turned out to control the exact same visible
    // effect as the "LinkedIn planuoklis" chip in "Matomos skiltys"
    // (allowedTabs, App.tsx), so having both was two redundant on/off
    // switches for one thing. The key itself is still real and still what
    // the server's own routes actually enforce (index.ts's
    // requirePermission2 calls) — DEFAULT_WORKER_PERMISSION_KEYS below
    // still grants it automatically for a brand-new worker, alongside the
    // matching tab default (tabLabels.ts's DEFAULT_WORKER_TABS), just with
    // no separate UI toggle to manage.
    keys: ['linkedin_planner.execute', 'linkedin_planner.view_all', 'linkedin_planner.assign', 'linkedin_planner.templates.edit'],
  },
  { title: 'API raktai', keys: ['api_keys.view', 'api_keys.edit', 'api_keys.set_mode'] },
  { title: 'Administravimas', keys: ['workers.manage', 'tables.manage', 'backups.manage'] },
  { title: 'Eksportas', keys: ['export.execute', 'export.contacts'] },
  {
    title: 'Aktyvumo skydelis',
    // Unlike linkedin_planner.view above, dashboard.view_own DOES get a
    // real checkbox here even though it's also pre-checked by default on
    // every new worker (DEFAULT_WORKER_PERMISSION_KEYS below) — that
    // checkbox-less shortcut turned into a real bug for linkedin_planner.view
    // (an affected worker's grant could never be inspected or fixed via the
    // UI). Keeping every dashboard.* key independently visible/toggleable
    // here avoids repeating that mistake.
    keys: ['dashboard.view_own', 'dashboard.view_team', 'dashboard.view_credits', 'dashboard.settings.edit', 'dashboard.integrations.diagnose'],
  },
];

/** Pre-checked on a brand-new worker's create form (WorkersView.tsx) —
 * same "start with a sane baseline" reasoning as tabLabels.ts's own
 * DEFAULT_WORKER_TABS (table+calendar), on explicit request: the LinkedIn
 * Planner nav item is gated purely by linkedin_planner.view (see App.tsx's
 * own doc comment — deliberately not part of the visibleTabs/companyTabs
 * chip system DEFAULT_WORKER_TABS covers), so without a form default here
 * a brand-new worker would need the admin to remember to check it by hand
 * every single time. Still just a form default, not a hardcoded grant —
 * the admin can uncheck either box before creating, and it never touches
 * an already-existing worker's own grants. */
export const DEFAULT_WORKER_PERMISSION_KEYS: PermissionKey[] = [
  'linkedin_planner.view',
  'linkedin_planner.execute',
  // Every worker sees their OWN activity dashboard numbers by default —
  // seeing teammates' numbers (dashboard.view_team) stays opt-in, per the
  // account owner's own explicit "off by default" requirement.
  'dashboard.view_own',
];

/** `permissionKeys` is undefined for a not-yet-loaded user (App.tsx's
 * !user guard already keeps most of the app from rendering before then) —
 * treated as "nothing granted" rather than throwing, same fail-closed
 * default the server's own can()/effectivePermissions() use. */
export function can(permissionKeys: PermissionKey[] | undefined, key: PermissionKey): boolean {
  return !!permissionKeys?.includes(key);
}
