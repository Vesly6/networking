import { create } from 'zustand';
import { fetchDashboardWorkerDetail, type DashboardDrillDownItem, type DashboardMetric } from '../utils/dashboardApi';
import { useDashboardStore } from './useDashboardStore';

/** The pinned "employee tasks" panel — the drill-down modal's replacement.
 * On explicit request: opening a worker's "18 comments" shouldn't mean
 * "modal → close → reopen → modal" for every single one; this panel stays
 * on screen, switches between items/metrics/workers in place, and never
 * reloads the table underneath it (the table itself is switched, when
 * needed, through the exact same jumpToTableRow/jumpToTableContact cache-
 * aware mechanism every other cross-table jump in this app already uses —
 * see this session's own table-cache work in useTableStore.ts, which is
 * what makes switching tables from inside this panel fast instead of
 * paying a full reload every time).
 *
 * Deliberately reuses useDashboardStore's own `period`/`customRange`/
 * `workers` rather than keeping a second, independent copy — the request
 * itself was explicit about this: "цифра и список должны сходиться...
 * считать из одного источника." Reading the exact same period/worker-
 * totals the dashboard cards show is what makes that guarantee automatic
 * rather than something that has to be kept in sync by hand. */

const STORAGE_KEY = 'employee-tasks-panel:v1';
const MIN_WIDTH = 260;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 340;

interface PersistedPanelState {
  isOpen: boolean;
  width: number;
  collapsed: boolean;
  workerId: string | null;
  workerName: string;
  metric: DashboardMetric | null;
  seenIds: string[];
}

function loadPersisted(): PersistedPanelState {
  const fallback: PersistedPanelState = {
    isOpen: false,
    width: DEFAULT_WIDTH,
    collapsed: false,
    workerId: null,
    workerName: '',
    metric: null,
    seenIds: [],
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      isOpen: typeof parsed.isOpen === 'boolean' ? parsed.isOpen : fallback.isOpen,
      width: typeof parsed.width === 'number' ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, parsed.width)) : fallback.width,
      collapsed: typeof parsed.collapsed === 'boolean' ? parsed.collapsed : fallback.collapsed,
      workerId: typeof parsed.workerId === 'string' ? parsed.workerId : fallback.workerId,
      workerName: typeof parsed.workerName === 'string' ? parsed.workerName : fallback.workerName,
      metric: typeof parsed.metric === 'string' ? (parsed.metric as DashboardMetric) : fallback.metric,
      seenIds: Array.isArray(parsed.seenIds) ? parsed.seenIds.filter((x: unknown) => typeof x === 'string') : fallback.seenIds,
    };
  } catch {
    return fallback;
  }
}

/** Plain, non-reactive filtering — used two ways: imperatively inside
 * store actions below (via get(), never subscribed to) AND, separately,
 * as a useMemo'd derivation in EmployeeTasksPanel.tsx itself. It is
 * deliberately NOT exposed as a store method called from a component
 * selector (`useStore((s) => s.visibleItems())`) — that shape computes a
 * brand new array on every single call, which Zustand's snapshot
 * comparison sees as "the store changed" on every render, which
 * re-renders, which calls it again: a real, reproduced infinite loop
 * ("Maximum update depth exceeded"), not a hypothetical one. */
function computeVisibleItems(state: {
  items: DashboardDrillDownItem[];
  searchText: string;
  onlyUnseen: boolean;
  seenIds: Set<string>;
}): DashboardDrillDownItem[] {
  const q = state.searchText.trim().toLowerCase();
  return state.items.filter((item) => {
    if (state.onlyUnseen && state.seenIds.has(item.id)) return false;
    if (!q) return true;
    return item.detail.toLowerCase().includes(q) || (item.tableName ?? '').toLowerCase().includes(q);
  });
}

function persist(state: PersistedPanelState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private window / blocked storage — the panel still works for this
    // session, it just won't reopen in the same place next visit.
  }
}

