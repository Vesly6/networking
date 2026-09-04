import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Phone, Search } from 'lucide-react';
import { fetchApolloCredits, type ApolloCreditUsageStats } from '../../utils/apolloApi';

/** Small credits-remaining readout for the Apollo integration, on
 * explicit request after direct_dial_credit (the pool phone reveals draw
 * from — see apolloApi.ts's own doc comment) ran out mid-cycle with no
 * in-app warning at all; previously the only way to see this was
 * Apollo's own separate dashboard. Shows direct_dial_credit (phone
 * reveals) and lead_credit (search/enrichment) — the two buckets this
 * app's own Apollo features actually spend from.
 *
 * Mounted independently in both places credits get spent here:
 * SearchView.tsx (Paieška tab) and ApolloContactSearchModal.tsx (the "+
 * Pridėti kontaktą" popup, specifically once a company is picked and
 * people search/enrichment starts). Each mount fetches on its own — the
 * underlying call (apolloApi.ts's fetchApolloCredits) is Apollo's own
 * documented zero-cost endpoint, confirmed live not to move any of the
 * numbers it reports, so a shared cache across mounts isn't worth the
 * added state for something this cheap to just re-fetch. */
export function ApolloCreditsIndicator() {
  const [stats, setStats] = useState<ApolloCreditUsageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchApolloCredits()
      .then((r) => setStats(r.credit_usage_stats))
      .catch((err) => setError(err instanceof Error ? err.message : 'Nepavyko gauti kreditų likučio'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (error) {
    return (
      <div className="apollo-credits-indicator apollo-credits-indicator-error">
        <span>{error}</span>
        <button type="button" className="apollo-credits-refresh" onClick={refresh} title="Bandyti dar kartą">
          <RefreshCw className="icon" size={12} />
        </button>
      </div>
    );
  }

  const phone = stats?.direct_dial_credit;
  const lead = stats?.lead_credit;

  return (
    <div className="apollo-credits-indicator">
      {loading && !stats ? (
        <span className="apollo-credits-loading">Kraunami kreditai…</span>
      ) : (
        <>
          {phone && (
            <span
              className={`apollo-credits-item ${phone.left_over === 0 ? 'apollo-credits-empty' : ''}`}
              title="Telefono (mobile/direct dial) kreditai"
            >
              <Phone className="icon" size={13} />
              {phone.left_over.toLocaleString('lt-LT')} / {phone.limit.toLocaleString('lt-LT')}
            </span>
          )}
          {lead && (
            <span className="apollo-credits-item" title="Paieškos / praturtinimo kreditai">
              <Search className="icon" size={13} />
              {lead.left_over.toLocaleString('lt-LT')} / {lead.limit.toLocaleString('lt-LT')}
            </span>
          )}
          <button
            type="button"
            className="apollo-credits-refresh"
            onClick={refresh}
            title="Atnaujinti kreditų likutį"
            disabled={loading}
          >
            <RefreshCw className={`icon ${loading ? 'apollo-credits-spinning' : ''}`} size={12} />
          </button>
        </>
      )}
    </div>
  );
}
