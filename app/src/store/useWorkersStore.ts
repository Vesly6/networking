import { create } from 'zustand';
import { localApiRequest } from '../utils/localApi';
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
}

interface CreateWorkerInput {
  username: string;
  password: string;
  firstName: string;
  lastName: string;
  visibleTabs: string[];
  permissions: Partial<UserPermissions>;
}

interface UpdateWorkerInput {
  visibleTabs?: string[];
  permissions?: Partial<UserPermissions>;
  /** Omitted (not empty string) leaves the worker's existing password
   * unchanged — same convention the server's updateWorker() itself uses,
   * see that function's own doc comment. */
  password?: string;
}

interface WorkersState {
  workers: Worker[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  create: (input: CreateWorkerInput) => Promise<void>;
  update: (id: string, input: UpdateWorkerInput) => Promise<void>;
  remove: (id: string) => Promise<void>;

  /** Company-wide when userId is omitted, one worker's own history
   * otherwise — WorkersView's activity-history section drives both from
   * the same action, switching userId as the selected worker changes. */
  actions: WorkerActionLogEntry[];
  actionsLoading: boolean;
  actionsError: string | null;
  loadActions: (userId?: string) => Promise<void>;
}

/** Same "stores own data, components own side effects" convention as
 * every other store in this app (useCallsStore etc.) — this doesn't call
 * showToast itself, WorkersView watches `error` and toasts. */
export const useWorkersStore = create<WorkersState>((set, get) => ({
  workers: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const { workers } = await localApiRequest<{ workers: Worker[] }>('/api/workers');
      set({ workers, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Nepavyko įkelti darbuotojų' });
    }
  },

  create: async (input) => {
    const worker = await localApiRequest<Worker>('/api/workers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    set({ workers: [...get().workers, worker] });
  },

  update: async (id, input) => {
    const worker = await localApiRequest<Worker>(`/api/workers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    set({ workers: get().workers.map((w) => (w.id === id ? worker : w)) });
  },

  remove: async (id) => {
    await localApiRequest(`/api/workers/${encodeURIComponent(id)}`, { method: 'DELETE' });
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
