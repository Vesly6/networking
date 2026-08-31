import { create } from 'zustand';
import {
  fetchCampaigns,
  createCampaign as apiCreateCampaign,
  updateCampaignStatus as apiUpdateCampaignStatus,
  deleteCampaign as apiDeleteCampaign,
  fetchLeads,
  addLeads as apiAddLeads,
  deleteLead as apiDeleteLead,
  fetchGraph,
  saveGraph as apiSaveGraph,
  updateLeadStatus as apiUpdateLeadStatus,
  fetchStaleInvites,
  withdrawStaleInvite,
  type LinkedInCampaign,
  type LinkedInCampaignStatus,
  type LinkedInLead,
  type NewLead,
  type LinkedInSequenceNode,
  type LinkedInSequenceEdge,
  type GraphNodeInput,
  type GraphEdgeInput,
  type LinkedInStaleInvite,
} from '../utils/linkedinCampaignsApi';

// Separate from useLinkedInStore (status/safety/actions-log) — this store
// owns campaign+lead+sequence-step CRUD state, a distinct enough shape
// (list + a currently-open campaign's own leads/steps) to warrant its own
// store, same split this app already applies elsewhere (e.g. useTableStore
// vs useWorkspaceStore).
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

  // The visual campaign-builder graph — replaces the old flat steps list.
  graphNodes: LinkedInSequenceNode[];
  graphEdges: LinkedInSequenceEdge[];
  graphReady: boolean;
  refreshGraph: (campaignId: string) => Promise<void>;
  savingGraph: boolean;
  /** Bulk replace — CampaignGraphEditor.tsx debounce-saves the whole graph
   * on any change (add/remove/rewire/reposition) rather than per-node/
   * per-edge calls, same bulk-endpoint reasoning as the server route
   * itself. Updates local state optimistically so the editor doesn't
   * visibly flicker while the request is in flight. */
  saveGraph: (campaignId: string, nodes: GraphNodeInput[], edges: GraphEdgeInput[]) => Promise<void>;

  /** Local-data-only (marks the lead 'skipped', no LinkedIn side effect)
   * — permanently removes it from further sequence consideration. Lives
   * directly in the lead-list UI (CampaignDetail.tsx) now that there is
   * no separate Pending Approval queue to hang it off of — manual review
   * was removed from this feature entirely, see scheduler.ts's
   * runSchedulerTick doc comment. */
  skipLead: (leadId: string) => Promise<void>;

  staleInvites: LinkedInStaleInvite[];
  staleInvitesReady: boolean;
  refreshStaleInvites: () => Promise<void>;
  // A Set, not a single string — the same in-flight-key tracking pattern
  // used throughout this app for any per-row async action two rows could
  // plausibly trigger concurrently (see CLAUDE.md's own note on this),
  // since withdraw is a real, irreversible LinkedIn action.
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
  setOpenCampaignId: (id) => set({ openCampaignId: id, leads: [], leadsReady: false, graphNodes: [], graphEdges: [], graphReady: false }),

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

  graphNodes: [],
  graphEdges: [],
  graphReady: false,
  refreshGraph: async (campaignId) => {
    try {
      const { nodes, edges } = await fetchGraph(campaignId);
      set({ graphNodes: nodes, graphEdges: edges, graphReady: true });
    } catch {
      set({ graphReady: true });
    }
  },

  savingGraph: false,
  saveGraph: async (campaignId, nodes, edges) => {
    set({ savingGraph: true });
    try {
      await apiSaveGraph(campaignId, nodes, edges);
      // Optimistic — the server accepted the exact shape just sent, so
      // there's no need to re-fetch; refreshGraph() (e.g. on next open)
      // will still pick up anything else that changed server-side.
      set({
        graphNodes: nodes.map((n) => ({ ...n, campaignId })),
        graphEdges: edges.map((e) => ({ ...e, id: `${e.fromNodeId ?? 'start'}->${e.toNodeId}:${e.branch}`, campaignId })),
        savingGraph: false,
      });
    } catch {
      set({ savingGraph: false });
    }
  },

  skipLead: async (leadId) => {
    await apiUpdateLeadStatus(leadId, 'skipped');
    const campaignId = get().openCampaignId;
    if (campaignId) void get().refreshLeads(campaignId);
    void get().refreshCampaigns();
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
