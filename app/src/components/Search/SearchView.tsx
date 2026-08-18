import { useEffect } from 'react';
import { useSearchStore } from '../../store/useSearchStore';
import { useToastStore } from '../../store/useToastStore';
import { PeopleFilterForm } from './PeopleFilterForm';
import { CompanyFilterForm } from './CompanyFilterForm';
import { PeopleResultsTable } from './PeopleResultsTable';
import { CompanyResultsTable } from './CompanyResultsTable';

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

  const showToast = useToastStore((s) => s.show);
  useEffect(() => {
    if (peopleError) showToast(peopleError);
  }, [peopleError, showToast]);
  useEffect(() => {
    if (companiesError) showToast(companiesError);
  }, [companiesError, showToast]);

  const perPage = mode === 'people' ? peopleParams.per_page ?? 25 : companyParams.per_page ?? 25;
  const total = mode === 'people' ? peopleTotal : companiesTotal;
  const page = mode === 'people' ? peoplePage : companiesPage;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const loading = mode === 'people' ? peopleLoading : companiesLoading;

  return (
    <div className="search-view">
      <aside className="search-sidebar">
        <div className="search-mode-switch">
          <button type="button" className={mode === 'people' ? 'active' : ''} onClick={() => setMode('people')}>
            People
          </button>
          <button type="button" className={mode === 'companies' ? 'active' : ''} onClick={() => setMode('companies')}>
            Companies
          </button>
        </div>
        {mode === 'people' ? (
          <PeopleFilterForm
            params={peopleParams}
            onChange={setPeopleParams}
            onSubmit={() => void runPeopleSearch(1)}
            loading={peopleLoading}
          />
        ) : (
          <CompanyFilterForm
            params={companyParams}
            onChange={setCompanyParams}
            onSubmit={() => void runCompanySearch(1)}
            loading={companiesLoading}
          />
        )}
      </aside>

      <div className="search-main">
        {total > 0 && (
          <div className="search-results-header">
            <span>
              {total.toLocaleString('en-US')} result{total === 1 ? '' : 's'} — page {page} of{' '}
              {totalPages.toLocaleString('en-US')}
            </span>
            <div className="search-pagination">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => void (mode === 'people' ? runPeopleSearch(page - 1) : runCompanySearch(page - 1))}
              >
                ← Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages || loading}
                onClick={() => void (mode === 'people' ? runPeopleSearch(page + 1) : runCompanySearch(page + 1))}
              >
                Next →
              </button>
            </div>
          </div>
        )}

        {mode === 'people' ? (
          people.length > 0 ? (
            <PeopleResultsTable people={people} />
          ) : (
            !peopleLoading && <div className="empty-state">Set some filters and search to see people here.</div>
          )
        ) : companies.length > 0 ? (
          <CompanyResultsTable companies={companies} />
        ) : (
          !companiesLoading && <div className="empty-state">Set some filters and search to see companies here.</div>
        )}
      </div>
    </div>
  );
}
