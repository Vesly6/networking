import { create } from 'zustand';
import { localApiRequest } from '../utils/localApi';

// Mirrors server/src/index.ts's INTEGRATION_FIELDS exactly (camelCase,
// same order). Secret fields come back as booleans (never the real value,
// see GET /api/integrations's own doc comment); the two non-secret fields
// (a phone number, a local CDP URL) come back as their real string value
// so they can be pre-filled into the form like any other settings field.
export type IntegrationField =
  | 'zadarmaApiKey'
  | 'zadarmaApiSecret'
  | 'zadarmaCallerNumber'
  | 'instantlyApiKey'
  | 'apolloApiKey'
  | 'serperApiKey'
  | 'openaiApiKey'
  | 'anthropicApiKey'
  | 'elevenlabsApiKey'
  | 'linkedinCdpUrl';

export const NON_SECRET_INTEGRATION_FIELDS: readonly IntegrationField[] = ['zadarmaCallerNumber', 'linkedinCdpUrl'];

export type IntegrationsStatus = Record<IntegrationField, boolean | string | null>;

interface IntegrationsState {
  status: IntegrationsStatus | null;
  loading: boolean;
  saving: boolean;
  error: string | null;
  load: () => Promise<void>;
  /** Partial — only the fields actually present get overwritten server-side
   * (an omitted field means "leave unchanged"), so this can be called with
   * just whichever fields the user actually typed into. */
  save: (patch: Partial<Record<IntegrationField, string>>) => Promise<void>;
  clear: (field: IntegrationField) => Promise<void>;
}

/** Same "stores own data, components own side effects" convention as
 * useWorkersStore — this doesn't call showToast itself, IntegrationsView
 * watches `error` and toasts. */
export const useIntegrationsStore = create<IntegrationsState>((set, get) => ({
  status: null,
  loading: false,
  saving: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const status = await localApiRequest<IntegrationsStatus>('/api/integrations');
      set({ status, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Nepavyko įkelti API raktų' });
    }
  },

  save: async (patch) => {
    set({ saving: true, error: null });
    try {
      await localApiRequest('/api/integrations', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      set({ saving: false });
      await get().load();
    } catch (err) {
      set({ saving: false, error: err instanceof Error ? err.message : 'Nepavyko išsaugoti' });
      throw err;
    }
  },

  clear: async (field) => {
    set({ saving: true, error: null });
    try {
      await localApiRequest('/api/integrations/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field }),
      });
      set({ saving: false });
      await get().load();
    } catch (err) {
      set({ saving: false, error: err instanceof Error ? err.message : 'Nepavyko išvalyti' });
      throw err;
    }
  },
}));
