import { useState } from 'react';
import type { PeopleSearchParams } from '../../utils/apolloApi';
import { ComboBoxMultiInput } from './ComboBoxMultiInput';
import { COUNTRIES } from '../../utils/countries';
import { JOB_TITLES } from '../../utils/jobTitles';

interface PeopleFilterFormProps {
  params: PeopleSearchParams;
  onChange: (params: PeopleSearchParams) => void;
  onSubmit: () => void;
  loading: boolean;
}

const SENIORITIES = ['owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern'];
const EMAIL_STATUSES = ['verified', 'unverified', 'likely_to_engage', 'unavailable'];

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
 * filters shown by default — Name, Job Title, Seniority, Location, Company
 * size — with everything else (org domains/ids, revenue, technology, job
 * postings, email status) behind the same "Show more filters" toggle
 * Apollo itself uses, rather than one long flat list of every field at
 * once. Every field still maps to a real, documented /mixed_people/
 * api_search parameter — nothing here is invented, only the grouping. */
export function PeopleFilterForm({ params, onChange, onSubmit, loading }: PeopleFilterFormProps) {
  const [seniorities, setSeniorities] = useState<string[]>(params.person_seniorities ?? []);
  const [emailStatuses, setEmailStatuses] = useState<string[]>(params.contact_email_status ?? []);
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
          <span>Name or keywords</span>
          <input
            placeholder="Aurimas Griciunas"
            value={params.q_keywords ?? ''}
            onChange={(e) => set('q_keywords', e.target.value || undefined)}
          />
        </label>
        <div className="search-filter-field">
          <span>Job titles</span>
          <ComboBoxMultiInput
            placeholder="CEO, Marketing Manager, Head of Sales"
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
          <span>Include similar titles</span>
        </label>
        <div className="search-filter-field">
          <span>Seniority</span>
          <div className="search-filter-chips">
            {SENIORITIES.map((s) => (
              <button
                type="button"
                key={s}
                className={`search-filter-chip ${seniorities.includes(s) ? 'search-filter-chip-active' : ''}`}
                onClick={() => toggleSeniority(s)}
              >
                {s.replace('_', ' ')}
              </button>
            ))}
          </div>
        </div>
        <div className="search-filter-field">
          <span>Person locations</span>
          <ComboBoxMultiInput
            placeholder="Vilnius, Lithuania"
            value={params.person_locations ?? []}
            onChange={(v) => set('person_locations', v.length > 0 ? v : undefined)}
            suggestions={COUNTRIES}
          />
        </div>
        <label className="search-filter-field">
          <span>Company size (employee ranges, e.g. 1,10)</span>
          <input
            placeholder="1,10, 50,200"
            value={joinList(params.organization_num_employees_ranges)}
            onChange={(e) => set('organization_num_employees_ranges', splitList(e.target.value))}
          />
        </label>
      </div>

      <button type="button" className="search-show-more-toggle" onClick={() => setShowMore((v) => !v)}>
        {showMore ? '− Hide advanced filters' : '+ Show more filters'}
      </button>

      {showMore && (
        <>
          <div className="search-filter-group">
            <div className="search-filter-group-title">Contact</div>
            <div className="search-filter-field">
              <span>Email status</span>
              <div className="search-filter-chips">
                {EMAIL_STATUSES.map((s) => (
                  <button
                    type="button"
                    key={s}
                    className={`search-filter-chip ${emailStatuses.includes(s) ? 'search-filter-chip-active' : ''}`}
                    onClick={() => toggleEmailStatus(s)}
                  >
                    {s.replace(/_/g, ' ')}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="search-filter-group">
            <div className="search-filter-group-title">Organization</div>
            <div className="search-filter-field">
              <span>Org. HQ locations</span>
              <ComboBoxMultiInput
                value={params.organization_locations ?? []}
                onChange={(v) => set('organization_locations', v.length > 0 ? v : undefined)}
                suggestions={COUNTRIES}
              />
            </div>
            <label className="search-filter-field">
              <span>Org. domains</span>
              <input
                placeholder="apollo.io, google.com"
                value={joinList(params.q_organization_domains_list)}
                onChange={(e) => set('q_organization_domains_list', splitList(e.target.value))}
              />
            </label>
            <label className="search-filter-field">
              <span>Org. Apollo IDs</span>
              <input
                placeholder="from a prior company search result's id"
                value={joinList(params.organization_ids)}
                onChange={(e) => set('organization_ids', splitList(e.target.value))}
              />
            </label>
            <div className="search-filter-field search-filter-range">
              <span>Revenue range ($)</span>
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
            <div className="search-filter-group-title">Technology</div>
            <label className="search-filter-field">
              <span>Using ALL of (underscored ids)</span>
              <input
                placeholder="salesforce, hubspot"
                value={joinList(params.currently_using_all_of_technology_uids)}
                onChange={(e) => set('currently_using_all_of_technology_uids', splitList(e.target.value))}
              />
            </label>
            <label className="search-filter-field">
              <span>Using ANY of</span>
              <input
                value={joinList(params.currently_using_any_of_technology_uids)}
                onChange={(e) => set('currently_using_any_of_technology_uids', splitList(e.target.value))}
              />
            </label>
            <label className="search-filter-field">
              <span>NOT using any of</span>
              <input
                value={joinList(params.currently_not_using_any_of_technology_uids)}
                onChange={(e) => set('currently_not_using_any_of_technology_uids', splitList(e.target.value))}
              />
            </label>
          </div>

          <div className="search-filter-group">
            <div className="search-filter-group-title">Job postings</div>
            <div className="search-filter-field">
              <span>Job titles in postings</span>
              <ComboBoxMultiInput
                value={params.q_organization_job_titles ?? []}
                onChange={(v) => set('q_organization_job_titles', v.length > 0 ? v : undefined)}
                suggestions={JOB_TITLES}
              />
            </div>
            <div className="search-filter-field">
              <span>Job posting locations</span>
              <ComboBoxMultiInput
                value={params.organization_job_locations ?? []}
                onChange={(v) => set('organization_job_locations', v.length > 0 ? v : undefined)}
                suggestions={COUNTRIES}
              />
            </div>
            <div className="search-filter-field search-filter-range">
              <span>Number of open jobs</span>
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
              <span>Job posted date range</span>
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
          <span>Results per page</span>
          <input
            type="number"
            min={1}
            max={100}
            value={params.per_page ?? 25}
            onChange={(e) => set('per_page', Number(e.target.value) || 25)}
          />
        </label>
        <button type="submit" className="primary" disabled={loading}>
          {loading ? 'Searching…' : 'Search people'}
        </button>
      </div>
    </form>
  );
}
