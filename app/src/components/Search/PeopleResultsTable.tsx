import { useSearchStore } from '../../store/useSearchStore';
import { useAddApolloResultToTable } from '../../utils/addApolloToTable';
import { pickBestPhoneNumber, type ApolloSearchPerson } from '../../utils/apolloApi';
import { Link, Mail, Phone } from 'lucide-react';

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

  // `||`, not `??` — Apollo's enrichment response has come back with an
  // empty-string last_name for at least one real match tested against this
  // account, which `??` would happily keep (showing only the first name,
  // reading as "less revealed than before"); `||` falls through to the
  // pre-enrichment obfuscated value the same way a missing field would.
  const firstName = enriched?.first_name || person.first_name;
  const lastName = enriched?.last_name || person.last_name_obfuscated;
  const displayName = [firstName, lastName].filter(Boolean).join(' ');
  const email = enriched?.email ?? enriched?.contact?.email;
  // pickBestPhoneNumber, not [0] — Apollo's phone_numbers array isn't
  // ordered "most personal first" (see apolloApi.ts's own doc comment on
  // a real, reported case where a company switchboard number outranked
  // the person's actual mobile).
  const phone = pickBestPhoneNumber(phoneNumbers)?.sanitized_number;

  return (
    <tr>
      <td className="search-results-table-name">
        {displayName || 'Nežinoma'}
        {enriched?.linkedin_url && (
          <a href={enriched.linkedin_url} target="_blank" rel="noreferrer" className="search-results-linkedin" title="Atverti LinkedIn profilį">
            <Link className="icon" size={14} /> LinkedIn
          </a>
        )}
      </td>
      <td>{person.title ?? '—'}</td>
      <td>{person.organization?.name ?? '—'}</td>
      <td>
        {email && <div><Mail className="icon" size={14} /> {email}</div>}
        {phone && <div><Phone className="icon" size={14} /> {phone}</div>}
        {!email && !enriching && (
          <span className="search-result-detail-muted">{person.has_email ? 'El. paštas žinomas' : 'El. pašto nėra'}</span>
        )}
        {!phone && !phonePending && phoneNumbers !== undefined && (
          // revealPhone already ran and came back with data — just none of
          // it was tagged mobile (on explicit request, only a mobile
          // number ever counts as "found"; work/direct-dial/home numbers
          // are not offered as a fallback). Distinct from the pre-search
          // hint below so this doesn't read as "hasn't been searched yet."
          <span className="search-result-detail-muted"> · Mobilaus numerio nerasta</span>
        )}
        {!phone && !phonePending && phoneNumbers === undefined && (
          <span className="search-result-detail-muted">
            {' '}
            · {person.has_direct_phone === 'Yes' ? 'Telefonas žinomas' : 'Telefonas mažai tikėtinas'}
          </span>
        )}
        {phonePending && <div className="search-result-detail-muted">Laukiama telefono numerio…</div>}
        {enrichError && <div className="search-result-detail-error">{enrichError}</div>}
        {phoneError && <div className="search-result-detail-error">{phoneError}</div>}
      </td>
      <td>
        <div className="search-results-table-actions">
          {!email && (
            <button type="button" onClick={() => void revealEmail(person)} disabled={!!enriching}>
              {enriching ? 'Ieškoma…' : 'Ieškoti el. pašto'}
            </button>
          )}
          {!phone && phoneNumbers === undefined && (
            <button type="button" onClick={() => void revealPhone(person)} disabled={!!phonePending}>
              {phonePending ? 'Ieškoma…' : 'Ieškoti telefono'}
            </button>
          )}
          <button type="button" className="primary" onClick={() => addPerson(person, enriched, phone)}>
            + Pridėti
          </button>
        </div>
      </td>
    </tr>
  );
}

export function PeopleResultsTable({ people }: { people: ApolloSearchPerson[] }) {
  return (
    <table className="search-results-table search-results-table-people">
      <thead>
        <tr>
          <th>Vardas</th>
          <th>Pareigos</th>
          <th>Įmonė</th>
          <th>Kontaktas</th>
          <th>Veiksmai</th>
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
