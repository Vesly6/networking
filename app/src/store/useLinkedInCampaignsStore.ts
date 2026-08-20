import { create } from 'zustand';
import {
  fetchCampaigns,
  createCampaign as apiCreateCampaign,
  updateCampaignStatus as apiUpdateCampaignStatus,
  deleteCampaign as apiDeleteCampaign,
  fetchLeads,
  addLeads as apiAddLeads,
  deleteLead as apiDeleteLead,
  fetchSteps,
  addStep as apiAddStep,
  deleteStep as apiDeleteStep,
  fetchPendingActions,
  approvePendingAction,
  personalizeAction as apiPersonalizeAction,
  updateLeadStatus as apiUpdateLeadStatus,
  fetchStaleInvites,
  withdrawStaleInvite,
  type LinkedInCampaign,
  type LinkedInCampaignStatus,
  type LinkedInLead,
  type NewLead,
  type LinkedInSequenceStep,
  type LinkedInStepType,
  type DueAction,
  type LinkedInStaleInvite,
} from '../utils/linkedinCampaignsApi';

// Separate from useLinkedInStore (status/safety/actions-log) — this store
// owns campaign+lead+sequence-step CRUD state plus the Pending Approval
// queue, a distinct enough shape (list + a currently-open campaign's own
// leads/steps) to warrant its own store, same split this app already
// applies elsewhere (e.g. useTableStore vs useWorkspaceStore).
interface LinkedInCampaignsState {
  campaigns: LinkedInCampaign[];
  campaignsReady: boolean;
  refreshCampaigns: () => Promise<void>;
  creating: boolean;
  createCampaign: (name: string) => Promise<LinkedInCampaign | null>;
  deleteCampaign: (id: string) => Promise<void>;
  updateCampaignStatus: (id: string, status: LinkedInCampaignStatus) => Promise<void>;

  openCampaignId: string | null;
  setOpenCampaignId: (id: string | null) => void;
  leads: LinkedInLead[];
  leadsReady: boolean;
  refreshLeads: (campaignId: string) => Promise<void>;
  importing: boolean;
  importError: string | null;
  importLeads: (campaignId: string, leads: NewLead[]) => Promise<number | null>;
  removeLead: (id: string) => Promise<void>;

  steps: LinkedInSequenceStep[];
  stepsReady: boolean;
  refreshSteps: (campaignId: string) => Promise<void>;
  addingStep: boolean;
  addStep: (campaignId: string, type: LinkedInStepType, delayDays: number, messageTemplate?: string) => Promise<void>;
  removeStep: (id: string) => Promise<void>;

  pendingActions: DueAction[];
  pendingReady: boolean;
  refreshPending: () => Promise<void>;
  // A Set, not a single string — a real, reproduced bug with a single
  // "current key" here: approving row A, then (before A's request
  // resolves) approving row B, overwrote the *one* key to B's, which made
  // A's own button re-render as enabled even though A's request was still
  // in flight. Since the server re-verifies "is this still due" but that
  // check can itself race with a slow-to-execute first request (real
  // browser automation takes seconds, well before the first call's own
  // status update lands), a confused second click on A while it looked
  // re-enabled could reach the server as a genuine second approval before
  // the first one finished — a real double-send risk for an irreversible
  // action. Tracking every in-flight key independently means each row's
  // disabled state only ever reflects its *own* request.
  approvingKeys: Set<string>;
  /** Real, unrecoverable side effect the instant it succeeds — the caller
   * (a Pending Approval list item) must have already shown a confirm
   * dialog. `overrideMessage` (optional) is the panel's own edited/AI-
   * personalized text, if personalizeAction() below was used first.
   * Returns whether it actually went through. */
  approveAction: (leadId: string, stepId: string, overrideMessage?: string) => Promise<boolean>;
  /** Local-data-only (marks the lead 'skipped', no LinkedIn side effect)
   * — permanently removes it from further sequence consideration. */
  skipLead: (leadId: string) => Promise<void>;

  // Same Set-not-single-value fix as approvingKeys above — personalizing
  // two different rows concurrently used to make the *slower* one's
  // result silently steal the open edit box away from whichever row the
  // user was actually looking at once it finally resolved.
  personalizingKeys: Set<string>;
  personalizeError: string | null;
  /** Drafts an AI-personalized version of one pending action's message —
   * never sends anything itself. Returns null on failure (personalizeError
   * is set for the caller to show). */
  personalizeAction: (leadId: string, stepId: string) => Promise<{ baseText: string; personalizedText: string } | null>;

  staleInvites: LinkedInStaleInvite[];
  staleInvitesReady: boolean;
  refreshStaleInvites: () => Promise<void>;
  // Same Set-not-single-value fix as approvingKeys above, same reasoning
  // (withdraw is just as irreversible/real as approve).
  withdrawingKeys: Set<string>;
  /** Real, unrecoverable side effect the instant it succeeds — the caller
   * (StaleInvitesPanel) must have already shown a confirm dialog. */
  withdrawInvite: (leadId: string) => Promise<boolean>;
}

