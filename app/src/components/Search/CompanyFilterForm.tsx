import { useState } from 'react';
import type { CompanySearchParams } from '../../utils/apolloApi';
import { ComboBoxMultiInput } from './ComboBoxMultiInput';
import { COUNTRIES } from '../../utils/countries';
import { JOB_TITLES } from '../../utils/jobTitles';

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

/** Same basic/advanced split as PeopleFilterForm, mirroring apollo.io's own
 * pattern: Company name, Domains, Location, Employee count, Industry
 * keywords shown by default; Exclude-locations, Revenue, Technology,
 * Funding, and Job postings behind "Show more filters". Every field maps
 * to a real, documented /mixed_companies/search parameter — only the
 * grouping changed, nothing invented. Unlike people search, each page of
 * this one costs 1 Apollo credit, called out explicitly in the submit
 * button rather than hidden. */
export function CompanyFilterForm({ params, onChange, onSubmit, loading }: CompanyFilterFormProps) {
  const [showMore, setShowMore] = useState(false);
  const set = <K extends keyof CompanySearchParams>(key: K, value: CompanySearchParams[K]) =>
    onChange({ ...params, [key]: value });

  return (
    <form
      className="search-filters"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="search-filter-group">
        <label className="search-filter-field">
          <span>Company name (partial match)</span>
          <input value={params.q_organization_name ?? ''} onChange={(e) => set('q_organization_name', e.target.value || undefined)} />
        </label>
        <label className="search-filter-field">
          <span>Domains</span>
          <input
            placeholder="apollo.io, google.com"
            value={joinList(params.q_organization_domains_list)}
            onChange={(e) => set('q_organization_domains_list', splitList(e.target.value))}
          />
        </label>
        <div className="search-filter-field">
          <span>HQ locations</span>
          <ComboBoxMultiInput
            value={params.organization_locations ?? []}
            onChange={(v) => set('organization_locations', v.length > 0 ? v : undefined)}
            suggestions={COUNTRIES}
          />
        </div>
        <label className="search-filter-field">
          <span>Employee count ranges (e.g. 1,10)</span>
          <input
            placeholder="1,10, 50,200"
            value={joinList(params.organization_num_employees_ranges)}
            onChange={(e) => set('organization_num_employees_ranges', splitList(e.target.value))}
          />
        </label>
        <label className="search-filter-field">
          <span>Keyword tags / industry</span>
          <input
            placeholder="software, marketing, saas"
            value={joinList(params.q_organization_keyword_tags)}
            onChange={(e) => set('q_organization_keyword_tags', splitList(e.target.value))}
          />
        </label>
      </div>

      <button type="button" className="search-show-more-toggle" onClick={() => setShowMore((v) => !v)}>
        {showMore ? '− Hide advanced filters' : '+ Show more filters'}
      </button>

      {showMore && (
        <>
          <div className="search-filter-group">
            <div className="search-filter-group-title">Organization</div>
            <div className="search-filter-field">
              <span>Exclude locations</span>
              <ComboBoxMultiInput
                value={params.organization_not_locations ?? []}
                onChange={(v) => set('organization_not_locations', v.length > 0 ? v : undefined)}
                suggestions={COUNTRIES}
              />
            </div>
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
              <span>Using ALL of</span>
              <input
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
            <div className="search-filter-group-title">Funding</div>
            <div className="search-filter-field search-filter-range">
              <span>Latest funding amount ($)</span>
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
              <span>Total funding ($)</span>
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
              <span>Latest funding date</span>
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
          {loading ? 'Searching…' : 'Search companies (1 credit/page)'}
        </button>
      </div>
    </form>
  );
}
