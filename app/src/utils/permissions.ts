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
  'api_keys.view': 'Matyti API raktus',
  'api_keys.edit': 'Redaguoti API raktus',
  'api_keys.set_mode': 'Keisti Shared/Individual režimą',
  'workers.manage': 'Valdyti darbuotojus',
  'tables.manage': 'Valdyti lenteles (kurti/trinti/pervadinti)',
  'backups.manage': 'Valdyti atsargines kopijas',
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
    keys: [
      'integrations.apollo.use',
      'integrations.zadarma.use',
      'integrations.serper.use',
      'integrations.instantly.use',
      'integrations.openai.use',
      'integrations.anthropic.use',
      'integrations.elevenlabs.use',
      'integrations.linkedin.use',
    ],
  },
  { title: 'API raktai', keys: ['api_keys.view', 'api_keys.edit', 'api_keys.set_mode'] },
  { title: 'Administravimas', keys: ['workers.manage', 'tables.manage', 'backups.manage'] },
];

/** `permissionKeys` is undefined for a not-yet-loaded user (App.tsx's
 * !user guard already keeps most of the app from rendering before then) —
 * treated as "nothing granted" rather than throwing, same fail-closed
 * default the server's own can()/effectivePermissions() use. */
export function can(permissionKeys: PermissionKey[] | undefined, key: PermissionKey): boolean {
  return !!permissionKeys?.includes(key);
}
