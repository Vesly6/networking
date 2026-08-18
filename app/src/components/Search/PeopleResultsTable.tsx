import { useSearchStore } from '../../store/useSearchStore';
import { useAddApolloResultToTable } from '../../utils/addApolloToTable';
import type { ApolloSearchPerson } from '../../utils/apolloApi';

function PersonRow({ person }: { person: ApolloSearchPerson }) {
  const enriched = useSearchStore((s) => s.enrichedById[person.id]);
  const enriching = useSearchStore((s) => s.enrichingIds[person.id]);
  const enrichError = useSearchStore((s) => s.enrichErrors[person.id]);
  const revealEmail = useSearchStore((s) => s.revealEmail);

  const phoneNumbers = useSearchStore((s) => s.phoneNumbersById[person.id]);
  const phonePending = useSearchStore((s) => s.phonePendingIds[person.id]);
  const phoneError = useSearchStore((s) => s.phoneErrors[person.id]);
  const revealPhone = useSearchStore((s) => s.revealPhone);

  const { addPerson } = useAddApolloResultToTable();

  const displayName = [person.first_name, enriched?.last_name ?? person.last_name_obfuscated].filter(Boolean).join(' ');
  const email = enriched?.email ?? enriched?.contact?.email;
  const phone = phoneNumbers?.[0]?.sanitized_number;

  return (
    <tr>
      <td className="search-results-table-name">
        {displayName || 'Unknown'}
        {enriched?.linkedin_url && (
          <a href={enriched.linkedin_url} target="_blank" rel="noreferrer" className="search-results-linkedin" title="Open LinkedIn profile">
            🔗 LinkedIn
          </a>
        )}
      </td>
      <td>{person.title ?? '—'}</td>
      <td>{person.organization?.name ?? '—'}</td>
      <td>
        {email && <div>✉️ {email}</div>}
        {phone && <div>📞 {phone}</div>}
        {!email && !enriching && (
          <span className="search-result-detail-muted">{person.has_email ? 'Email available' : 'No email on file'}</span>
        )}
        {!phone && !phonePending && (
          <span className="search-result-detail-muted">
            {' '}
            · {person.has_direct_phone === 'Yes' ? 'Phone available' : 'Phone unlikely'}
          </span>
        )}
        {phonePending && <div className="search-result-detail-muted">Waiting for phone number…</div>}
        {enrichError && <div className="search-result-detail-error">{enrichError}</div>}
        {phoneError && <div className="search-result-detail-error">{phoneError}</div>}
      </td>
      <td className="search-results-table-actions">
        {!email && (
          <button type="button" onClick={() => void revealEmail(person)} disabled={!!enriching}>
            {enriching ? 'Finding…' : 'Find email'}
          </button>
        )}
        {!phone && (
          <button type="button" onClick={() => void revealPhone(person)} disabled={!!phonePending}>
            {phonePending ? 'Finding…' : 'Find phone'}
          </button>
        )}
        <button type="button" className="primary" onClick={() => addPerson(person, enriched, phone)}>
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
