import { create } from 'zustand';
import {
  fetchInstantlyCampaigns,
  fetchInstantlyCampaign,
  activateInstantlyCampaign,
  pauseInstantlyCampaign,
  fetchInstantlyCampaignAnalytics,
  fetchInstantlyCampaignAnalyticsDaily,
  fetchInstantlyCampaignsAnalyticsList,
  type InstantlyCampaign,
  type InstantlyCampaignAnalyticsOverview,
  type InstantlyCampaignDailyAnalytics,
  type InstantlyCampaignAnalyticsRow,
} from '../utils/instantlyApi';

// Matches every option in Instantly's own real date-range dropdown (see
// the reference screenshot), plus 'all' (everything since the account's
// own real start date, on explicit request) and 'custom' for an explicit
// start/end pair the user picks themselves.
export type AnalyticsPeriod = '7d' | 'mtd' | '4w' | '3m' | '6m' | '12m' | 'all' | 'custom';

// The date cold-email sending actually started on this account — 'all'
// means "everything there is," not an arbitrary lookback window, so this
// is a fixed anchor rather than a computed one (unlike every other period
// below, whose start is relative to today).
const ALL_TIME_START = '2024-06-05';

export interface DateRange {
  start_date: string;
  end_date: string;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Matches Instantly's own date-range picker (see the reference
 * screenshot the Analytics dashboard was built from). Always anchored to
 * UTC "today" — same reasoning already established elsewhere in this app
 * (CLAUDE.md's own documented callStats.ts bug) for why date-range math
 * should never mix in local timezone. `custom` is passed straight
 * through as given (already a pair of plain yyyy-mm-dd strings from the
 * date inputs, no arithmetic needed). */
export function periodToDateRange(period: AnalyticsPeriod, custom: DateRange | null): DateRange {
  if (period === 'custom') return custom ?? periodToDateRange('4w', null);
  const end = new Date();
  // end_date is always "today," computed fresh on every call — this is
  // what keeps 'all' (and every other period) automatically sliding
  // forward on its own rather than needing the user to re-pick a date.
  if (period === 'all') return { start_date: ALL_TIME_START, end_date: toIsoDate(end) };
  const start = new Date(end);
  if (period === '7d') start.setUTCDate(start.getUTCDate() - 7);
  else if (period === 'mtd') start.setUTCDate(1);
  else if (period === '4w') start.setUTCDate(start.getUTCDate() - 28);
  else if (period === '3m') start.setUTCMonth(start.getUTCMonth() - 3);
  else if (period === '6m') start.setUTCMonth(start.getUTCMonth() - 6);
  else start.setUTCMonth(start.getUTCMonth() - 12);
  return { start_date: toIsoDate(start), end_date: toIsoDate(end) };
}

interface InstantlyCampaignsState {
  campaigns: InstantlyCampaign[];
  ready: boolean;
  error: string | null;
  nextCursor: string | null;
  loadMoreLoading: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;

  // A Set, not a single string — the same in-flight-key tracking pattern
  // used throughout this app for any per-row async action two rows could
  // plausibly trigger concurrently (see CLAUDE.md's own note on this): a
  // single shared "in-flight id" would make a second row's click wrongly
  // re-enable the first row's button while its own request was still
  // pending.
  togglingIds: Set<string>;
  toggleCampaignActive: (id: string, currentStatus: number) => Promise<void>;

  analytics: Record<string, InstantlyCampaignAnalyticsOverview>;
  analyticsLoadingIds: Set<string>;
  fetchAnalytics: (id: string) => Promise<void>;

  // The account-wide Analytics dashboard (AnalyticsPanel.tsx) — a
  // separate concern from the per-campaign `analytics` map above (which
  // backs the small 📊 button on each row in the plain campaign list).
  dashboardPeriod: AnalyticsPeriod;
  setDashboardPeriod: (period: AnalyticsPeriod) => void;
  /** Only meaningful when dashboardPeriod === 'custom' — the two date
   * inputs in AnalyticsPanel's "Custom" picker write here directly. */
  dashboardCustomRange: DateRange | null;
  setDashboardCustomRange: (range: DateRange) => void;
  dashboardOverview: InstantlyCampaignAnalyticsOverview | null;
  dashboardDaily: InstantlyCampaignDailyAnalytics[];
  dashboardRows: InstantlyCampaignAnalyticsRow[];
  dashboardReady: boolean;
  dashboardError: string | null;
  refreshDashboard: () => Promise<void>;
}

export const useInstantlyCampaignsStore = create<InstantlyCampaignsState>((set, get) => ({
  campaigns: [],
  ready: false,
  error: null,
  nextCursor: null,
  loadMoreLoading: false,

  refresh: async () => {
    set({ error: null });
    try {
      const page = await fetchInstantlyCampaigns({ limit: 50 });
      set({ campaigns: page.items, nextCursor: page.next_starting_after ?? null, ready: true });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko įkelti kampanijų', ready: true });
    }
  },

  loadMore: async () => {
    const { nextCursor, campaigns, loadMoreLoading } = get();
    if (!nextCursor || loadMoreLoading) return;
    set({ loadMoreLoading: true });
    try {
      const page = await fetchInstantlyCampaigns({ limit: 50, starting_after: nextCursor });
      set({ campaigns: [...campaigns, ...page.items], nextCursor: page.next_starting_after ?? null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko įkelti daugiau kampanijų' });
    } finally {
      set({ loadMoreLoading: false });
    }
  },

  togglingIds: new Set(),
  toggleCampaignActive: async (id, currentStatus) => {
    set((s) => ({ togglingIds: new Set(s.togglingIds).add(id) }));
    try {
      // status 1 = Active (see CAMPAIGN_STATUS_LABELS) — pause an active
      // campaign, activate anything else (draft/paused/completed).
      if (currentStatus === 1) await pauseInstantlyCampaign(id);
      else await activateInstantlyCampaign(id);
      // The action endpoints' own response shape is minimal (just
      // {status}) — refetch this one campaign's real record rather than
      // guessing, and merge it into the existing list in place so a user
      // who's scrolled past page 1 (loadMore) doesn't lose that progress,
      // unlike a full refresh() would.
      const updated = await fetchInstantlyCampaign(id);
      set((s) => ({ campaigns: s.campaigns.map((c) => (c.id === id ? updated : c)) }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko pakeisti kampanijos būsenos' });
    } finally {
      set((s) => {
        const next = new Set(s.togglingIds);
        next.delete(id);
        return { togglingIds: next };
      });
    }
  },

  analytics: {},
  analyticsLoadingIds: new Set(),
  fetchAnalytics: async (id) => {
    set((s) => ({ analyticsLoadingIds: new Set(s.analyticsLoadingIds).add(id) }));
    try {
      const overview = await fetchInstantlyCampaignAnalytics({ id });
      set((s) => ({ analytics: { ...s.analytics, [id]: overview } }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko įkelti analitikos' });
    } finally {
      set((s) => {
        const next = new Set(s.analyticsLoadingIds);
        next.delete(id);
        return { analyticsLoadingIds: next };
      });
    }
  },

  dashboardPeriod: '4w',
  setDashboardPeriod: (period) => {
    set({ dashboardPeriod: period });
    void get().refreshDashboard();
  },
  dashboardCustomRange: null,
  setDashboardCustomRange: (range) => {
    set({ dashboardCustomRange: range });
    if (get().dashboardPeriod === 'custom') void get().refreshDashboard();
  },
  dashboardOverview: null,
  dashboardDaily: [],
  dashboardRows: [],
  dashboardReady: false,
  dashboardError: null,
  refreshDashboard: async () => {
    set({ dashboardError: null });
    const range = periodToDateRange(get().dashboardPeriod, get().dashboardCustomRange);
    try {
      // All three in parallel — they're independent reads (account-wide
      // totals, the daily chart series, and the per-campaign table rows),
      // no reason to wait on one before starting the next.
      const [overview, daily, rows] = await Promise.all([
        fetchInstantlyCampaignAnalytics(range),
        fetchInstantlyCampaignAnalyticsDaily(range),
        fetchInstantlyCampaignsAnalyticsList(range),
      ]);
      set({ dashboardOverview: overview, dashboardDaily: daily, dashboardRows: rows, dashboardReady: true });
    } catch (err) {
      set({ dashboardError: err instanceof Error ? err.message : 'Nepavyko įkelti analitikos', dashboardReady: true });
    }
  },
}));
