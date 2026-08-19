import { useState } from 'react';
import { searchCompanies } from '../../utils/apolloApi';
import type { ApolloCompany } from '../../utils/apolloApi';

interface CompanyLookupInputProps {
  value: string[];
  /** `domains` is every resolved company's primary_domain, for whichever
   * of `value`'s ids actually has one — see the doc comment below for why
   * the caller should prefer sending *this* to Apollo over the ids
   * themselves. */
  onChange: (organizationIds: string[], domains: string[]) => void;
}

/** People Search has no free-text company-name parameter — confirmed
 * against Apollo's own docs, the only organization filters it documents
 * are organization_ids[] and q_organization_domains_list[]. Apollo's own
 * product resolves a typed company name to an internal id via its own
 * lookup before submitting the real search; this does the same thing
 * using the real, already-integrated Company Search endpoint (1 credit
 * per lookup — same cost already shown on the Companies tab), fired only
 * on Enter/the 🔍 button, never per keystroke, so a credit is never spent
 * without an explicit ask — same reasoning as the separate Find email/
 * Find phone buttons.
 *
 * Picking a result used to add only its id to organization_ids — a real,
 * confirmed bug (reported directly: searching "Softera Baltic" this way
 * found the company but then 0 people, even though the same company by
 * domain finds 82). Verified directly against the live API for several
 * real companies: organization_ids alone returns 0 for a lot of genuinely
 * real companies (their Apollo org record exists but isn't fully linked
 * to their people internally), while the same company's domain hits a far
 * more complete index (Vinted: 0 via id vs 2140 via domain; Softera
 * Baltic 0 vs 82; SEB 0 vs 13097). This now also tracks each picked
 * company's primary_domain and hands it back via onChange, so the caller
 * can search by domain (reliable) instead of id (unreliable) whenever one
 * is available — id is kept as a last-resort fallback only for the rare
 * company with no domain on file at all. */
export function CompanyLookupInput({ value, onChange }: CompanyLookupInputProps) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ApolloCompany[]>([]);
  const [error, setError] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});
  const [domainsById, setDomainsById] = useState<Record<string, string>>({});

  const runLookup = async () => {
    const q = text.trim();
    if (!q) return;
    setLoading(true);
    setError('');
    try {
      const res = await searchCompanies({ q_organization_name: q, per_page: 5 });
      setResults(res.companies);
      if (res.companies.length === 0) setError('Atitinkančių įmonių nerasta');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nepavyko surasti įmonės');
    } finally {
      setLoading(false);
    }
  };

  const addCompany = (c: ApolloCompany) => {
    if (!c.id || value.includes(c.id)) return;
    const nextIds = [...value, c.id];
    const nextDomainsById = c.primary_domain ? { ...domainsById, [c.id]: c.primary_domain } : domainsById;
    setNames((n) => ({ ...n, [c.id]: c.name ?? c.id }));
    setDomainsById(nextDomainsById);
    onChange(nextIds, nextIds.map((id) => nextDomainsById[id]).filter((d): d is string => !!d));
    setResults([]);
    setText('');
  };
  const removeCompany = (id: string) => {
    const nextIds = value.filter((x) => x !== id);
    onChange(nextIds, nextIds.map((i) => domainsById[i]).filter((d): d is string => !!d));
  };

  return (
    <div className="company-lookup">
      <div className="combobox-chips">
        {value.map((id) => (
          <span key={id} className="combobox-chip">
            {names[id] ?? id}
            <button type="button" className="combobox-chip-remove" onClick={() => removeCompany(id)} aria-label={`Pašalinti ${names[id] ?? id}`}>
              ×
            </button>
          </span>
        ))}
        <input
          className="combobox-input"
          placeholder={value.length === 0 ? 'Įveskite įmonės pavadinimą, spauskite Enter' : ''}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void runLookup();
            }
          }}
        />
        <button
          type="button"
          className="company-lookup-btn"
          onClick={() => void runLookup()}
          disabled={loading || !text.trim()}
          title="Ieškoti šios įmonės (1 kreditas)"
        >
          {loading ? '…' : '🔍'}
        </button>
      </div>
      {error && <div className="search-result-detail-error">{error}</div>}
      {results.length > 0 && (
        <div className="combobox-dropdown">
          {results.map((c) => (
            <button
              type="button"
              key={c.id}
              className="combobox-option"
              onMouseDown={(e) => {
                e.preventDefault();
                addCompany(c);
              }}
            >
              {c.name ?? 'Nežinoma'} {c.primary_domain && <span className="search-result-detail-muted">— {c.primary_domain}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
