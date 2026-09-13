// Demo-only worker roster — mirrors demoData.ts's own conventions exactly
// (module-level state, built once per page load, reset on every hard
// refresh/new tab so nothing one visitor does is ever visible to another).
// Exists so a demo visitor immediately sees the permission-registry system
// doing something real (three pre-seeded workers with visibly different
// grants) without having to configure anything themselves first — see
// useWorkersStore.ts's DEMO_MODE branch, the only caller of this module.
import { randomUUID } from '../utils/uuid';
import type { PermissionKey } from '../utils/permissions';
import type { Worker } from '../store/useWorkersStore';
import type { UserPermissions } from '../store/useAuthStore';

const EMPTY_PERMISSIONS: UserPermissions = {
  canDeleteRows: false,
  canDeleteColumns: false,
  canDeleteNotes: false,
  canEditContacts: false,
  canDeleteContacts: false,
  canExportImport: false,
  canInsertRows: false,
  canInsertColumns: false,
  canHideRowsColumns: false,
  canClearContent: false,
};

function seedWorker(input: {
  firstName: string;
  lastName: string;
  username: string;
  permissions: Partial<UserPermissions>;
  permissionKeys: PermissionKey[];
}): Worker {
  return {
    id: randomUUID(),
    companyId: 'demo-company',
    username: input.username,
    firstName: input.firstName,
    lastName: input.lastName,
    role: 'worker',
    visibleTabs: ['table', 'calendar'],
    permissions: { ...EMPTY_PERMISSIONS, ...input.permissions },
    grantedPermissionKeys: input.permissionKeys,
    effectivePermissionKeys: input.permissionKeys, // the demo's own ceiling is "everything" — see DEMO_USER — so a worker's grant is always fully effective, no intersection shrinks it.
    zadarmaSip: null,
    zadarmaWidgetSip: null,
    zadarmaCallerNumber: null,
    instantlyApiKeySet: false,
    apolloApiKeySet: false,
    serperApiKeySet: false,
    openaiApiKeySet: false,
    anthropicApiKeySet: false,
    elevenlabsApiKeySet: false,
  };
}

// Three workers, deliberately visibly different — a visitor opening
// "Darbuotojai" for the first time should immediately see the grant model
// doing something, not three identical-looking rows.
let workers: Worker[] = [
  seedWorker({
    firstName: 'Ona',
    lastName: 'Kazlauskienė',
    username: 'ona.k',
    permissions: { canDeleteRows: true, canInsertRows: true, canEditContacts: true, canExportImport: true },
    permissionKeys: ['rows.delete', 'rows.insert', 'contacts.edit', 'data.export_import', 'integrations.apollo.use', 'integrations.zadarma.use'],
  }),
  seedWorker({
    firstName: 'Mantas',
    lastName: 'Jankauskas',
    username: 'mantas.j',
    permissions: {},
    permissionKeys: [],
  }),
  seedWorker({
    firstName: 'Rasa',
    lastName: 'Petrauskaitė',
    username: 'rasa.p',
    permissions: { canEditContacts: true },
    permissionKeys: ['contacts.edit', 'integrations.serper.use', 'integrations.instantly.use'],
  }),
];

export function listDemoWorkers(): Worker[] {
  return workers;
}

export interface DemoCreateWorkerInput {
  username: string;
  firstName: string;
  lastName: string;
  visibleTabs: string[];
  permissions?: Partial<UserPermissions>;
  permissionKeys?: PermissionKey[];
}

export function createDemoWorker(input: DemoCreateWorkerInput): Worker {
  const worker: Worker = {
    id: randomUUID(),
    companyId: 'demo-company',
    username: input.username,
    firstName: input.firstName,
    lastName: input.lastName,
    role: 'worker',
    visibleTabs: input.visibleTabs,
    permissions: { ...EMPTY_PERMISSIONS, ...input.permissions },
    grantedPermissionKeys: input.permissionKeys ?? [],
    effectivePermissionKeys: input.permissionKeys ?? [],
    zadarmaSip: null,
    zadarmaWidgetSip: null,
    zadarmaCallerNumber: null,
    instantlyApiKeySet: false,
    apolloApiKeySet: false,
    serperApiKeySet: false,
    openaiApiKeySet: false,
    anthropicApiKeySet: false,
    elevenlabsApiKeySet: false,
  };
  workers = [...workers, worker];
  return worker;
}

export interface DemoUpdateWorkerInput {
  firstName?: string;
  lastName?: string;
  visibleTabs?: string[];
  permissions?: Partial<UserPermissions>;
  permissionKeys?: PermissionKey[];
  // Password/Zadarma/secret-key overrides are accepted (matching the real
  // UpdateWorkerInput shape WorkerForm always sends) but deliberately
  // no-op — there is no real credential store behind the demo, and
  // WorkerForm already never displays what it "saved" back for a secret.
}

export function updateDemoWorker(id: string, input: DemoUpdateWorkerInput): Worker | null {
  const existing = workers.find((w) => w.id === id);
  if (!existing) return null;
  const updated: Worker = {
    ...existing,
    firstName: input.firstName ?? existing.firstName,
    lastName: input.lastName ?? existing.lastName,
    visibleTabs: input.visibleTabs ?? existing.visibleTabs,
    permissions: input.permissions ? { ...existing.permissions, ...input.permissions } : existing.permissions,
    grantedPermissionKeys: input.permissionKeys ?? existing.grantedPermissionKeys,
    effectivePermissionKeys: input.permissionKeys ?? existing.effectivePermissionKeys,
  };
  workers = workers.map((w) => (w.id === id ? updated : w));
  return updated;
}

export function deleteDemoWorker(id: string): void {
  workers = workers.filter((w) => w.id !== id);
}
