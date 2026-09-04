import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Mail } from 'lucide-react';
import { useInstantlyCampaignsStore } from '../../store/useInstantlyCampaignsStore';
import { useToastStore } from '../../store/useToastStore';
import type { InstantlySequenceStep } from '../../utils/instantlyApi';

interface CampaignSequenceModalProps {
  campaignId: string;
  onClose: () => void;
}

function delayLabel(step: InstantlySequenceStep, index: number): string {
  if (index === 0) return 'Pirmas laiškas';
  const unit = step.delay_unit === 'minutes' ? 'min.' : step.delay_unit === 'hours' ? 'val.' : 'd.';
  return `Po ${step.delay ?? 0} ${unit} nuo ankstesnio laiško`;
}

/** Shows the actual email copy a campaign sends — on explicit request
 * ("хочу видеть какой текст мы отправляем"). Read-only, on explicit
 * follow-up request ("удали кнопку Išsaugoti... они видят только текст"
 * — no edit/save capability at all, viewing only). Confirmed directly
 * against Instantly's real OpenAPI spec that this is exactly what GET
 * /campaigns/{id}'s own `sequences` field is (steps -> variants ->
 * subject/body) — see server/src/instantly.ts's own doc comment on
 * InstantlySequence for the full citation.
 *
 * server/src/instantly.ts's updateCampaign() and the store's own
 * saveCampaignSequence action are left in place (harmless, unused) —
 * same "flag/remove the UI, keep the capability underneath" pattern
 * this app already uses elsewhere (e.g. AccountsPanel.tsx's own removed
 * mailbox-management actions) — rather than torn out, in case editing
 * needs to come back later. */
export function CampaignSequenceModal({ campaignId, onClose }: CampaignSequenceModalProps) {
  const campaignDetail = useInstantlyCampaignsStore((s) => s.campaignDetail);
  const campaignDetailLoading = useInstantlyCampaignsStore((s) => s.campaignDetailLoading);
  const campaignDetailError = useInstantlyCampaignsStore((s) => s.campaignDetailError);
  const fetchCampaignDetail = useInstantlyCampaignsStore((s) => s.fetchCampaignDetail);
  const clearCampaignDetail = useInstantlyCampaignsStore((s) => s.clearCampaignDetail);
  const showToast = useToastStore((s) => s.show);

  useEffect(() => {
    void fetchCampaignDetail(campaignId);
    return () => clearCampaignDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  useEffect(() => {
    if (campaignDetailError) showToast(campaignDetailError);
  }, [campaignDetailError, showToast]);

  const steps = campaignDetail?.id === campaignId ? (campaignDetail.sequences?.[0]?.steps ?? []) : [];

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal campaign-sequence-modal" onClick={(e) => e.stopPropagation()}>
        <div className="apollo-search-modal-header">
          <h2><Mail className="icon" size={18} /> {campaignDetail?.name ?? 'Kampanijos tekstas'}</h2>
          <button type="button" className="apollo-search-modal-close" onClick={onClose}>
            <X className="icon" size={16} />
          </button>
        </div>

        {campaignDetailLoading && <p className="instantly-hint">Kraunama…</p>}

        {!campaignDetailLoading && campaignDetail && steps.length === 0 && (
          <p className="instantly-hint">Ši kampanija dar neturi laiškų sekos.</p>
        )}

        {!campaignDetailLoading && steps.length > 0 && (
          <div className="campaign-sequence-steps">
            {steps.map((step, stepIndex) => (
              <div className="campaign-sequence-step" key={stepIndex}>
                <div className="campaign-sequence-step-header">{delayLabel(step, stepIndex)}</div>
                {step.variants.map((variant, variantIndex) => (
                  <div className="campaign-sequence-variant" key={variantIndex}>
                    {step.variants.length > 1 && (
                      <span className="campaign-sequence-variant-label">
                        Variantas {String.fromCharCode(65 + variantIndex)}
                        {variant.v_disabled ? ' (išjungtas)' : ''}
                      </span>
                    )}
                    <label className="search-filter-field">
                      <span>Tema</span>
                      <input value={variant.subject} readOnly />
                    </label>
                    <label className="search-filter-field">
                      <span>Tekstas</span>
                      <textarea className="campaign-sequence-body" rows={6} value={variant.body} readOnly />
                    </label>
                  </div>
                ))}
              </div>
            ))}
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
