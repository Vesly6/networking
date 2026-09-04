import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Mail, Save } from 'lucide-react';
import { useInstantlyCampaignsStore } from '../../store/useInstantlyCampaignsStore';
import { useToastStore } from '../../store/useToastStore';
import { confirmDialog } from '../../store/useConfirmStore';
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

/** Shows (and lets you edit) the actual email copy a campaign sends — on
 * explicit request ("хочу видеть какой текст мы отправляем... и что-то
 * изменить в этом тексте"). Confirmed directly against Instantly's real
 * OpenAPI spec that this is exactly what GET/PATCH /campaigns/{id}'s own
 * `sequences` field is (steps -> variants -> subject/body) — see
 * server/src/instantly.ts's own doc comment on InstantlySequence for the
 * full citation.
 *
 * Local draft state (`steps`) is deliberately separate from the store's
 * own `campaignDetail` — editing a subject/body field updates the draft
 * only; nothing is sent to Instantly until "Išsaugoti" is explicitly
 * clicked and confirmed. The draft re-seeds from campaignDetail whenever
 * it changes (initial load, and again after a successful save, so the
 * form reflects exactly what Instantly actually has on file — not what
 * was locally typed if the save response differs in any way).
 *
 * Only subject/body per step/variant are editable here — delay timing,
 * step count, and variant count are shown read-only. Adding/removing
 * steps or variants, or touching send-timing, was out of scope for what
 * was actually asked for (view + edit the text), and Instantly's own
 * dashboard is still the place for structural sequence changes. */
export function CampaignSequenceModal({ campaignId, onClose }: CampaignSequenceModalProps) {
  const campaignDetail = useInstantlyCampaignsStore((s) => s.campaignDetail);
  const campaignDetailLoading = useInstantlyCampaignsStore((s) => s.campaignDetailLoading);
  const campaignDetailError = useInstantlyCampaignsStore((s) => s.campaignDetailError);
  const fetchCampaignDetail = useInstantlyCampaignsStore((s) => s.fetchCampaignDetail);
  const clearCampaignDetail = useInstantlyCampaignsStore((s) => s.clearCampaignDetail);
  const savingSequence = useInstantlyCampaignsStore((s) => s.savingSequence);
  const saveCampaignError = useInstantlyCampaignsStore((s) => s.saveCampaignError);
  const saveCampaignSequence = useInstantlyCampaignsStore((s) => s.saveCampaignSequence);
  const showToast = useToastStore((s) => s.show);

  const [steps, setSteps] = useState<InstantlySequenceStep[]>([]);

  useEffect(() => {
    void fetchCampaignDetail(campaignId);
    return () => clearCampaignDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  useEffect(() => {
    if (campaignDetail?.id === campaignId) {
      setSteps(campaignDetail.sequences?.[0]?.steps ?? []);
    }
  }, [campaignDetail, campaignId]);

  useEffect(() => {
    if (campaignDetailError) showToast(campaignDetailError);
  }, [campaignDetailError, showToast]);
  useEffect(() => {
    if (saveCampaignError) showToast(saveCampaignError);
  }, [saveCampaignError, showToast]);

  const updateVariant = (stepIndex: number, variantIndex: number, field: 'subject' | 'body', value: string) => {
    setSteps((prev) =>
      prev.map((step, si) =>
        si !== stepIndex
          ? step
          : {
              ...step,
              variants: step.variants.map((v, vi) => (vi !== variantIndex ? v : { ...v, [field]: value })),
            },
      ),
    );
  };

  const handleSave = async () => {
    const ok = await confirmDialog({
      message: 'Išsaugoti pakeitimus? Šis tekstas bus siunčiamas realiems žmonėms per šią kampaniją.',
      danger: true,
    });
    if (!ok) return;
    const success = await saveCampaignSequence(campaignId, [{ steps }]);
    if (success) {
      showToast('Kampanijos tekstas išsaugotas');
      onClose();
    }
  };

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
                      <input
                        value={variant.subject}
                        onChange={(e) => updateVariant(stepIndex, variantIndex, 'subject', e.target.value)}
                      />
                    </label>
                    <label className="search-filter-field">
                      <span>Tekstas</span>
                      <textarea
                        className="campaign-sequence-body"
                        rows={6}
                        value={variant.body}
                        onChange={(e) => updateVariant(stepIndex, variantIndex, 'body', e.target.value)}
                      />
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
          {steps.length > 0 && (
            <button type="button" className="primary" disabled={savingSequence} onClick={() => void handleSave()}>
              <Save className="icon" size={14} /> {savingSequence ? 'Saugoma…' : 'Išsaugoti'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
