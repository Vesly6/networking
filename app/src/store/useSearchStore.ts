import { create } from 'zustand';
import {
  searchPeople as apiSearchPeople,
  searchCompanies as apiSearchCompanies,
  enrichPerson as apiEnrichPerson,
  type PeopleSearchParams,
  type CompanySearchParams,
  type PeopleEnrichParams,
  type ApolloSearchPerson,
  type ApolloCompany,
  type ApolloEnrichedPerson,
} from '../utils/apolloApi';

type SearchMode = 'people' | 'companies';

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
  revealContact: (person: ApolloSearchPerson) => Promise<void>;
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
  revealContact: async (person) => {
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
}));