interface EmployeeTasksPanelState {
  isOpen: boolean;
  width: number;
  collapsed: boolean;
  workerId: string | null;
  workerName: string;
  metric: DashboardMetric | null;
  items: DashboardDrillDownItem[];
  loading: boolean;
  error: string | null;
  selectedIndex: number;
  searchText: string;
  onlyUnseen: boolean;
  seenIds: Set<string>;

  open: (workerId: string, workerName: string, metric: DashboardMetric) => void;
  close: () => void;
  toggleCollapsed: () => void;
  setWidth: (px: number) => void;
  setWorker: (workerId: string, workerName: string) => void;
  setMetric: (metric: DashboardMetric) => void;
  setSearchText: (text: string) => void;
  toggleOnlyUnseen: () => void;
  markSeen: (itemId: string) => void;
  setSelectedIndex: (i: number) => void;
  moveSelection: (delta: number) => void;
  reload: () => Promise<void>;
}

export const useEmployeeTasksPanelStore = create<EmployeeTasksPanelState>((set, get) => {
  const initial = loadPersisted();

  const persistCurrent = () => {
    const s = get();
    persist({
      isOpen: s.isOpen,
      width: s.width,
      collapsed: s.collapsed,
      workerId: s.workerId,
      workerName: s.workerName,
      metric: s.metric,
      seenIds: [...s.seenIds],
    });
  };

  let loadToken = 0;

  const reload = async () => {
    const { workerId, metric } = get();
    if (!workerId || !metric) {
      set({ items: [], loading: false, error: null });
      return;
    }
    const token = ++loadToken;
    set({ loading: true, error: null });
    const { period, customRange } = useDashboardStore.getState();
    try {
      const res = await fetchDashboardWorkerDetail(workerId, metric, period, customRange ?? undefined);
      if (token !== loadToken) return;
      set({ items: res.items, loading: false, selectedIndex: 0 });
    } catch (err) {
      if (token !== loadToken) return;
      set({ loading: false, error: err instanceof Error ? err.message : 'Nepavyko įkelti užduočių' });
    }
  };

  return {
    isOpen: initial.isOpen,
    width: initial.width,
    collapsed: initial.collapsed,
    workerId: initial.workerId,
    workerName: initial.workerName,
    metric: initial.metric,
    items: [],
    loading: false,
    error: null,
    selectedIndex: 0,
    searchText: '',
    onlyUnseen: false,
    seenIds: new Set(initial.seenIds),

    open: (workerId, workerName, metric) => {
      set({ isOpen: true, collapsed: false, workerId, workerName, metric, searchText: '', selectedIndex: 0 });
      persistCurrent();
      void reload();
    },

    close: () => {
      set({ isOpen: false });
      persistCurrent();
    },

    toggleCollapsed: () => {
      set((s) => ({ collapsed: !s.collapsed }));
      persistCurrent();
    },

    setWidth: (px) => {
      set({ width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, px)) });
      persistCurrent();
    },

    setWorker: (workerId, workerName) => {
      set({ workerId, workerName, searchText: '', selectedIndex: 0 });
      persistCurrent();
      void reload();
    },

    setMetric: (metric) => {
      set({ metric, searchText: '', selectedIndex: 0 });
      persistCurrent();
      void reload();
    },

    setSearchText: (text) => set({ searchText: text, selectedIndex: 0 }),

    toggleOnlyUnseen: () => set((s) => ({ onlyUnseen: !s.onlyUnseen, selectedIndex: 0 })),

    markSeen: (itemId) => {
      set((s) => {
        const next = new Set(s.seenIds);
        next.add(itemId);
        return { seenIds: next };
      });
      persistCurrent();
    },

    setSelectedIndex: (i) => {
      const count = computeVisibleItems(get()).length;
      if (count === 0) {
        set({ selectedIndex: 0 });
        return;
      }
      set({ selectedIndex: Math.min(Math.max(0, i), count - 1) });
    },

    moveSelection: (delta) => {
      const count = computeVisibleItems(get()).length;
      if (count === 0) return;
      set((s) => ({ selectedIndex: (((s.selectedIndex + delta) % count) + count) % count }));
    },

    reload,
  };
});
