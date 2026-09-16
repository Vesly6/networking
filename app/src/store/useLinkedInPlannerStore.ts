import { create } from 'zustand';
import {
  fetchPlannerTasks,
  fetchPlannerTodayCount,
  sendPlannerTask,
  markPlannerTaskNotConfirmed,
  schedulePlannerTask,
  PLANNER_PAGE_SIZE,
  type PlannerTask,
  type PlannerListFilter,
} from '../utils/linkedinPlannerApi';

interface LinkedInPlannerState {
  tasks: PlannerTask[];
  total: number;
  hasMore: boolean;
  loadingMore: boolean;
  ready: boolean;
  error: string | null;
  filter: PlannerListFilter;
  search: string;
  /** Narrows the list to one table — null means every accessible table.
   * On explicit request: without this, a super_admin (or anyone with
   * linkedin_planner.view_all) sees every table's people mixed into one
   * list, which stops being usable once a company has more than a
   * couple of tables — "select which table to work, see just that
   * table's people." */
  tableFilter: string | null;
  /** "Žiūrėti kaip darbuotoją" — super_admin/view_all only (the server
   * 403s this for anyone else): check exactly which contacts a SPECIFIC
   * worker still hasn't sent to (Siuntimui) or already has (Išsiųsta),
   * instead of only ever seeing your OWN personal split. null means "my
   * own," same as not passing the param at all. */
  workerFilter: string | null;
  /** The header's "Šiandien: N iš M" counter — a dedicated count, not
   * derived from whatever's currently loaded/filtered (the default
   * 'queue' filter never even includes already-sent tasks, so deriving
   * it from `tasks` would always read 0). */
  sentToday: number;
  dailyLimit: number;
  refreshTodayCount: () => Promise<void>;
  setFilter: (filter: PlannerListFilter) => void;
  setSearch: (search: string) => void;
  setTableFilter: (tableId: string | null) => void;
  setWorkerFilter: (workerId: string | null) => void;
  /** Resets to page 0 — used on mount and whenever filter/search changes. */
  refresh: () => Promise<void>;
  /** Appends the next page — real scale here can be thousands of tasks
   * per company, so the list is paginated server-side, not loaded whole. */
  loadMore: () => Promise<void>;
  /** Per-task in-flight keys for both actions below, not a single shared
   * one — see CLAUDE.md's own note on this exact pattern (useCallsStore's
   * transcribingIds, ApolloContactSearchModal's addingPersonIds): a single
   * shared "busy" flag would make clicking a second task's button
   * visually re-enable the first one's while it's still in flight. */
  changingStatusIds: Set<string>;
  /** Siuntimui's own combined action — one click both opens the profile
   * (LinkedInPlannerView.tsx's own <a>) and records THIS worker's own
   * send here. Sending is per-worker (see PlannerTaskSender's own doc
   * comment): any worker with access to the task's table can send their
   * own connect request regardless of who else already has — worker A
   * having sent never hides or blocks worker B's own action. */
  sendConnect: (taskId: string) => Promise<void>;
  /** The one action available in Išsiųsta — "Nepatvirtino" replaces the
   * old accepted/declined/no_response/replied/skipped dropdown entirely
   * (on explicit request). Reverses only the CURRENT worker's own send,
   * back into their own Siuntimui; every other worker's send on the same
   * task is untouched. The returned task carries the server's own
   * incremented notConfirmedCount and updated senders list. */
  markNotConfirmed: (taskId: string) => Promise<void>;
  schedule: (taskId: string, date: string | null) => Promise<void>;
}

export const useLinkedInPlannerStore = create<LinkedInPlannerState>((set, get) => ({
  tasks: [],
  total: 0,
  hasMore: false,
  loadingMore: false,
  ready: false,
  error: null,
  filter: 'queue',
  search: '',
  tableFilter: null,
  workerFilter: null,
  sentToday: 0,
  dailyLimit: 20,

  refreshTodayCount: async () => {
    try {
      const { sentToday, dailyLimit } = await fetchPlannerTodayCount();
      set({ sentToday, dailyLimit });
    } catch {
      // Non-critical — the counter just stays at its last known value,
      // same "badge stays stale rather than erroring loudly" convention
      // as this app's other ambient nav counters (e.g. Unibox's own
      // refreshUnreadCount).
    }
  },

  setFilter: (filter) => {
    set({ filter });
    void get().refresh();
  },
  setSearch: (search) => {
    set({ search });
    void get().refresh();
  },
  setTableFilter: (tableId) => {
    set({ tableFilter: tableId });
    void get().refresh();
  },
  setWorkerFilter: (workerId) => {
    set({ workerFilter: workerId });
    void get().refresh();
  },

  refresh: async () => {
    set({ error: null });
    try {
      const { filter, search, tableFilter, workerFilter } = get();
      const page = await fetchPlannerTasks(filter, search, 0, tableFilter, workerFilter);
      set({ tasks: page.tasks, total: page.total, hasMore: page.hasMore, ready: true });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko įkelti planuoklio', ready: true });
    }
  },

  loadMore: async () => {
    const { hasMore, loadingMore, filter, search, tableFilter, workerFilter, tasks } = get();
    if (!hasMore || loadingMore) return;
    set({ loadingMore: true });
    try {
      const nextPage = Math.floor(tasks.length / PLANNER_PAGE_SIZE);
      const page = await fetchPlannerTasks(filter, search, nextPage, tableFilter, workerFilter);
      set({ tasks: [...tasks, ...page.tasks], total: page.total, hasMore: page.hasMore });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko įkelti daugiau užduočių' });
    } finally {
      set({ loadingMore: false });
    }
  },

  changingStatusIds: new Set(),

  sendConnect: async (taskId) => {
    set((s) => ({ changingStatusIds: new Set(s.changingStatusIds).add(taskId) }));
    try {
      const { task: updated } = await sendPlannerTask(taskId);
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, ...updated } : t)) }));
      if (get().filter !== 'all') void get().refresh();
      void get().refreshTodayCount();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko pažymėti kaip išsiųsto' });
    } finally {
      set((s) => {
        const next = new Set(s.changingStatusIds);
        next.delete(taskId);
        return { changingStatusIds: next };
      });
    }
  },

  markNotConfirmed: async (taskId) => {
    set((s) => ({ changingStatusIds: new Set(s.changingStatusIds).add(taskId) }));
    try {
      const { task: updated } = await markPlannerTaskNotConfirmed(taskId);
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, ...updated } : t)) }));
      // Moves the task back into Siuntimui — refresh so a currently-open
      // Išsiųsta view drops it immediately instead of showing a stale row.
      if (get().filter !== 'all') void get().refresh();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko pažymėti nepatvirtinta' });
    } finally {
      set((s) => {
        const next = new Set(s.changingStatusIds);
        next.delete(taskId);
        return { changingStatusIds: next };
      });
    }
  },

  schedule: async (taskId, date) => {
    try {
      await schedulePlannerTask(taskId, date);
      set((s) => ({ tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, scheduledDate: date } : t)) }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko suplanuoti datos' });
    }
  },
}));
