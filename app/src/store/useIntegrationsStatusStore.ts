import { create } from 'zustand';
import { localApiRequest } from '../utils/localApi';
import type { IntegrationsStatus } from './useIntegrationsStore';

// A plain-session counterpart to useIntegrationsStore, which only a
// requireSuperAdmin login can use (it hits /api/admin/companies/:id/
// integrations). Any regular company user — including a worker — still
// needs to know *whether* an integration is configured, so a UI affordance
// like the Paieška nav tab can dim itself instead of navigating the user
// into a tab that immediately fails with an IntegrationNotConfiguredError.
// Booleans only, never a secret, over the ordinary requireAuth session
// (server/src/index.ts's GET /api/integrations/status).
interface IntegrationsStatusState {
  status: IntegrationsStatus | null;
  loaded: boolean;
  load: () => Promise<void>;
}

export const useIntegrationsStatusStore = create<IntegrationsStatusState>((set, get) => ({
  status: null,
  loaded: false,

  load: async () => {
    if (get().loaded) return;
    try {
      const status = await localApiRequest<IntegrationsStatus>('/api/integrations/status');
      set({ status, loaded: true });
    } catch {
      // Silent — this only ever drives a cosmetic dim/disable, not worth a
      // toast if the check itself fails (e.g. server briefly unreachable).
      set({ loaded: true });
    }
  },
}));
