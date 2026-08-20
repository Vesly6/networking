import { create } from 'zustand';
import {
  fetchLinkedInStatus,
  fetchLinkedInActions,
  sendTestConnectionRequest,
  fetchLinkedInSafety,
  updateLinkedInSafetySettings,
  setLinkedInPaused,
  type LinkedInStatus,
  type LinkedInActionLogEntry,
  type LinkedInSafetySnapshot,
} from '../utils/linkedinApi';

// Phase 0 proved the CDP/Playwright connection; this store still only
// owns the Safety Engine (caps/work-hours/warm-up/pause) plus the one
// manual test-connect action from the "Testas" tab — campaign/lead/
// inbox/analytics/stale-invite state each live in their own store
// (useLinkedInCampaignsStore, useLinkedInInboxStore). Same `ready:
// boolean` + async-action convention as useCallsStore.ts.
interface LinkedInState {
  status: LinkedInStatus | null;
  statusLoading: boolean;
  refreshStatus: () => Promise<void>;

  actions: LinkedInActionLogEntry[];
  actionsReady: boolean;
  refreshActions: () => Promise<void>;

  sending: boolean;
  sendError: string | null;
  /** Real side effect the instant it resolves — the caller (LinkedInView)
   * must have already shown a confirm dialog before calling this. Also
   * subject to the Safety Engine (server-side) — a blocked attempt
   * resolves `false` with sendError set to the Safety Engine's reason. */
  sendTestConnect: (profileUrl: string, note?: string) => Promise<boolean>;

  safety: LinkedInSafetySnapshot | null;
  safetyLoading: boolean;
  refreshSafety: () => Promise<void>;
  savingSettings: boolean;
  saveSettingsError: string | null;
  saveSafetySettings: (patch: Record<string, string | number | boolean>) => Promise<boolean>;
  /** The always-visible "⏸ Stop everything" control. */
  togglePause: () => Promise<void>;
}

export const useLinkedInStore = create<LinkedInState>((set, get) => ({
  status: null,
  statusLoading: false,
  refreshStatus: async () => {
    set({ statusLoading: true });
    try {
      const status = await fetchLinkedInStatus();
      set({ status, statusLoading: false });
    } catch (err) {
      set({
        status: { status: 'not_connected', message: err instanceof Error ? err.message : 'Could not reach the server' },
        statusLoading: false,
      });
    }
  },

  actions: [],
  actionsReady: false,
  refreshActions: async () => {
    try {
      const { actions } = await fetchLinkedInActions();
      set({ actions, actionsReady: true });
    } catch {
      set({ actionsReady: true });
    }
  },

  sending: false,
  sendError: null,
  sendTestConnect: async (profileUrl, note) => {
    set({ sending: true, sendError: null });
    try {
      await sendTestConnectionRequest(profileUrl, note);
      set({ sending: false });
      void get().refreshActions();
      void get().refreshSafety();
      return true;
    } catch (err) {
      set({ sending: false, sendError: err instanceof Error ? err.message : 'Could not send connection request' });
      void get().refreshActions();
      return false;
    }
  },

  safety: null,
  safetyLoading: false,
  refreshSafety: async () => {
    set({ safetyLoading: true });
    try {
      const safety = await fetchLinkedInSafety();
      set({ safety, safetyLoading: false });
    } catch {
      set({ safetyLoading: false });
    }
  },

  savingSettings: false,
  saveSettingsError: null,
  saveSafetySettings: async (patch) => {
    set({ savingSettings: true, saveSettingsError: null });
    try {
      const safety = await updateLinkedInSafetySettings(patch);
      set({ safety, savingSettings: false });
      return true;
    } catch (err) {
      set({ savingSettings: false, saveSettingsError: err instanceof Error ? err.message : 'Could not save settings' });
      return false;
    }
  },

  togglePause: async () => {
    const current = get().safety?.settings.paused ?? false;
    try {
      const safety = await setLinkedInPaused(!current);
      set({ safety });
    } catch (err) {
      set({ saveSettingsError: err instanceof Error ? err.message : 'Could not update pause state' });
    }
  },
}));
