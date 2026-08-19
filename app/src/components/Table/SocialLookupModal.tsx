import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { findSocialProfiles, type SocialLookupResult } from '../../utils/contactsApi';

type Platform = 'instagram' | 'facebook';

interface SocialLookupModalProps {
  firstName: string;
  lastName: string;
  company: string;
  /** Called the instant the user confirms one platform's result — a
   * specific URL (found, opened and visually verified by the user first)
   * or `null` (confirmed no real match exists). Each platform is decided
   * independently and applied immediately, not batched behind a single
   * "Save" — closing the modal early keeps whatever was already
   * confirmed, same "every action commits itself" convention the rest of
   * CellHoverEditor.tsx already follows for notes/contacts. */
  onConfirm: (platform: Platform, url: string | null) => void;
  onClose: () => void;
}

const PLATFORM_LABEL: Record<Platform, string> = { instagram: 'Instagram', facebook: 'Facebook' };

/** A real, live web search (server's findSocialProfiles, OpenAI's
 * web_search tool) — never auto-saves anything it finds. Apollo's own
 * "confirm the company before searching people" two-step (see
 * ApolloContactSearchModal.tsx) exists for the same underlying reason:
 * automated matching by name alone is unreliable (many people share a
 * name), so the candidates are presented for the user to actually open
 * and visually check (e.g. against a LinkedIn photo) before anything is
 * kept. */
export function SocialLookupModal({ firstName, lastName, company, onConfirm, onClose }: SocialLookupModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [result, setResult] = useState<SocialLookupResult | null>(null);
  const [decided, setDecided] = useState<Partial<Record<Platform, string | null>>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    findSocialProfiles(firstName, lastName, company)
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Nepavyko atlikti paieškos');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = (platform: Platform, url: string | null) => {
    setDecided((prev) => ({ ...prev, [platform]: url }));
    onConfirm(platform, url);
  };

  const renderPlatform = (platform: Platform) => {
    const label = PLATFORM_LABEL[platform];
    if (platform in decided) {
      const url = decided[platform];
      return (
        <div className="social-lookup-platform">
          <div className="social-lookup-platform-title">{label}</div>
          <div className="social-lookup-decided">
            {url ? (
              <>
                ✓ Pasirinkta:{' '}
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {url}
                </a>
              </>
            ) : (
              '✕ Pažymėta: nerasta'
            )}
          </div>
        </div>
      );
    }
    const candidates = platform === 'instagram' ? result?.instagram : result?.facebook;
    return (
      <div className="social-lookup-platform">
        <div className="social-lookup-platform-title">{label}</div>
        {candidates && candidates.length > 0 ? (
          <ul className="social-lookup-candidates">
            {candidates.map((url) => (
              <li key={url} className="social-lookup-candidate">
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {url}
                </a>
                <button type="button" className="primary" onClick={() => confirm(platform, url)}>
                  ✓ Tai jis/ji
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="social-lookup-empty">AI nerado kandidatų.</div>
        )}
        <button type="button" className="social-lookup-not-found" onClick={() => confirm(platform, null)}>
          ✕ Nerasta / nė vienas šitas nėra tas žmogus
        </button>
      </div>
    );
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal social-lookup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="apollo-search-modal-header">
          <h2>🔍 Instagram / Facebook (AI)</h2>
          <button type="button" className="apollo-search-modal-close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="apollo-search-modal-hint">
          Ieškoma: <strong>{[firstName, lastName].filter(Boolean).join(' ') || 'Nežinoma'}</strong>
          {company && <> · {company}</>}
          <br />
          Prieš patvirtindami atidarykite kiekvieną nuorodą ir patikrinkite, ar tai iš tikrųjų tas pats žmogus (pvz. pagal
          nuotrauką iš LinkedIn).
        </p>
        {loading && <div className="empty-state">Ieškoma…</div>}
        {error && <div className="search-result-detail-error">{error}</div>}
        {!loading && !error && result && (
          <div className="social-lookup-platforms">
            {renderPlatform('instagram')}
            {renderPlatform('facebook')}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
