import { useRef, useState } from 'react';
import { translateJobTitle, type PeopleSearchParams } from '../../utils/apolloApi';
import { ComboBoxMultiInput } from './ComboBoxMultiInput';
import { CompanyLookupInput } from './CompanyLookupInput';
import { FilterAccordionSection } from './FilterAccordionSection';
import { COUNTRIES } from '../../utils/countries';
import { JOB_TITLES } from '../../utils/jobTitles';
import { EMPLOYEE_RANGES } from '../../utils/employeeRanges';
import { SENIORITIES } from '../../utils/seniorities';
import { EMAIL_STATUSES } from '../../utils/emailStatuses';
import { INDUSTRIES } from '../../utils/industries';

interface PeopleFilterFormProps {
  params: PeopleSearchParams;
  onChange: (params: PeopleSearchParams) => void;
  onSubmit: () => void;
  loading: boolean;
  /** Hides the whole "Įmonė" section (CompanyLookupInput + the plain
   * domain field) below — on explicit request, for ApolloContactSearchModal.tsx's
   * people-search step specifically: that flow already made the user
   * explicitly pick one exact company in its own first step (shown in
   * the "Pasirinkta įmonė: ..." hint just above this form), so offering
   * a second, separate company lookup here — its own paid Apollo call —
   * was pure redundancy: a real, reported case of a user paying for a
   * second company-search credit to re-find a company the app already
   * had locked in. SearchView.tsx's own "Žmonės" mode omits this prop
   * (defaults to false) since there this section is the *only* way to
   * filter people by employer at all, not a redundant second path. */
  hideCompanySection?: boolean;
}

const splitList = (v: string): string[] | undefined => {
  const parts = v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
};
const joinList = (v?: string[]) => (v ?? []).join(', ');
const count = (...vals: Array<unknown>) => vals.filter((v) => v !== undefined && v !== null && v !== '').length;

/** One collapsible section per filter group — same reasoning/pattern as
 * CompanyFilterForm.tsx, mirroring Apollo's own People Search sidebar
 * (Job Titles, Location, # Employees, … each a collapsed row, expanding
 * only on click) instead of the older "basic fields always visible + one
 * flat show-more toggle" layout. Every field still maps to a real,
 * documented /mixed_people/api_search parameter (confirmed against
 * Apollo's own published API reference at docs.apollo.io/reference/
 * people-api-search) — only the layout changed. "Company name" is the one
 * field worth calling out: People Search has no free-text org-name
 * parameter at all (only organization_ids and q_organization_domains_list),
 * so CompanyLookupInput resolves a typed name to an id via the real
 * Company Search endpoint first — the same two-step Apollo's own product
 * does internally, just not hidden behind an undocumented endpoint this
 * app doesn't have access to. */
