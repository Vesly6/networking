import { useState } from 'react';
import { searchCompanies } from '../../utils/apolloApi';
import type { ApolloCompany } from '../../utils/apolloApi';

interface CompanyLookupInputProps {
  value: string[];
  onChange: (organizationIds: string[]) => void;
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
 * Find phone buttons. Picking a result adds its id to organization_ids. */
export function CompanyLookupInput({ value, onChange }: CompanyLookupInputProps) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<ApolloCompany[]>([]);
  const [error, setError] = useState('');
  const [names, setNames] = useState<Record<string, string>>({});

  const runLookup = async () => {
    const q = text.trim();
    if (!q) return;
    setLoading(true);
    setError('');
    try {
      const res = await searchCompanies({ q_organization_name: q, per_page: 5 });
      setResults(res.companies);
      if (res.companies.length === 0) setError('No matching companies found');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Company lookup failed');
    } finally {
      setLoading(false);
    }
  };

  const addCompany = (c: ApolloCompany) => {
    if (!c.id || value.includes(c.id)) return;
    onChange([...value, c.id]);
    setNames((n) => ({ ...n, [c.id]: c.name ?? c.id }));
    setResults([]);
    setText('');
  };
  const removeCompany = (id: string) => onChange(value.filter((x) => x !== id));

  return (
    <div className="company-lookup">
      <div className="combobox-chips">
        {value.map((id) => (
          <span key={id} className="combobox-chip">
            {names[id] ?? id}
            <button type="button" className="combobox-chip-remove" onClick={() => removeCompany(id)} aria-label={`Remove ${names[id] ?? id}`}>
              ×
            </button>
          </span>
        ))}
        <input
          className="combobox-input"
          placeholder={value.length === 0 ? 'Type a company name, press Enter' : ''}
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
          title="Look up this company name (1 credit)"
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
              {c.name ?? 'Unknown'} {c.primary_domain && <span className="search-result-detail-muted">— {c.primary_domain}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
