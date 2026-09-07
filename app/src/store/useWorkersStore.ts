import { create } from 'zustand';
import { localApiRequest } from '../utils/localApi';
import { superAdminApiRequest } from '../utils/superAdminApi';
import type { AuthUser, UserPermissions } from './useAuthStore';

export type Worker = Omit<AuthUser, 'company'>;

export type WorkerActionType = 'row_created' | 'cell_edited' | 'note_added' | 'contact_added';

/** Mirrors server/src/tableData/db.ts's WorkerActionLogEntry exactly. */
export interface WorkerActionLogEntry {
  id: string;
  userId: string;
  userName: string;
  actionType: WorkerActionType;
  tableId: string;
  tableName: string;
  rowId: string;
  columnId?: string;
  columnName?: string;
  contactId?: string;
  detail: string;
  createdAt: number;
  /** Set only when a company super_admin performed this action while
   * impersonating the worker named above (userId/userName) — see
   * useAuthStore.ts's impersonateWorker and server/src/auth.ts's
   * AuthContext.actingAs. */
  realUserId?: string;
  realUserName?: string;
}

/** One optional field per per-worker integration override — Zadarma's own
 * three, plus one plain API key per remaining integration (see
 * server/src/accounts/db.ts's per-worker migrations). Shared by both
 * Create/UpdateWorkerInput below rather than repeating the same nine
 * fields twice. LinkedIn's CDP URL has no per-worker equivalent — see that
 * migration's own doc comment for why. */
interface WorkerIntegrationOverrides {
  zadarmaSip?: string;
  zadarmaWidgetSip?: string;
  zadarmaCallerNumber?: string;
  instantlyApiKey?: string;
  apolloApiKey?: string;
  serperApiKey?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  elevenlabsApiKey?: string;
}

interface CreateWorkerInput extends WorkerIntegrationOverrides {
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  visibleTabs: string[];
  permissions: Partial<UserPermissions>;
}

interface UpdateWorkerInput extends WorkerIntegrationOverrides {
  /** Renaming a worker in place (e.g. a departing "Ivan" replaced by a new
   * hire "Sergey" reusing the same login, so the integration overrides
   * above don't need to be reconfigured on every turnover) is safe: `id`
   * never changes, and every past note/comment already stores its
   * author's name as a permanent snapshot at write time (see
   * utils/noteHistory.ts's NoteEntry.authorName) rather than re-resolving
   * it live — so old comments correctly keep showing "Ivan" after this,
   * and only a new comment written after the rename picks up "Sergey". */
  firstName?: string;
  lastName?: string;
  visibleTabs?: string[];
  permissions?: Partial<UserPermissions>;
  /** Omitted (not empty string) leaves the worker's existing password
   * unchanged — same convention the server's updateWorker() itself uses,
   * see that function's own doc comment. */
  password?: string;
  // Every WorkerIntegrationOverrides field follows the same "omitted
  // leaves unchanged, explicit '' clears back to the company-wide
  // fallback" convention — see server/src/accounts/db.ts's updateWorker()
  // for the exact server-side handling.
}

interface WorkersState {
  workers: Worker[];
  loading: boolean;
  error: string | null;
  /** `companyId` optional on all four — omitted hits the caller's own
   * company (/api/workers, unchanged, used by a company's own super_admin
   * or the owner viewing their own company); passed (only ever from the
   * owner's Admin dashboard) hits /api/admin/companies/:id/workers
   * instead, targeting an arbitrary client — same "one store serves both
   * cases" shape as useIntegrationsStore. */
  load: (companyId?: string) => Promise<void>;
  create: (input: CreateWorkerInput, companyId?: string) => Promise<void>;
  update: (id: string, input: UpdateWorkerInput, companyId?: string) => Promise<void>;
  remove: (id: string, companyId?: string) => Promise<void>;

  /** Company-wide when userId is omitted, one worker's own history
   * otherwise — WorkersView's activity-history section drives both from
   * the same action, switching userId as the selected worker changes.
   * Always the caller's own company — the owner's cross-company Admin
   * dashboard doesn't surface this (see login_log for the owner's own,
   * separate cross-company activity view). */
  actions: WorkerActionLogEntry[];
  actionsLoading: boolean;
  actionsError: string | null;
  loadActions: (userId?: string) => Promise<void>;
}

function workersPath(companyId: string | undefined, suffix = ''): string {
  return companyId ? `/api/admin/companies/${companyId}/workers${suffix}` : `/api/workers${suffix}`;
}

/** companyId present = the independent super-admin dashboard, hitting a
 * requireSuperAdmin-gated /api/admin/* route (see server/src/auth.ts) —
 * needs the separate super-admin token, not the caller's own normal
 * session, which that route never even looks at. companyId omitted = the
 * caller's own company via the normal /api/workers route, unchanged. */
function workersRequest<T>(companyId: string | undefined, path: string, init?: RequestInit): Promise<T> {
  return companyId ? superAdminApiRequest<T>(path, init) : localApiRequest<T>(path, init);
}

/** Same "stores own data, components own side effects" convention as
 * every other store in this app (useCallsStore etc.) — this doesn't call
 * showToast itself, WorkersView watches `error` and toasts. */
export const useWorkersStore = create<WorkersState>((set, get) => ({
  workers: [],
  loading: false,
  error: null,

  load: async (companyId) => {
    set({ loading: true, error: null });
    try {
      const { workers } = await workersRequest<{ workers: Worker[] }>(companyId, workersPath(companyId));
      set({ workers, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Nepavyko įkelti darbuotojų' });
    }
  },

  create: async (input, companyId) => {
    const worker = await workersRequest<Worker>(companyId, workersPath(companyId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    set({ workers: [...get().workers, worker] });
  },

  update: async (id, input, companyId) => {
    const worker = await workersRequest<Worker>(companyId, workersPath(companyId, `/${encodeURIComponent(id)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    set({ workers: get().workers.map((w) => (w.id === id ? worker : w)) });
  },

  remove: async (id, companyId) => {
    await workersRequest(companyId, workersPath(companyId, `/${encodeURIComponent(id)}`), { method: 'DELETE' });
    set({ workers: get().workers.filter((w) => w.id !== id) });
  },

  actions: [],
  actionsLoading: false,
  actionsError: null,
  loadActions: async (userId) => {
    set({ actionsLoading: true, actionsError: null });
    try {
      const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
      const { actions } = await localApiRequest<{ actions: WorkerActionLogEntry[] }>(`/api/worker-actions${query}`);
      set({ actions, actionsLoading: false });
    } catch (err) {
      set({ actionsLoading: false, actionsError: err instanceof Error ? err.message : 'Nepavyko įkelti veiklos istorijos' });
    }
  },
}));
