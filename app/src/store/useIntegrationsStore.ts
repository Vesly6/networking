import { create } from 'zustand';
import { superAdminApiRequest } from '../utils/superAdminApi';

// Mirrors server/src/index.ts's INTEGRATION_FIELDS exactly (camelCase,
// same order). Secret fields come back as booleans (never the real value,
// see GET /api/admin/companies/:id/integrations's own doc comment); the
// two non-secret fields (a phone number, a local CDP URL) come back as
// their real string value so they can be pre-filled into the form like
// any other settings field.
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
  /** `companyId` required — there is no self-service "manage my own
   * company's keys" route anymore (removed on explicit request: every
   * company's integrations, including what used to be the owner's own,
   * are managed exclusively through the independent super-admin dashboard
   * now — see server/src/index.ts's /api/admin/companies/:id/integrations
   * and its own doc comment). This store only ever talks to that one
   * requireSuperAdmin-gated route family. */
  load: (companyId: string) => Promise<void>;
  /** Partial — only the fields actually present get overwritten server-side
   * (an omitted field means "leave unchanged"), so this can be called with
   * just whichever fields the user actually typed into. */
  save: (patch: Partial<Record<IntegrationField, string>>, companyId: string) => Promise<void>;
  clear: (field: IntegrationField, companyId: string) => Promise<void>;
}

function integrationsPath(companyId: string, suffix = ''): string {
  return `/api/admin/companies/${companyId}/integrations${suffix}`;
}

/** Same "stores own data, components own side effects" convention as
 * useWorkersStore — this doesn't call showToast itself, IntegrationsView
 * watches `error` and toasts. */
export const useIntegrationsStore = create<IntegrationsState>((set, get) => ({
  status: null,
  loading: false,
  saving: false,
  error: null,

  load: async (companyId) => {
    set({ loading: true, error: null });
    try {
      const status = await superAdminApiRequest<IntegrationsStatus>(integrationsPath(companyId));
      set({ status, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Nepavyko įkelti API raktų' });
    }
  },

  save: async (patch, companyId) => {
    set({ saving: true, error: null });
    try {
      await superAdminApiRequest(integrationsPath(companyId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      set({ saving: false });
      await get().load(companyId);
    } catch (err) {
      set({ saving: false, error: err instanceof Error ? err.message : 'Nepavyko išsaugoti' });
      throw err;
    }
  },

  clear: async (field, companyId) => {
    set({ saving: true, error: null });
    try {
      await superAdminApiRequest(integrationsPath(companyId, '/clear'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field }),
      });
      set({ saving: false });
      await get().load(companyId);
    } catch (err) {
      set({ saving: false, error: err instanceof Error ? err.message : 'Nepavyko išvalyti' });
      throw err;
    }
  },
}));
