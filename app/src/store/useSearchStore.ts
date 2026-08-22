import { create } from 'zustand';
import {
  searchPeople as apiSearchPeople,
  searchCompanies as apiSearchCompanies,
  enrichPerson as apiEnrichPerson,
  pollPhoneReveal as apiPollPhoneReveal,
  type PeopleSearchParams,
  type CompanySearchParams,
  type PeopleEnrichParams,
  type ApolloSearchPerson,
  type ApolloCompany,
  type ApolloEnrichedPerson,
} from '../utils/apolloApi';
import { usePendingPhoneSearchStore } from './usePendingPhoneSearchStore';

type SearchMode = 'people' | 'companies';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Apollo's own docs say phone delivery "can take several minutes" — this
// caps total wait so a genuinely stuck poll fails clearly instead of
// spinning forever. In practice, confirmed against a live account, a
// result is often ready on the very first poll.
const PHONE_POLL_MAX_MS = 3 * 60 * 1000;

interface SearchState {
  mode: SearchMode;
  setMode: (mode: SearchMode) => void;

  peopleParams: PeopleSearchParams;
  setPeopleParams: (params: PeopleSearchParams) => void;
  people: ApolloSearchPerson[];
  peopleTotal: number;
  peoplePage: number;
  peopleLoading: boolean;
  peopleError: string | null;
  runPeopleSearch: (page?: number) => Promise<void>;

  companyParams: CompanySearchParams;
  setCompanyParams: (params: CompanySearchParams) => void;
  companies: ApolloCompany[];
  companiesTotal: number;
  companiesPage: number;
  companiesLoading: boolean;
  companiesError: string | null;
  runCompanySearch: (page?: number) => Promise<void>;

  // Enrichment is per-person, keyed by Apollo's own person id — a search
  // result and its (once revealed) enriched contact info stay linked this
  // way regardless of scrolling/re-sorting/re-searching.
  enrichedById: Record<string, ApolloEnrichedPerson>;
  enrichingIds: Record<string, boolean>;
  enrichErrors: Record<string, string>;
  /** "Find email" — cheap (1 credit if found, 0 if not), synchronous. */
  revealEmail: (person: ApolloSearchPerson) => Promise<void>;

  // Phone is tracked separately from enrichedById/enrichErrors above:
  // it's a slower, async, more expensive (up to +8 credits) operation
  // with its own pending/error states, deliberately never triggered by
  // revealEmail so clicking "Find email" never silently also spends the
  // larger phone credit cost.
  phoneNumbersById: Record<string, Array<{ sanitized_number: string; status_cd?: string; confidence_cd?: string | null }>>;
  phonePendingIds: Record<string, boolean>;
  phoneErrors: Record<string, string>;
  /** "Find phone" — starts Apollo's async phone lookup, then polls for the
   * result (see pollPhoneReveal in apolloApi.ts). Confirmed working
   * end-to-end against a live account after fixing a numeric-precision bug
   * in the polling id — see server/src/apollo.ts's pollWebhookResult. */
  revealPhone: (person: ApolloSearchPerson) => Promise<void>;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  mode: 'people',
  setMode: (mode) => set({ mode }),

