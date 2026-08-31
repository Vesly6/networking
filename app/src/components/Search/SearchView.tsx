import { useEffect, useState } from 'react';
import { useSearchStore } from '../../store/useSearchStore';
import { useToastStore } from '../../store/useToastStore';
import { PeopleFilterForm } from './PeopleFilterForm';
import { CompanyFilterForm } from './CompanyFilterForm';
import { PeopleResultsTable } from './PeopleResultsTable';
import { CompanyResultsTable } from './CompanyResultsTable';
import { ChevronUp, ChevronDown, ArrowLeft, ArrowRight } from 'lucide-react';

/** Apollo.io lookup — People Search (free) and Company Search (1 credit
 * per page), laid out the way Apollo's own product is: a filter sidebar
 * on the left, results as a table on the right, rather than a filter
 * form stacked above a card list (the first version of this tab) —
 * requested explicitly after seeing that version, to match what the
 * account is already used to from apollo.io itself.
 *
 * Per-result "Reveal contact" (enrichment, 1-9 credits) and "Add to
 * table" (free, maps into the active table's existing Company/Contact/
 * Phone/Link columns — see utils/addApolloToTable.ts) live on each table
 * row. All state lives in useSearchStore, not component state, so it
 * survives this tab being hidden (App.tsx's tab-panel visibility toggle)
 * the same way Table/Calendar/Calls' own state does — a filter you built
 * up and results you were reviewing don't reset just from tabbing over
 * to check something in the table. */
export function SearchView() {
  const mode = useSearchStore((s) => s.mode);
  const setMode = useSearchStore((s) => s.setMode);

  const peopleParams = useSearchStore((s) => s.peopleParams);
  const setPeopleParams = useSearchStore((s) => s.setPeopleParams);
  const people = useSearchStore((s) => s.people);
  const peopleTotal = useSearchStore((s) => s.peopleTotal);
  const peoplePage = useSearchStore((s) => s.peoplePage);
  const peopleLoading = useSearchStore((s) => s.peopleLoading);
  const peopleError = useSearchStore((s) => s.peopleError);
  const runPeopleSearch = useSearchStore((s) => s.runPeopleSearch);

  const companyParams = useSearchStore((s) => s.companyParams);
  const setCompanyParams = useSearchStore((s) => s.setCompanyParams);
  const companies = useSearchStore((s) => s.companies);
  const companiesTotal = useSearchStore((s) => s.companiesTotal);
  const companiesPage = useSearchStore((s) => s.companiesPage);
  const companiesLoading = useSearchStore((s) => s.companiesLoading);
  const companiesError = useSearchStore((s) => s.companiesError);
  const runCompanySearch = useSearchStore((s) => s.runCompanySearch);

  // Mobile only (see .search-sidebar's collapsed state in App.css) — the
  // sidebar is a fixed 320px column sitting next to the results on
  // desktop, which is most of a phone's actual screen width; real,
  // reported complaint was that the results area got squeezed down to
  // nothing ("всё сплющивается") the moment there was anything to show.
  // Starts expanded so the filter form is what a first-time visitor
  // actually sees, same reasoning as the main toolbar's own collapse
  // toggle starting the other way (collapsed) — that one hides controls
  // for an already-populated table, this one exists to be filled in first.
  const [filtersExpanded, setFiltersExpanded] = useState(true);

  const showToast = useToastStore((s) => s.show);
  useEffect(() => {
    if (peopleError) showToast(peopleError);
  }, [peopleError, showToast]);
  useEffect(() => {
    if (companiesError) showToast(companiesError);
  }, [companiesError, showToast]);

  // Auto-collapses the filter panel once a search actually runs — on
  // request, since manually tapping "Slėpti filtrus" first wasn't
  // something everyone thought to do, and the whole point of running a
  // search is to look at what it found. Desktop-gated (matchMedia against
  // the same 640px breakpoint every mobile-only CSS rule in this file
  // uses) since the side-by-side layout there has no reason to collapse
  // after every search — filtersExpanded only visually does anything
  // below that breakpoint to begin with, this just also stops it from
  // silently flipping state in the background on desktop for no visible
  // effect. Always collapses regardless of result count — a zero-result
  // search still means "show me what happened," not "keep tweaking blind."
  const runSearchAndCollapse = async (run: () => Promise<void>) => {
    await run();
    if (window.matchMedia('(max-width: 640px)').matches) setFiltersExpanded(false);
  };

  const perPage = mode === 'people' ? peopleParams.per_page ?? 25 : companyParams.per_page ?? 25;
  const total = mode === 'people' ? peopleTotal : companiesTotal;
  const page = mode === 'people' ? peoplePage : companiesPage;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const loading = mode === 'people' ? peopleLoading : companiesLoading;

  return (
    <div className="search-view">
      <aside className={`search-sidebar ${filtersExpanded ? 'search-sidebar-expanded' : 'search-sidebar-collapsed'}`}>
        <div className="search-mode-switch">
          <button type="button" className={mode === 'people' ? 'active' : ''} onClick={() => setMode('people')}>
            Žmonės
          </button>
          <button type="button" className={mode === 'companies' ? 'active' : ''} onClick={() => setMode('companies')}>
            Įmonės
          </button>
          <button
            type="button"
            className="search-filters-toggle"
            onClick={() => setFiltersExpanded((v) => !v)}
          >
            {filtersExpanded ? <>Slėpti filtrus <ChevronUp className="icon" size={14} /></> : <>Filtrai <ChevronDown className="icon" size={14} /></>}
          </button>
        </div>
        {filtersExpanded && (mode === 'people' ? (
          <PeopleFilterForm
            params={peopleParams}
            onChange={setPeopleParams}
            onSubmit={() => void runSearchAndCollapse(() => runPeopleSearch(1))}
            loading={peopleLoading}
          />
        ) : (
          <CompanyFilterForm
            params={companyParams}
            onChange={setCompanyParams}
            onSubmit={() => void runSearchAndCollapse(() => runCompanySearch(1))}
            loading={companiesLoading}
          />
        ))}
      </aside>

      <div className="search-main">
        {total > 0 && (
          <div className="search-results-header">
            <span>
              Rezultatų: {total.toLocaleString('lt-LT')} — puslapis {page} iš{' '}
              {totalPages.toLocaleString('lt-LT')}
            </span>
            <div className="search-pagination">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => void (mode === 'people' ? runPeopleSearch(page - 1) : runCompanySearch(page - 1))}
              >
                <ArrowLeft className="icon" size={14} /> Atgal
              </button>
              <button
                type="button"
                disabled={page >= totalPages || loading}
                onClick={() => void (mode === 'people' ? runPeopleSearch(page + 1) : runCompanySearch(page + 1))}
              >
                Pirmyn <ArrowRight className="icon" size={14} />
              </button>
            </div>
          </div>
        )}

        {mode === 'people' ? (
          people.length > 0 ? (
            <PeopleResultsTable people={people} />
          ) : (
            !peopleLoading && <div className="empty-state">Nustatykite filtrus ir ieškokite, kad čia pamatytumėte žmones.</div>
          )
        ) : companies.length > 0 ? (
          <CompanyResultsTable companies={companies} />
        ) : (
          !companiesLoading && <div className="empty-state">Nustatykite filtrus ir ieškokite, kad čia pamatytumėte įmones.</div>
        )}
      </div>
    </div>
  );
}
