import { useState } from 'react';
import type { CompanySearchParams } from '../../utils/apolloApi';
import { ComboBoxMultiInput } from './ComboBoxMultiInput';
import { FilterAccordionSection } from './FilterAccordionSection';
import { COUNTRIES } from '../../utils/countries';
import { JOB_TITLES } from '../../utils/jobTitles';
import { EMPLOYEE_RANGES } from '../../utils/employeeRanges';
import { INDUSTRIES } from '../../utils/industries';

interface CompanyFilterFormProps {
  params: CompanySearchParams;
  onChange: (params: CompanySearchParams) => void;
  onSubmit: () => void;
  loading: boolean;
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

/** One collapsible section per filter group — on explicit request, to match
 * Apollo's own Company Search sidebar (a list of collapsed rows like
 * "Location", "# Employees", "Industry & Keywords", each expanding only
 * when clicked — see FilterAccordionSection.tsx). Every field here still
 * maps to a real, documented /mixed_companies/search parameter (confirmed
 * against Apollo's own published API reference, docs.apollo.io/reference/
 * organization-search — not invented); only the layout matches Apollo's
 * product now, not just the field list. This also answers a real question
 * asked about parity with Apollo's own UI: their product sidebar has 20+
 * categories (SIC and NAICS, Buying Intent, AI Filters, Signals, Website
 * Visitors, Lookalikes, …) that simply aren't parameters on the public
 * /organization-search endpoint at all — verified directly against
 * Apollo's own API docs, which list *only* `q_organization_keyword_tags`
 * for anything industry-related. Those categories are Apollo's own product
 * UI querying internal, non-public endpoints (and/or gated behind specific
 * plans) — there's no way to wire them up through the API this app
 * actually has access to, so building UI for them would just be
 * decorative controls that silently filter nothing. "Industry & Keywords"
 * below is the one real match — same param, now presented as the same
 * kind of removable-chip multi-value field Apollo's own UI uses for it,
 * instead of a plain comma-separated text box. */
export function CompanyFilterForm({ params, onChange, onSubmit, loading }: CompanyFilterFormProps) {
  const [employeeRanges, setEmployeeRanges] = useState<string[]>(params.organization_num_employees_ranges ?? []);
  const set = <K extends keyof CompanySearchParams>(key: K, value: CompanySearchParams[K]) =>
    onChange({ ...params, [key]: value });
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
      <FilterAccordionSection title="Įmonė" activeCount={count(params.q_organization_name, ...(params.q_organization_domains_list ?? []))} defaultOpen>
        <label className="search-filter-field">
          <span>Įmonės pavadinimas (dalinė atitiktis)</span>
          <input value={params.q_organization_name ?? ''} onChange={(e) => set('q_organization_name', e.target.value || undefined)} />
        </label>
        <label className="search-filter-field">
          <span>Domenai</span>
          <input
            placeholder="imone.lt, google.com"
            value={joinList(params.q_organization_domains_list)}
            onChange={(e) => set('q_organization_domains_list', splitList(e.target.value))}
          />
        </label>
      </FilterAccordionSection>

      <FilterAccordionSection title="Lokacija" activeCount={(params.organization_locations?.length ?? 0) + (params.organization_not_locations?.length ?? 0)}>
        <div className="search-filter-field">
          <span>Būstinės vieta</span>
          <ComboBoxMultiInput
            value={params.organization_locations ?? []}
            onChange={(v) => set('organization_locations', v.length > 0 ? v : undefined)}
            suggestions={COUNTRIES}
          />
        </div>
        <div className="search-filter-field">
          <span>Neįtraukti vietų</span>
          <ComboBoxMultiInput
            value={params.organization_not_locations ?? []}
            onChange={(v) => set('organization_not_locations', v.length > 0 ? v : undefined)}
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

      <FilterAccordionSection title="Industry & Keywords" activeCount={params.q_organization_keyword_tags?.length ?? 0}>
        <div className="search-filter-field">
          <span>Industrija / raktažodžiai</span>
          <ComboBoxMultiInput
            placeholder="software, marketing, saas"
            value={params.q_organization_keyword_tags ?? []}
            onChange={(v) => set('q_organization_keyword_tags', v.length > 0 ? v : undefined)}
            suggestions={INDUSTRIES}
          />
        </div>
      </FilterAccordionSection>

      <FilterAccordionSection title="Pajamos" activeCount={count(params.revenue_range?.min, params.revenue_range?.max)}>
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
          <span>Naudoja VISAS iš</span>
          <input
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
        title="Finansavimas"
        activeCount={count(
          params.latest_funding_amount_range?.min,
          params.latest_funding_amount_range?.max,
          params.total_funding_range?.min,
          params.total_funding_range?.max,
          params.latest_funding_date_range?.min,
          params.latest_funding_date_range?.max,
        )}
      >
        <div className="search-filter-field search-filter-range">
          <span>Paskutinio finansavimo suma ($)</span>
          <div className="search-filter-range-inputs">
            <input
              type="number"
              placeholder="min"
              value={params.latest_funding_amount_range?.min ?? ''}
              onChange={(e) =>
                set('latest_funding_amount_range', {
                  ...params.latest_funding_amount_range,
                  min: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
            <input
              type="number"
              placeholder="max"
              value={params.latest_funding_amount_range?.max ?? ''}
              onChange={(e) =>
                set('latest_funding_amount_range', {
                  ...params.latest_funding_amount_range,
                  max: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </div>
        </div>
        <div className="search-filter-field search-filter-range">
          <span>Bendra finansavimo suma ($)</span>
          <div className="search-filter-range-inputs">
            <input
              type="number"
              placeholder="min"
              value={params.total_funding_range?.min ?? ''}
              onChange={(e) => set('total_funding_range', { ...params.total_funding_range, min: e.target.value ? Number(e.target.value) : undefined })}
            />
            <input
              type="number"
              placeholder="max"
              value={params.total_funding_range?.max ?? ''}
              onChange={(e) => set('total_funding_range', { ...params.total_funding_range, max: e.target.value ? Number(e.target.value) : undefined })}
            />
          </div>
        </div>
        <div className="search-filter-field search-filter-range">
          <span>Paskutinio finansavimo data</span>
          <div className="search-filter-range-inputs">
            <input
              type="date"
              value={params.latest_funding_date_range?.min ?? ''}
              onChange={(e) => set('latest_funding_date_range', { ...params.latest_funding_date_range, min: e.target.value || undefined })}
            />
            <input
              type="date"
              value={params.latest_funding_date_range?.max ?? ''}
              onChange={(e) => set('latest_funding_date_range', { ...params.latest_funding_date_range, max: e.target.value || undefined })}
            />
          </div>
        </div>
      </FilterAccordionSection>

      <FilterAccordionSection
        title="Darbo skelbimai"
        activeCount={count(
          ...(params.q_organization_job_titles ?? []),
          ...(params.organization_job_locations ?? []),
          params.organization_job_posted_at_range?.min,
          params.organization_job_posted_at_range?.max,
        )}
      >
        <div className="search-filter-field">
          <span>Pareigos skelbimuose</span>
          <ComboBoxMultiInput
            value={params.q_organization_job_titles ?? []}
            onChange={(v) => set('q_organization_job_titles', v.length > 0 ? v : undefined)}
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
          {loading ? 'Ieškoma…' : 'Ieškoti įmonių (1 kreditas/puslapis)'}
        </button>
      </div>
    </form>
  );
}
