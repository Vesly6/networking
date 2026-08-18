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

type SearchMode = 'people' | 'companies';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Apollo's own docs say phone delivery "can take several minutes" — this
// caps total wait so a permanently-stuck poll (see the long comment on
// pollWebhookResult in server/src/apollo.ts — this account's phone-reveal
// polling hasn't been confirmed working at all yet) fails clearly instead
// of spinning forever.
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
   * result (see pollPhoneReveal in apolloApi.ts). Known to not reliably
   * resolve yet on this account — see the long comment in server/src/
   * apollo.ts's pollWebhookResult; this still attempts it and times out
   * cleanly rather than skipping the feature entirely, since it may start
   * working with no code change once the underlying cause is resolved. */
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
      const message = err instanceof Error ? err.message : 'Could not search Apollo';
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
      const message = err instanceof Error ? err.message : 'Could not search Apollo';
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
      if (!result.person) throw new Error('No match found for this person');
      set((s) => ({ enrichedById: { ...s.enrichedById, [id]: result.person! } }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not reveal this contact';
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

      const info = result.phone_enrichment;
      if (!info?.request_id) {
        // "skipped" (already in progress from an earlier request) or no
        // phone_enrichment at all — nothing to poll for from this call.
        throw new Error(info?.message ?? 'Apollo did not start a phone lookup for this person');
      }

      const requestId = info.request_id;
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
          throw new Error("Apollo hasn't returned a phone number yet — try again in a few minutes");
        }
        await sleep(Math.min(Math.max(poll.retryAfterSeconds, 5), 20) * 1000);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not reveal a phone number';
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
