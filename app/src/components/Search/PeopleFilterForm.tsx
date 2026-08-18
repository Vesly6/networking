import { useState } from 'react';
import type { PeopleSearchParams } from '../../utils/apolloApi';

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

/** Exposes every documented filter for POST /mixed_people/api_search, not
 * a curated subset — free to search (0 credits), so there's no reason to
 * hide any of them behind an "advanced" toggle. Multi-value fields are a
 * plain comma-separated text input rather than a tag-picker widget — much
 * less UI to build, and just as fast to type into. */
export function PeopleFilterForm({ params, onChange, onSubmit, loading }: PeopleFilterFormProps) {
  const [seniorities, setSeniorities] = useState<string[]>(params.person_seniorities ?? []);
  const [emailStatuses, setEmailStatuses] = useState<string[]>(params.contact_email_status ?? []);

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
      <div className="search-filter-group">
        <div className="search-filter-group-title">Person</div>
        <label className="search-filter-field">
          <span>Job titles (comma-separated)</span>
          <input
            placeholder="CEO, Marketing Manager, Head of Sales"
            value={joinList(params.person_titles)}
            onChange={(e) => set('person_titles', splitList(e.target.value))}
          />
        </label>
        <label className="search-filter-field search-filter-checkbox">
          <input
            type="checkbox"
            checked={params.include_similar_titles !== false}
            onChange={(e) => set('include_similar_titles', e.target.checked)}
          />
          <span>Include similar titles</span>
        </label>
        <label className="search-filter-field">
          <span>Person locations</span>
          <input
            placeholder="Vilnius, Lithuania"
            value={joinList(params.person_locations)}
            onChange={(e) => set('person_locations', splitList(e.target.value))}
          />
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
        <label className="search-filter-field">
          <span>Keywords</span>
          <input placeholder="Free text" value={params.q_keywords ?? ''} onChange={(e) => set('q_keywords', e.target.value || undefined)} />
        </label>
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
        <label className="search-filter-field">
          <span>Org. HQ locations</span>
          <input value={joinList(params.organization_locations)} onChange={(e) => set('organization_locations', splitList(e.target.value))} />
        </label>
        <label className="search-filter-field">
          <span>Org. domains</span>
          <input
            placeholder="apollo.io, google.com"
            value={joinList(params.q_organization_domains_list)}
            onChange={(e) => set('q_organization_domains_list', splitList(e.target.value))}
          />
        </label>
        <label className="search-filter-field">
          <span>Employee count ranges (e.g. 1,10)</span>
          <input
            placeholder="1,10, 50,200"
            value={joinList(params.organization_num_employees_ranges)}
            onChange={(e) => set('organization_num_employees_ranges', splitList(e.target.value))}
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
        <label className="search-filter-field">
          <span>Job titles in postings</span>
          <input
            value={joinList(params.q_organization_job_titles)}
            onChange={(e) => set('q_organization_job_titles', splitList(e.target.value))}
          />
        </label>
        <label className="search-filter-field">
          <span>Job posting locations</span>
          <input
            value={joinList(params.organization_job_locations)}
            onChange={(e) => set('organization_job_locations', splitList(e.target.value))}
          />
        </label>
        <div className="search-filter-field search-filter-range">
          <span>Number of open jobs</span>
          <div className="search-filter-range-inputs">
            <input
              type="number"
              placeholder="min"
              value={params.organization_num_jobs_range?.min ?? ''}
              onChange={(e) =>
                set('organization_num_jobs_range', { ...params.organization_num_jobs_range, min: e.target.value ? Number(e.target.value) : undefined })
              }
            />
            <input
              type="number"
              placeholder="max"
              value={params.organization_num_jobs_range?.max ?? ''}
              onChange={(e) =>
                set('organization_num_jobs_range', { ...params.organization_num_jobs_range, max: e.target.value ? Number(e.target.value) : undefined })
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
              onChange={(e) => set('organization_job_posted_at_range', { ...params.organization_job_posted_at_range, min: e.target.value || undefined })}
            />
            <input
              type="date"
              value={params.organization_job_posted_at_range?.max ?? ''}
              onChange={(e) => set('organization_job_posted_at_range', { ...params.organization_job_posted_at_range, max: e.target.value || undefined })}
            />
          </div>
        </div>
      </div>

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
