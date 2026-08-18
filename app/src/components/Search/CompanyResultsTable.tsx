import { useAddApolloResultToTable } from '../../utils/addApolloToTable';
import type { ApolloCompany } from '../../utils/apolloApi';

function CompanyRow({ company }: { company: ApolloCompany }) {
  const { addCompany } = useAddApolloResultToTable();
  return (
    <tr>
      <td className="search-results-table-name">{company.name ?? 'Nežinoma įmonė'}</td>
      <td>{company.primary_domain ?? company.website_url ?? '—'}</td>
      <td>{[company.organization_city, company.organization_country].filter(Boolean).join(', ') || '—'}</td>
      <td>{company.phone ?? '—'}</td>
      <td>{company.organization_revenue_printed ?? '—'}</td>
      <td>{typeof company.num_contacts === 'number' ? company.num_contacts : '—'}</td>
      <td>
        <div className="search-results-table-actions">
          <button type="button" className="primary" onClick={() => addCompany(company)}>
            + Pridėti
          </button>
        </div>
      </td>
    </tr>
  );
}

export function CompanyResultsTable({ companies }: { companies: ApolloCompany[] }) {
  return (
    <table className="search-results-table search-results-table-company">
      <thead>
        <tr>
          <th>Įmonė</th>
          <th>Domenas</th>
          <th>Vieta</th>
          <th>Telefonas</th>
          <th>Pajamos</th>
          <th>Kontaktai</th>
          <th>Veiksmai</th>
        </tr>
      </thead>
      <tbody>
        {companies.map((c) => (
          <CompanyRow key={c.id} company={c} />
        ))}
      </tbody>
    </table>
  );
}