export function PeopleFilterForm({ params, onChange, onSubmit, loading, hideCompanySection }: PeopleFilterFormProps) {
  const [seniorities, setSeniorities] = useState<string[]>(params.person_seniorities ?? []);
  const [emailStatuses, setEmailStatuses] = useState<string[]>(params.contact_email_status ?? []);
  const [employeeRanges, setEmployeeRanges] = useState<string[]>(params.organization_num_employees_ranges ?? []);
  // See the "Įmonė" section below — companyLookupIds drives the lookup's
  // own chip display (kept independent of organization_ids, which is
  // usually left empty in favor of domains). companyLookupDomainsRef
  // tracks which domains in params.q_organization_domains_list came from
  // the lookup specifically, so picking/removing a company there only
  // touches its own contribution, not domains typed directly into
  // "Įmonės domenas".
  const [companyLookupIds, setCompanyLookupIds] = useState<string[]>([]);
  const companyLookupDomainsRef = useRef<string[]>([]);
  // Read by the Pareigos translate-on-add effect below, which resolves
  // asynchronously (after a real network round trip) — by the time it
  // does, `params` as this render closed over it may already be stale
  // (the user could have toggled another filter in the meantime). A ref,
  // kept current on every render, means the swap always merges onto
  // whatever the *latest* params actually are, not a stale snapshot.
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const set = <K extends keyof PeopleSearchParams>(key: K, value: PeopleSearchParams[K]) =>
    onChange({ ...params, [key]: value });

  const JOB_TITLE_VALUES = new Set(JOB_TITLES.map((t) => t.value));
  // Shared by both title filters below ("Pareigos" and "Darbo skelbimai"'s
  // own "Pareigos skelbimuose") — picking from the suggestion list already
  // sends Apollo's own English `value` (see jobTitles.ts), so this only
  // ever fires for a genuinely custom-typed entry, translating it in the
  // background and swapping it in place once done. The chip shows the
  // original text immediately (translation isn't blocking); if it fails,
  // the original text is simply what stays.
  const handleTitlesChange = (key: 'person_titles' | 'q_organization_job_titles') => (v: string[]) => {
    const prev = (paramsRef.current[key] as string[] | undefined) ?? [];
    set(key, v.length > 0 ? v : undefined);
    const added = v.find((x) => !prev.includes(x));
    if (!added || JOB_TITLE_VALUES.has(added)) return;
    void translateJobTitle(added).then(({ title }) => {
      if (!title || title === added) return;
      const current = (paramsRef.current[key] as string[] | undefined) ?? [];
      if (!current.includes(added)) return; // removed again before the translation came back
      const next = current.map((x) => (x === added ? title : x));
      onChange({ ...paramsRef.current, [key]: next });
    });
  };

  // "Raktažodžiai" (free text) and "Industrija" (picked from Apollo's own
  // list) — see the FilterAccordionSection below for why both are folded
  // into the same q_keywords param. Local state, not derived from
  // params.q_keywords, because that combined string can't be losslessly
  // split back into "which part was free text vs. industry" once merged.
  const [freeKeywords, setFreeKeywords] = useState('');
  const [industrija, setIndustrija] = useState<string[]>([]);
  const updateKeywords = (nextFree: string, nextIndustrija: string[]) => {
    const combined = [nextFree.trim(), ...nextIndustrija].filter(Boolean).join(' ');
    set('q_keywords', combined || undefined);
  };

  const toggleSeniority = (s: string) => {
    const next = seniorities.includes(s) ? seniorities.filter((x) => x !== s) : [...seniorities, s];
    setSeniorities(next);
    set('person_seniorities', next.length > 0 ? next : undefined);
  };
  const toggleEmailStatus = (s: string) => {
    const next = emailStatuses.includes(s) ? emailStatuses.filter((x) => x !== s) : [...emailStatuses, s];
    setEmailStatuses(next);
    set('contact_email_status', next.length > 0 ? next : undefined);
  };
  const toggleEmployeeRange = (v: string) => {
    const next = employeeRanges.includes(v) ? employeeRanges.filter((x) => x !== v) : [...employeeRanges, v];
    setEmployeeRanges(next);
    set('organization_num_employees_ranges', next.length > 0 ? next : undefined);
  };

  return (
    <form
      className="search-filters"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <FilterAccordionSection title="Visi raktažodžiai" activeCount={(freeKeywords.trim() ? 1 : 0) + industrija.length} defaultOpen>
        {/* People Search has exactly one free-text parameter (q_keywords, a
            single string — confirmed against Apollo's own API docs, no
            array-based industry-tags field exists here the way
            q_organization_keyword_tags does for Company Search). Split into
            two fields on explicit request, for precision: "Raktažodžiai"
            for anything at all (name, company name, ...) and "Industrija"
            specifically for picking from Apollo's own industry list — but
            both still only have this one real channel to reach Apollo
            through, so they're combined into the same q_keywords string
            here rather than each having their own param. Each field keeps
            its own local text/chip state (freeKeywords/industrija) so
            clearing or editing one never touches the other's contribution
            — only the combined result is what actually reaches `params`. */}
        <label className="search-filter-field">
          <span>Visi raktažodžiai</span>
          <input
            placeholder="Food, Gamyba, Aurimas, CEO"
            value={freeKeywords}
            onChange={(e) => {
              setFreeKeywords(e.target.value);
              updateKeywords(e.target.value, industrija);
            }}
          />
        </label>
        <div className="search-filter-field">
          <span>Industrija</span>
          <ComboBoxMultiInput
            placeholder="Information Technology/IT, Marketing/Advertising/Sales"
            value={industrija}
            onChange={(v) => {
              setIndustrija(v);
              updateKeywords(freeKeywords, v);
            }}
            suggestions={INDUSTRIES}
          />
        </div>
      </FilterAccordionSection>

      <FilterAccordionSection title="Pareigos" activeCount={(params.person_titles?.length ?? 0) + seniorities.length} defaultOpen>
        <div className="search-filter-field">
          <span>Pareigos</span>
          <ComboBoxMultiInput
            placeholder="CEO, Rinkodaros vadybininkas, Pardavimų vadovas"
            value={params.person_titles ?? []}
            onChange={handleTitlesChange('person_titles')}
            suggestions={JOB_TITLES}
          />
        </div>
        <label className="search-filter-field search-filter-checkbox">
          <input
            type="checkbox"
            checked={params.include_similar_titles !== false}
            onChange={(e) => set('include_similar_titles', e.target.checked)}
          />
          <span>Įtraukti panašias pareigas</span>
        </label>
        <div className="search-filter-field">
          <span>Pareigų lygis</span>
          <div className="search-filter-chips">
            {SENIORITIES.map((s) => (
              <button
                type="button"
                key={s.value}
                className={`search-filter-chip ${seniorities.includes(s.value) ? 'search-filter-chip-active' : ''}`}
                onClick={() => toggleSeniority(s.value)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </FilterAccordionSection>

      {!hideCompanySection && (
      <FilterAccordionSection title="Įmonė" activeCount={companyLookupIds.length + (params.q_organization_domains_list?.length ?? 0)} defaultOpen>
        <div className="search-filter-field">
          <span>Įmonės pavadinimas</span>
          <CompanyLookupInput
            // Deliberately NOT params.organization_ids — that param is
            // usually left empty now (see onChange below), but the chips
            // showing which companies are picked need to keep displaying
            // regardless of which underlying param actually carries the
            // search. This used to be bound to organization_ids directly,
            // which was a real, reproduced bug: picking a company visibly
            // cleared its own chip immediately, because the very same
            // onChange call had just cleared organization_ids in favor of
            // the (correct, working) domain.
            value={companyLookupIds}
            onChange={(ids, domains) => {
              setCompanyLookupIds(ids);
              // Prefer domain over organization_ids — see
              // CompanyLookupInput.tsx's doc comment for why (a real,
              // reported bug: "Softera Baltic" resolved fine as a company
              // but then found 0 people via its id, vs 82 via its domain).
              // Tracked against a ref so re-picking/removing a company only
              // touches *this* field's own contribution to the shared
              // domains list, not whatever was separately typed into
              // "Įmonės domenas" below.
              const prevContribution = companyLookupDomainsRef.current;
              companyLookupDomainsRef.current = domains;
              const currentDomains = params.q_organization_domains_list ?? [];
              const withoutOldContribution = currentDomains.filter((d) => !prevContribution.includes(d));
              const merged = Array.from(new Set([...withoutOldContribution, ...domains]));
              // One combined onChange call, not two sequential set()s — set()
              // spreads `params` from this render's closure, so two calls in
              // a row silently lose the first one's change (the second
              // spreads the *same* stale params, overwriting it). This was a
              // second real, reproduced bug on top of the chip one above:
              // the domain field visibly stayed empty after picking a
              // company even though the fix was otherwise correct.
              onChange({
                ...params,
                q_organization_domains_list: merged.length > 0 ? merged : undefined,
                // organization_ids only as a last resort, and only when none
                // of the picked companies resolved a domain at all — never
                // alongside domains (Apollo intersects the two params
                // instead of treating them as alternatives, confirmed live:
                // domain alone 82 results, id alone 0, both together also 0).
                organization_ids: domains.length === 0 && ids.length > 0 ? ids : undefined,
              });
            }}
          />
        </div>
        <label className="search-filter-field">
          <span>Įmonės domenas</span>
          <input
            placeholder="imone.lt, google.com"
            value={joinList(params.q_organization_domains_list)}
            onChange={(e) => set('q_organization_domains_list', splitList(e.target.value))}
          />
        </label>
      </FilterAccordionSection>
      )}

      <FilterAccordionSection title="Lokacija" activeCount={params.person_locations?.length ?? 0} defaultOpen>
        <div className="search-filter-field">
          <span>Asmens vieta</span>
          <ComboBoxMultiInput
            placeholder="Vilnius, Lietuva"
            value={params.person_locations ?? []}
            onChange={(v) => set('person_locations', v.length > 0 ? v : undefined)}
            suggestions={COUNTRIES}
          />
        </div>
      </FilterAccordionSection>

      <FilterAccordionSection title="# Darbuotojai" activeCount={employeeRanges.length}>
        <div className="search-filter-field">
          <div className="search-filter-chips">
            {EMPLOYEE_RANGES.map((r) => (
              <button
                type="button"
                key={r.value}
                className={`search-filter-chip ${employeeRanges.includes(r.value) ? 'search-filter-chip-active' : ''}`}
                onClick={() => toggleEmployeeRange(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </FilterAccordionSection>

      <FilterAccordionSection title="El. pašto statusas" activeCount={emailStatuses.length}>
        <div className="search-filter-field">
          <div className="search-filter-chips">
            {EMAIL_STATUSES.map((s) => (
              <button
                type="button"
                key={s.value}
                className={`search-filter-chip ${emailStatuses.includes(s.value) ? 'search-filter-chip-active' : ''}`}
                onClick={() => toggleEmailStatus(s.value)}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </FilterAccordionSection>

      <FilterAccordionSection
        title="Organizacija"
        activeCount={count(...(params.organization_locations ?? []), params.revenue_range?.min, params.revenue_range?.max)}
      >
        <div className="search-filter-field">
          <span>Įmonės būstinės vieta</span>
          <ComboBoxMultiInput
            value={params.organization_locations ?? []}
            onChange={(v) => set('organization_locations', v.length > 0 ? v : undefined)}
            suggestions={COUNTRIES}
          />
        </div>
        <div className="search-filter-field search-filter-range">
          <span>Pajamų intervalas ($)</span>
          <div className="search-filter-range-inputs">
            <input
              type="number"
              placeholder="min"
              value={params.revenue_range?.min ?? ''}
              onChange={(e) => set('revenue_range', { ...params.revenue_range, min: e.target.value ? Number(e.target.value) : undefined })}
            />
            <input
              type="number"
              placeholder="max"
              value={params.revenue_range?.max ?? ''}
              onChange={(e) => set('revenue_range', { ...params.revenue_range, max: e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
        </div>
      </FilterAccordionSection>

      <FilterAccordionSection
        title="Technologijos"
        activeCount={count(
          ...(params.currently_using_all_of_technology_uids ?? []),
          ...(params.currently_using_any_of_technology_uids ?? []),
          ...(params.currently_not_using_any_of_technology_uids ?? []),
        )}
      >
        <label className="search-filter-field">
          <span>Naudoja VISAS iš (id su pabraukimais)</span>
          <input
            placeholder="salesforce, hubspot"
            value={joinList(params.currently_using_all_of_technology_uids)}
            onChange={(e) => set('currently_using_all_of_technology_uids', splitList(e.target.value))}
          />
        </label>
        <label className="search-filter-field">
          <span>Naudoja BENT VIENĄ iš</span>
          <input
            value={joinList(params.currently_using_any_of_technology_uids)}
            onChange={(e) => set('currently_using_any_of_technology_uids', splitList(e.target.value))}
          />
        </label>
        <label className="search-filter-field">
          <span>NENAUDOJA nė vienos iš</span>
          <input
            value={joinList(params.currently_not_using_any_of_technology_uids)}
            onChange={(e) => set('currently_not_using_any_of_technology_uids', splitList(e.target.value))}
          />
        </label>
      </FilterAccordionSection>

      <FilterAccordionSection
        title="Darbo skelbimai"
        activeCount={count(
          ...(params.q_organization_job_titles ?? []),
          ...(params.organization_job_locations ?? []),
          params.organization_num_jobs_range?.min,
          params.organization_num_jobs_range?.max,
          params.organization_job_posted_at_range?.min,
          params.organization_job_posted_at_range?.max,
        )}
      >
        <div className="search-filter-field">
          <span>Pareigos skelbimuose</span>
          <ComboBoxMultiInput
            value={params.q_organization_job_titles ?? []}
            onChange={handleTitlesChange('q_organization_job_titles')}
            suggestions={JOB_TITLES}
          />
        </div>
        <div className="search-filter-field">
          <span>Skelbimų vieta</span>
          <ComboBoxMultiInput
            value={params.organization_job_locations ?? []}
            onChange={(v) => set('organization_job_locations', v.length > 0 ? v : undefined)}
            suggestions={COUNTRIES}
          />
        </div>
        <div className="search-filter-field search-filter-range">
          <span>Atvirų darbo vietų skaičius</span>
          <div className="search-filter-range-inputs">
            <input
              type="number"
              placeholder="min"
              value={params.organization_num_jobs_range?.min ?? ''}
              onChange={(e) =>
                set('organization_num_jobs_range', {
                  ...params.organization_num_jobs_range,
                  min: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
            <input
              type="number"
              placeholder="max"
              value={params.organization_num_jobs_range?.max ?? ''}
              onChange={(e) =>
                set('organization_num_jobs_range', {
                  ...params.organization_num_jobs_range,
                  max: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </div>
        </div>
        <div className="search-filter-field search-filter-range">
          <span>Skelbimo paskelbimo data</span>
          <div className="search-filter-range-inputs">
            <input
              type="date"
              value={params.organization_job_posted_at_range?.min ?? ''}
              onChange={(e) =>
                set('organization_job_posted_at_range', { ...params.organization_job_posted_at_range, min: e.target.value || undefined })
              }
            />
            <input
              type="date"
              value={params.organization_job_posted_at_range?.max ?? ''}
              onChange={(e) =>
                set('organization_job_posted_at_range', { ...params.organization_job_posted_at_range, max: e.target.value || undefined })
              }
            />
          </div>
        </div>
      </FilterAccordionSection>

      <div className="search-filter-actions">
        <label className="search-filter-field search-filter-per-page">
          <span>Rezultatų per puslapį</span>
          <input
            type="number"
            min={1}
            max={100}
            value={params.per_page ?? 25}
            onChange={(e) => set('per_page', Number(e.target.value) || 25)}
          />
        </label>
        <button type="submit" className="primary" disabled={loading}>
          {loading ? 'Ieškoma…' : 'Ieškoti žmonių'}
        </button>
      </div>
    </form>
  );
}