  peopleParams: { per_page: 25 },
  setPeopleParams: (params) => set({ peopleParams: params }),
  people: [],
  peopleTotal: 0,
  peoplePage: 1,
  peopleLoading: false,
  peopleError: null,
  runPeopleSearch: async (page = 1) => {
    set({ peopleLoading: true, peopleError: null });
    try {
      const params = { ...get().peopleParams, page };
      const result = await apiSearchPeople(params);
      // Trust the page we *asked for*, not result.page — confirmed against
      // a real response: /mixed_people/api_search doesn't actually echo a
      // page number back at all (unlike company search's `pagination`
      // object), so result.page was always undefined here.
      set({ people: result.people, peopleTotal: result.total_entries, peoplePage: page, peopleLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nepavyko atlikti Apollo paieškos';
      set({ peopleError: message, peopleLoading: false });
    }
  },

  companyParams: { per_page: 25 },
  setCompanyParams: (params) => set({ companyParams: params }),
  companies: [],
  companiesTotal: 0,
  companiesPage: 1,
  companiesLoading: false,
  companiesError: null,
  runCompanySearch: async (page = 1) => {
    set({ companiesLoading: true, companiesError: null });
    try {
      const params = { ...get().companyParams, page };
      const result = await apiSearchCompanies(params);
      // Same reasoning as runPeopleSearch above — trust the requested page
      // rather than the response's own (here it usually does come back via
      // Apollo's `pagination` object, but there's no reason to depend on
      // that when we already know what we asked for).
      set({
        companies: result.companies,
        companiesTotal: result.total_entries,
        companiesPage: page,
        companiesLoading: false,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nepavyko atlikti Apollo paieškos';
      set({ companiesError: message, companiesLoading: false });
    }
  },

  enrichedById: {},
  enrichingIds: {},
  enrichErrors: {},
  revealEmail: async (person) => {
    const id = person.id;
    if (get().enrichedById[id] || get().enrichingIds[id]) return;
    set((s) => ({ enrichingIds: { ...s.enrichingIds, [id]: true }, enrichErrors: { ...s.enrichErrors, [id]: '' } }));
    try {
      const params: PeopleEnrichParams = {
        id,
        name: [person.first_name, person.last_name_obfuscated].filter(Boolean).join(' ') || undefined,
        organization_name: person.organization?.name ?? undefined,
      };
      const result = await apiEnrichPerson(params);
      if (!result.person) throw new Error('Šio žmogaus atitikmuo nerastas');
      set((s) => ({ enrichedById: { ...s.enrichedById, [id]: result.person! } }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nepavyko atskleisti šio kontakto';
      set((s) => ({ enrichErrors: { ...s.enrichErrors, [id]: message } }));
    } finally {
      set((s) => {
        const enrichingIds = { ...s.enrichingIds };
        delete enrichingIds[id];
        return { enrichingIds };
      });
    }
  },

  phoneNumbersById: {},
  phonePendingIds: {},
  phoneErrors: {},
  revealPhone: async (person) => {
    const id = person.id;
    if (get().phoneNumbersById[id] || get().phonePendingIds[id]) return;
    set((s) => ({ phonePendingIds: { ...s.phonePendingIds, [id]: true }, phoneErrors: { ...s.phoneErrors, [id]: '' } }));
    try {
      const params: PeopleEnrichParams = {
        id,
        name: [person.first_name, person.last_name_obfuscated].filter(Boolean).join(' ') || undefined,
        organization_name: person.organization?.name ?? undefined,
        reveal_phone_number: true,
      };
      const result = await apiEnrichPerson(params);
      // The same call also returns the primary email (unconditionally, not
      // gated by any reveal_* flag) — worth keeping even though this
      // button is nominally "just phone", so a subsequent "Find email"
      // click on an already-phone-revealed person is a free no-op instead
      // of a second billed lookup.
      if (result.person) set((s) => ({ enrichedById: { ...s.enrichedById, [id]: result.person! } }));

      // Apollo can return the phone synchronously, in this SAME response,
      // when it's already on file from an earlier reveal — a real,
      // reported bug: this used to unconditionally require request_id and
      // poll (or, worse, throw an error when request_id was absent
      // *because* the phone had already come back synchronously), paying
      // the full "can take several minutes" async cost — or failing
      // outright — for an answer that had already arrived. Checked first.
      const syncPhone = result.person?.contact?.phone_numbers;
      if (syncPhone && syncPhone.length > 0) {
        set((s) => ({ phoneNumbersById: { ...s.phoneNumbersById, [id]: syncPhone } }));
        return;
      }

      // The TOP-LEVEL request_id is the one to poll with — NOT
      // result.phone_enrichment.request_id, which looks like it should be
      // it but is a different id the polling endpoint always rejects. See
      // apolloApi.ts's pollPhoneReveal / server/src/apollo.ts's
      // pollWebhookResult for how this was confirmed.
      if (!result.request_id) {
        throw new Error(result.phone_enrichment?.message ?? 'Apollo nepradėjo šio žmogaus telefono paieškos');
      }
      const requestId = result.request_id;
      // Global, not local to this store's own phonePendingIds (which
      // already survives navigating away, since it's a Zustand store, not
      // component state) — this feeds a persistent indicator (App.tsx)
      // visible from *any* tab, not just while the Paieška view happens
      // to be mounted, for the identical reason
      // ApolloContactSearchModal.tsx's own poll loop needed this same fix
      // — see usePendingPhoneSearchStore's own doc comment.
      usePendingPhoneSearchStore.getState().start();
      try {
        const deadline = Date.now() + PHONE_POLL_MAX_MS;
        for (;;) {
          const poll = await apiPollPhoneReveal(requestId);
          if (poll.status === 'ready') {
            set((s) => ({ phoneNumbersById: { ...s.phoneNumbersById, [id]: poll.phoneNumbers } }));
            return;
          }
          if (poll.status === 'error') {
            throw new Error(poll.message);
          }
          if (Date.now() >= deadline) {
            throw new Error('Apollo dar negrąžino telefono numerio — bandykite dar kartą po kelių minučių');
          }
          await sleep(Math.min(Math.max(poll.retryAfterSeconds, 5), 20) * 1000);
        }
      } finally {
        usePendingPhoneSearchStore.getState().finish();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Nepavyko atskleisti telefono numerio';
      set((s) => ({ phoneErrors: { ...s.phoneErrors, [id]: message } }));
    } finally {
      set((s) => {
        const phonePendingIds = { ...s.phonePendingIds };
        delete phonePendingIds[id];
        return { phonePendingIds };
      });
    }
  },
}));
