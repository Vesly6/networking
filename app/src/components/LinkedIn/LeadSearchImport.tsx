import { useState } from 'react';
import { createPortal } from 'react-dom';
import { searchLeads, type NewLead, type SearchedLead } from '../../utils/linkedinCampaignsApi';
import { Search, X } from 'lucide-react';

interface LeadSearchImportProps {
  onConfirm: (leads: NewLead[]) => void;
  onCancel: () => void;
}

/** LinkedIn-search-driven cousin of LeadCsvImport.tsx — same "review
 * before anything gets added" shape (search -> pick which results to keep
 * -> confirm), just sourced from a live LinkedIn search instead of a
 * file. A real LinkedIn page load happens the moment "Ieškoti" is
 * clicked (server/src/linkedin/page.ts's searchLeads — read-only, no
 * connect/message sent), so this needs the same live Chrome/CDP session
 * every other LinkedIn action does; a connection error surfaces here the
 * same way it would from the Testas tab. */
export function LeadSearchImport({ onConfirm, onCancel }: LeadSearchImportProps) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<SearchedLead[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    setError('');
    try {
      const res = await searchLeads(query.trim());
      setResults(res.results);
      setSelected(new Set(res.results.map((r) => r.linkedinUrl)));
      if (res.results.length === 0) setError('Rezultatų nerasta — pabandykite kitus raktažodžius.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nepavyko atlikti paieškos');
    } finally {
      setSearching(false);
    }
  };

  const toggle = (url: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const handleConfirm = () => {
    if (!results) return;
    const leads: NewLead[] = results
      .filter((r) => selected.has(r.linkedinUrl))
      .map((r) => ({
        linkedinUrl: r.linkedinUrl,
        name: r.name ?? undefined,
        title: r.title ?? undefined,
        company: r.company ?? undefined,
        source: 'linkedin_search',
      }));
    onConfirm(leads);
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal linkedin-search-import-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Ieškoti lyderių LinkedIn</h2>
        <p className="linkedin-hint">
          Raktažodžiai (pvz. "marketing director acme") arba nukopijuota LinkedIn paieškos nuoroda. Peržiūrimas tik
          pirmas rezultatų puslapis — nieko nesiunčiama, tik skaitoma.
        </p>
        <form
          className="linkedin-search-import-form"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSearch();
          }}
        >
          <input
            autoFocus
            placeholder="marketing director acme, arba linkedin.com/search/results/people/?..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="primary" disabled={searching || !query.trim()}>
            {searching ? 'Ieškoma…' : <><Search className="icon" size={16} /> Ieškoti</>}
          </button>
        </form>
        {error && <p className="search-result-detail-error">{error}</p>}

        {results && results.length > 0 && (
          <>
            <p className="linkedin-hint">
              Rasta {results.length} — pažymėti {selected.size} importavimui.
            </p>
            <div className="linkedin-search-import-results">
              {results.map((r) => (
                <label key={r.linkedinUrl} className="linkedin-search-import-result">
                  <input type="checkbox" checked={selected.has(r.linkedinUrl)} onChange={() => toggle(r.linkedinUrl)} />
                  <span className="linkedin-search-import-result-main">
                    <strong>{r.name || r.linkedinUrl}</strong>
                    {(r.title || r.company) && (
                      <span className="linkedin-hint">
                        {' — '}
                        {[r.title, r.company].filter(Boolean).join(' @ ')}
                      </span>
                    )}
                  </span>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="popover-footer">
          <button type="button" onClick={onCancel}>
            <X className="icon" size={16} /> Atšaukti
          </button>
          {results && results.length > 0 && (
            <button type="button" className="primary" disabled={selected.size === 0} onClick={handleConfirm}>
              + Importuoti pažymėtus ({selected.size})
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
