import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Info } from 'lucide-react';
import { fetchInstantlyLeads, fetchInstantlyCampaign, type InstantlyLead } from '../../utils/instantlyApi';
import { useToastStore } from '../../store/useToastStore';

interface LeadInfoModalProps {
  email: string;
  campaignId: string | null;
  onClose: () => void;
}

const KNOWN_FIELDS: Array<{ key: keyof InstantlyLead; label: string }> = [
  { key: 'company_name', label: 'Įmonė' },
  { key: 'company_domain', label: 'Domenas' },
  { key: 'job_title', label: 'Pareigos' },
  { key: 'phone', label: 'Telefonas' },
  { key: 'website', label: 'Svetainė' },
];

const KNOWN_KEYS = new Set<string>([
  'id',
  'email',
  'first_name',
  'last_name',
  'campaign',
  'lt_interest_status',
  'status',
  'timestamp_created',
  'timestamp_last_contact',
  ...KNOWN_FIELDS.map((f) => f.key as string),
]);

/** "Which company/lead sent this" info button in Unibox — on explicit
 * request ("должна быть кнопочка информация... какая из какой компании
 * этот лид"). Looks the lead up by email (Instantly's own /leads/list
 * `contacts` filter, an exact-match array — the same endpoint
 * CampaignLeadsModal already uses, just filtered differently) rather than
 * threading full lead data through every email/thread object, since a
 * Unibox thread only ever carries an email address + campaign/lead id,
 * not the lead's own company/job-title/phone fields. Any field beyond the
 * known ones (e.g. custom CSV-import columns) is still shown, generically,
 * under "Papildomi laukai" — on explicit request ("какая информация про
 * него ещё добавлена"), nothing added when the lead was created should be
 * hidden just because this modal doesn't have a named label for it. */
export function LeadInfoModal({ email, campaignId, onClose }: LeadInfoModalProps) {
  const showToast = useToastStore((s) => s.show);
  const [lead, setLead] = useState<InstantlyLead | null>(null);
  const [campaignName, setCampaignName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [leadPage, campaign] = await Promise.all([
          fetchInstantlyLeads({ contacts: [email], limit: 1 }),
          campaignId ? fetchInstantlyCampaign(campaignId).catch(() => null) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setLead(leadPage.items[0] ?? null);
        setCampaignName(campaign?.name ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Nepavyko įkelti informacijos apie kontaktą');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email, campaignId]);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);

  const extraFields = lead
    ? Object.entries(lead).filter(
        ([key, value]) => !KNOWN_KEYS.has(key) && value !== null && value !== undefined && value !== '' && typeof value !== 'object',
      )
    : [];

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal lead-info-modal" onClick={(e) => e.stopPropagation()}>
        <div className="apollo-search-modal-header">
          <h2>
            <Info className="icon" size={18} /> Apie kontaktą
          </h2>
          <button type="button" className="apollo-search-modal-close" onClick={onClose}>
            <X className="icon" size={16} />
          </button>
        </div>

        {loading && <p className="instantly-hint">Kraunama…</p>}
        {!loading && !lead && <p className="instantly-hint">Nepavyko rasti šio kontakto lido informacijos.</p>}

        {!loading && lead && (
          <div className="lead-info-fields">
            <div className="lead-info-row">
              <span className="lead-info-label">Vardas</span>
              <span>{[lead.first_name, lead.last_name].filter(Boolean).join(' ') || '—'}</span>
            </div>
            <div className="lead-info-row">
              <span className="lead-info-label">El. paštas</span>
              <span>{lead.email}</span>
            </div>
            {KNOWN_FIELDS.map(({ key, label }) => {
              const value = lead[key];
              if (!value) return null;
              return (
                <div className="lead-info-row" key={key}>
                  <span className="lead-info-label">{label}</span>
                  <span>{String(value)}</span>
                </div>
              );
            })}
            <div className="lead-info-row">
              <span className="lead-info-label">Kampanija</span>
              <span>{campaignName ?? '—'}</span>
            </div>

            {extraFields.length > 0 && (
              <>
                <div className="lead-info-divider">Papildomi laukai</div>
                {extraFields.map(([key, value]) => (
                  <div className="lead-info-row" key={key}>
                    <span className="lead-info-label">{key}</span>
                    <span>{String(value)}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        <div className="popover-footer">
          <button type="button" onClick={onClose}>
            Uždaryti
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
