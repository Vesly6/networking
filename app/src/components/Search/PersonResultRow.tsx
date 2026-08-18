import { useSearchStore } from '../../store/useSearchStore';
import { useAddApolloResultToTable } from '../../utils/addApolloToTable';
import type { ApolloSearchPerson } from '../../utils/apolloApi';

export function PersonResultRow({ person }: { person: ApolloSearchPerson }) {
  const enriched = useSearchStore((s) => s.enrichedById[person.id]);
  const enriching = useSearchStore((s) => s.enrichingIds[person.id]);
  const enrichError = useSearchStore((s) => s.enrichErrors[person.id]);
  const revealContact = useSearchStore((s) => s.revealContact);
  const { addPerson } = useAddApolloResultToTable();

  const displayName = [person.first_name, enriched?.last_name ?? person.last_name_obfuscated].filter(Boolean).join(' ');
  const phone = enriched?.contact?.phone_numbers?.[0]?.sanitized_number;
  const email = enriched?.email ?? enriched?.contact?.email;

  return (
    <div className="search-result-row">
      <div className="search-result-main">
        <div className="search-result-name">{displayName || 'Unknown'}</div>
        <div className="search-result-title">{person.title ?? '—'}</div>
        <div className="search-result-company">{person.organization?.name ?? '—'}</div>
      </div>
      <div className="search-result-details">
        {enriched ? (
          <>
            {email && <div className="search-result-detail">✉️ {email}</div>}
            {phone && <div className="search-result-detail">📞 {phone}</div>}
            {!email && !phone && <div className="search-result-detail search-result-detail-muted">No contact info found</div>}
          </>
        ) : (
          <div className="search-result-detail search-result-detail-muted">
            {person.has_email ? 'Email available' : 'No email on file'} ·{' '}
            {person.has_direct_phone === 'Yes' ? 'Phone available' : 'Phone unlikely'}
          </div>
        )}
        {enrichError && <div className="search-result-detail search-result-detail-error">{enrichError}</div>}
      </div>
      <div className="search-result-actions">
        {!enriched && (
          <button type="button" onClick={() => void revealContact(person)} disabled={!!enriching}>
            {enriching ? 'Revealing…' : 'Reveal contact (1-9 credits)'}
          </button>
        )}
        <button type="button" className="primary" onClick={() => addPerson(person, enriched)}>
          + Add to table
        </button>
      </div>
    </div>
  );
}
