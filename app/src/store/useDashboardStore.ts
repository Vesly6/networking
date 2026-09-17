import { create } from 'zustand';
import {
  fetchDashboardSummary,
  fetchDashboardWorkers,
  refreshDashboard,
  type DashboardPeriod,
  type DashboardSummary,
  type DashboardWorkerRow,
} from '../utils/dashboardApi';

interface DashboardState {
  period: DashboardPeriod;
  customRange: { from: string; to: string } | null;
  summary: DashboardSummary | null;
  /** null while not yet loaded/not permitted — the component tells the
   * two states apart via summary.canViewTeam, not by inspecting this. */
  workers: DashboardWorkerRow[] | null;
  ready: boolean;
  error: string | null;
  /** True only while a manual "Obnovit'" force-sync is in flight — the
   * period-switch/initial `load()` uses `ready` instead, so the button's
   * own spinner doesn't also flash on every plain period change. */
  refreshing: boolean;
  setPeriod: (period: DashboardPeriod, custom?: { from: string; to: string }) => void;
  load: () => Promise<void>;
  /** The "Обновить" button — forces a fresh sync server-side (rate-limited
   * there, see index.ts's DASHBOARD_REFRESH_COOLDOWN_MS) then reloads. A
   * 429 from the cooldown is surfaced as a normal `error` string, not a
   * thrown exception the component needs its own try/catch for. */
  forceRefresh: () => Promise<void>;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  period: 'today',
  customRange: null,
  summary: null,
  workers: null,
  ready: false,
  error: null,
  refreshing: false,

  setPeriod: (period, custom) => {
    set({ period, customRange: custom ?? null });
    void get().load();
  },

  load: async () => {
    set({ error: null });
    try {
      const { period, customRange } = get();
      const summary = await fetchDashboardSummary(period, customRange ?? undefined);
      const workers = summary.canViewTeam ? (await fetchDashboardWorkers(period, customRange ?? undefined)).workers : null;
      set({ summary, workers, ready: true });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko įkelti aktyvumo statistikos', ready: true });
    }
  },

  forceRefresh: async () => {
    set({ refreshing: true, error: null });
    try {
      await refreshDashboard();
      await get().load();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko atnaujinti' });
    } finally {
      set({ refreshing: false });
    }
  },
}));