export const useLinkedInCampaignsStore = create<LinkedInCampaignsState>((set, get) => ({
  campaigns: [],
  campaignsReady: false,
  refreshCampaigns: async () => {
    try {
      const { campaigns } = await fetchCampaigns();
      set({ campaigns, campaignsReady: true });
    } catch {
      set({ campaignsReady: true });
    }
  },

  creating: false,
  createCampaign: async (name) => {
    set({ creating: true });
    try {
      const campaign = await apiCreateCampaign(name);
      set((s) => ({ campaigns: [campaign, ...s.campaigns], creating: false }));
      return campaign;
    } catch {
      set({ creating: false });
      return null;
    }
  },

  deleteCampaign: async (id) => {
    await apiDeleteCampaign(id);
    set((s) => ({
      campaigns: s.campaigns.filter((c) => c.id !== id),
      openCampaignId: s.openCampaignId === id ? null : s.openCampaignId,
    }));
  },

  updateCampaignStatus: async (id, status) => {
    const campaign = await apiUpdateCampaignStatus(id, status);
    set((s) => ({ campaigns: s.campaigns.map((c) => (c.id === id ? campaign : c)) }));
  },

  openCampaignId: null,
  setOpenCampaignId: (id) => set({ openCampaignId: id, leads: [], leadsReady: false, steps: [], stepsReady: false }),

  leads: [],
  leadsReady: false,
  refreshLeads: async (campaignId) => {
    try {
      const { leads } = await fetchLeads(campaignId);
      set({ leads, leadsReady: true });
    } catch {
      set({ leadsReady: true });
    }
  },

  importing: false,
  importError: null,
  importLeads: async (campaignId, leads) => {
    set({ importing: true, importError: null });
    try {
      const { inserted } = await apiAddLeads(campaignId, leads);
      set({ importing: false });
      void get().refreshLeads(campaignId);
      void get().refreshCampaigns();
      return inserted;
    } catch (err) {
      set({ importing: false, importError: err instanceof Error ? err.message : 'Could not import leads' });
      return null;
    }
  },

  removeLead: async (id) => {
    await apiDeleteLead(id);
    set((s) => ({ leads: s.leads.filter((l) => l.id !== id) }));
    void get().refreshCampaigns(); // keeps each campaign's leadCount in sync
  },

  steps: [],
  stepsReady: false,
  refreshSteps: async (campaignId) => {
    try {
      const { steps } = await fetchSteps(campaignId);
      set({ steps, stepsReady: true });
    } catch {
      set({ stepsReady: true });
    }
  },

  addingStep: false,
  addStep: async (campaignId, type, delayDays, messageTemplate) => {
    set({ addingStep: true });
    try {
      const step = await apiAddStep(campaignId, type, delayDays, messageTemplate);
      set((s) => ({ steps: [...s.steps, step], addingStep: false }));
    } catch {
      set({ addingStep: false });
    }
  },

  removeStep: async (id) => {
    await apiDeleteStep(id);
    set((s) => ({ steps: s.steps.filter((st) => st.id !== id) }));
  },

  pendingActions: [],
  pendingReady: false,
  refreshPending: async () => {
    try {
      const { due } = await fetchPendingActions();
      set({ pendingActions: due, pendingReady: true });
    } catch {
      set({ pendingReady: true });
    }
  },

  approvingKeys: new Set(),
  approveAction: async (leadId, stepId, overrideMessage) => {
    const key = `${leadId}:${stepId}`;
    set((s) => ({ approvingKeys: new Set(s.approvingKeys).add(key) }));
    const clear = () => set((s) => {
      const next = new Set(s.approvingKeys);
      next.delete(key);
      return { approvingKeys: next };
    });
    try {
      const result = await approvePendingAction(leadId, stepId, overrideMessage);
      clear();
      void get().refreshPending();
      return result.ok;
    } catch {
      clear();
      void get().refreshPending();
      return false;
    }
  },

  skipLead: async (leadId) => {
    await apiUpdateLeadStatus(leadId, 'skipped');
    void get().refreshPending();
    void get().refreshCampaigns();
  },

  personalizingKeys: new Set(),
  personalizeError: null,
  personalizeAction: async (leadId, stepId) => {
    const key = `${leadId}:${stepId}`;
    set((s) => ({ personalizingKeys: new Set(s.personalizingKeys).add(key), personalizeError: null }));
    const clear = () => set((s) => {
      const next = new Set(s.personalizingKeys);
      next.delete(key);
      return { personalizingKeys: next };
    });
    try {
      const result = await apiPersonalizeAction(leadId, stepId);
      clear();
      return result;
    } catch (err) {
      clear();
      set({ personalizeError: err instanceof Error ? err.message : 'Nepavyko personalizuoti' });
      return null;
    }
  },

  staleInvites: [],
  staleInvitesReady: false,
  refreshStaleInvites: async () => {
    try {
      const { stale } = await fetchStaleInvites();
      set({ staleInvites: stale, staleInvitesReady: true });
    } catch {
      set({ staleInvitesReady: true });
    }
  },

  withdrawingKeys: new Set(),
  withdrawInvite: async (leadId) => {
    set((s) => ({ withdrawingKeys: new Set(s.withdrawingKeys).add(leadId) }));
    const clear = () => set((s) => {
      const next = new Set(s.withdrawingKeys);
      next.delete(leadId);
      return { withdrawingKeys: next };
    });
    try {
      const result = await withdrawStaleInvite(leadId);
      clear();
      void get().refreshStaleInvites();
      return result.ok;
    } catch {
      clear();
      void get().refreshStaleInvites();
      return false;
    }
  },
}));
