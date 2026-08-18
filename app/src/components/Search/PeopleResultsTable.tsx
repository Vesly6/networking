import { useSearchStore } from '../../store/useSearchStore';
import { useAddApolloResultToTable } from '../../utils/addApolloToTable';
import type { ApolloSearchPerson } from '../../utils/apolloApi';

function PersonRow({ person }: { person: ApolloSearchPerson }) {
  const enriched = useSearchStore((s) => s.enrichedById[person.id]);
  const enriching = useSearchStore((s) => s.enrichingIds[person.id]);
  const enrichError = useSearchStore((s) => s.enrichErrors[person.id]);
  const revealContact = useSearchStore((s) => s.revealContact);
  const { addPerson } = useAddApolloResultToTable();

  const displayName = [person.first_name, enriched?.last_name ?? person.last_name_obfuscated].filter(Boolean).join(' ');
  const phone = enriched?.contact?.phone_numbers?.[0]?.sanitized_number;
  const email = enriched?.email ?? enriched?.contact?.email;

  return (
    <tr>
      <td className="search-results-table-name">{displayName || 'Unknown'}</td>
      <td>{person.title ?? '—'}</td>
      <td>{person.organization?.name ?? '—'}</td>
      <td>
        {enriched ? (
          <>
            {email && <div>✉️ {email}</div>}
            {phone && <div>📞 {phone}</div>}
            {!email && !phone && <span className="search-result-detail-muted">No contact info found</span>}
          </>
        ) : (
          <span className="search-result-detail-muted">
            {person.has_email ? 'Email available' : 'No email'} · {person.has_direct_phone === 'Yes' ? 'Phone available' : 'Phone unlikely'}
          </span>
        )}
        {enrichError && <div className="search-result-detail-error">{enrichError}</div>}
      </td>
      <td className="search-results-table-actions">
        {!enriched && (
          <button type="button" onClick={() => void revealContact(person)} disabled={!!enriching}>
            {enriching ? 'Revealing…' : 'Reveal contact'}
          </button>
        )}
        <button type="button" className="primary" onClick={() => addPerson(person, enriched)}>
          + Add
        </button>
      </td>
    </tr>
  );
}

export function PeopleResultsTable({ people }: { people: ApolloSearchPerson[] }) {
  return (
    <table className="search-results-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Title</th>
          <th>Company</th>
          <th>Contact</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {people.map((p) => (
          <PersonRow key={p.id} person={p} />
        ))}
      </tbody>
    </table>
  );
}
