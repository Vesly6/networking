import { useAddApolloResultToTable } from '../../utils/addApolloToTable';
import type { ApolloCompany } from '../../utils/apolloApi';

export function CompanyResultRow({ company }: { company: ApolloCompany }) {
  const { addCompany } = useAddApolloResultToTable();

  return (
    <div className="search-result-row">
      <div className="search-result-main">
        <div className="search-result-name">{company.name ?? 'Unknown company'}</div>
        <div className="search-result-title">{company.primary_domain ?? company.website_url ?? '—'}</div>
        <div className="search-result-company">
          {[company.organization_city, company.organization_country].filter(Boolean).join(', ') || '—'}
        </div>
      </div>
      <div className="search-result-details">
        {company.phone && <div className="search-result-detail">📞 {company.phone}</div>}
        {company.organization_revenue_printed && (
          <div className="search-result-detail">💰 {company.organization_revenue_printed} revenue</div>
        )}
        {typeof company.num_contacts === 'number' && (
          <div className="search-result-detail search-result-detail-muted">{company.num_contacts} contacts in Apollo</div>
        )}
      </div>
      <div className="search-result-actions">
        <button type="button" className="primary" onClick={() => addCompany(company)}>
          + Add to table
        </button>
      </div>
    </div>
  );
}
