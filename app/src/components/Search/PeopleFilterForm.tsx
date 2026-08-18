import { useState } from 'react';
import type { PeopleSearchParams } from '../../utils/apolloApi';
import { ComboBoxMultiInput } from './ComboBoxMultiInput';
import { CompanyLookupInput } from './CompanyLookupInput';
import { COUNTRIES } from '../../utils/countries';
import { JOB_TITLES } from '../../utils/jobTitles';
import { EMPLOYEE_RANGES } from '../../utils/employeeRanges';
import { SENIORITIES } from '../../utils/seniorities';
import { EMAIL_STATUSES } from '../../utils/emailStatuses';

interface PeopleFilterFormProps {
  params: PeopleSearchParams;
  onChange: (params: PeopleSearchParams) => void;
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

/** Mirrors apollo.io's own People Search panel structure (verified against
 * Apollo's help center / magazine articles, not invented): a small set of
 * filters shown by default — Name, Job Title, Seniority, Company
 * name/domain, Location, Company size — with everything else (revenue,
 * technology, job postings, email status) behind the same "Show more
 * filters" toggle Apollo itself uses, rather than one long flat list of
 * every field at once. Every field still maps to a real, documented
 * /mixed_people/api_search parameter — nothing here is invented, only the
 * grouping. "Company name" is the one exception worth calling out: People
 * Search has no free-text org-name parameter at all (only organization_ids
 * and q_organization_domains_list), so CompanyLookupInput resolves a typed
 * name to an id via the real Company Search endpoint first — the same
 * two-step Apollo's own product does internally, just not hidden behind an
 * undocumented endpoint this app doesn't have access to. */
export function PeopleFilterForm({ params, onChange, onSubmit, loading }: PeopleFilterFormProps) {
  const [seniorities, setSeniorities] = useState<string[]>(params.person_seniorities ?? []);
  const [emailStatuses, setEmailStatuses] = useState<string[]>(params.contact_email_status ?? []);
  const [employeeRanges, setEmployeeRanges] = useState<string[]>(params.organization_num_employees_ranges ?? []);
  const [showMore, setShowMore] = useState(false);

  const set = <K extends keyof PeopleSearchParams>(key: K, value: PeopleSearchParams[K]) =>
    onChange({ ...params, [key]: value });

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
      {/* Basic — always visible, matching Apollo's own default filter set */}
      <div className="search-filter-group">
        <label className="search-filter-field">
          <span>Vardas arba raktažodžiai</span>
          <input
            placeholder="Aurimas Griciunas"
            value={params.q_keywords ?? ''}
            onChange={(e) => set('q_keywords', e.target.value || undefined)}
          />
        </label>
        <div className="search-filter-field">
          <span>Pareigos</span>
          <ComboBoxMultiInput
            placeholder="CEO, Rinkodaros vadybininkas, Pardavimų vadovas"
            value={params.person_titles ?? []}
            onChange={(v) => set('person_titles', v.length > 0 ? v : undefined)}
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
        <div className="search-filter-field">
          <span>Įmonės pavadinimas</span>
          <CompanyLookupInput
            value={params.organization_ids ?? []}
            onChange={(ids) => set('organization_ids', ids.length > 0 ? ids : undefined)}
          />
        </div>
        <label className="search-filter-field">
          <span>Įmonės domenas</span>
          <input
            placeholder="apollo.io, google.com"
            value={joinList(params.q_organization_domains_list)}
            onChange={(e) => set('q_organization_domains_list', splitList(e.target.value))}
          />
        </label>
        <div className="search-filter-field">
          <span>Asmens vieta</span>
          <ComboBoxMultiInput
            placeholder="Vilnius, Lietuva"
            value={params.person_locations ?? []}
            onChange={(v) => set('person_locations', v.length > 0 ? v : undefined)}
            suggestions={COUNTRIES}
          />
        </div>
        <div className="search-filter-field">
          <span>Įmonės dydis</span>
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
      </div>

      <button type="button" className="search-show-more-toggle" onClick={() => setShowMore((v) => !v)}>
        {showMore ? '− Slėpti papildomus filtrus' : '+ Rodyti daugiau filtrų'}
      </button>

      {showMore && (
        <>
          <div className="search-filter-group">
            <div className="search-filter-group-title">Kontaktas</div>
            <div className="search-filter-field">
              <span>El. pašto statusas</span>
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
          </div>

          <div className="search-filter-group">
            <div className="search-filter-group-title">Organizacija</div>
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
          </div>

          <div className="search-filter-group">
            <div className="search-filter-group-title">Technologijos</div>
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
          </div>

          <div className="search-filter-group">
            <div className="search-filter-group-title">Darbo skelbimai</div>
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
          </div>
        </>
      )}

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
