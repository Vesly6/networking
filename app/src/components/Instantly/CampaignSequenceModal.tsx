import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Mail, Eye, Shuffle } from 'lucide-react';
import { useInstantlyCampaignsStore } from '../../store/useInstantlyCampaignsStore';
import { useToastStore } from '../../store/useToastStore';
import type { InstantlySequenceStep } from '../../utils/instantlyApi';

// A minimal HTML shell so the preview's own line-height/font matches a
// real email client roughly, rather than inheriting this app's own
// spreadsheet-dense styles from inside the iframe (an iframe's contents
// never inherit the parent page's CSS at all, sandboxed or not). The
// .mtag chip style lives here, not App.css, for the same reason —
// nothing outside this document's own <style> reaches inside the iframe.
function buildPreviewDoc(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111;margin:0;padding:0.75rem;word-wrap:break-word;}.mtag{background:#eef2ff;color:#4338ca;border-radius:4px;padding:0 0.35em;font-weight:600;}</style></head><body>${bodyHtml}</body></html>`;
}

// Instantly's spintax: {{RANDOM | option A | option B | ...}} — picks one
// option per real send, which is exactly why the raw stored body reads as
// nonsense rather than an actual email. Resolving it here mirrors that
// same one-random-pick-per-send behavior for a "how will this actually
// look" preview, on explicit request ("хочу видеть как спинтакс на самом
// деле выглядят"); a "Perkurti" (reroll) button lets the user see a
// different roll without pretending there's only ever one true answer.
const SPINTAX_PATTERN = /\{\{\s*random\s*\|([^}]+)\}\}/gi;
// Whatever's left after spintax resolution is a plain personalization
// merge tag (firstName, Greetings, sendingAccountName, ...) — this app has
// no specific recipient to fill one in with at the campaign-sequence
// level, so rather than inventing fake sample data, it's just visually
// marked as a placeholder chip instead of raw, confusing double braces.
const MERGE_TAG_PATTERN = /\{\{\s*([^}|]+?)\s*\}\}/g;

function resolveSpintax(html: string): string {
  return html.replace(SPINTAX_PATTERN, (_match, optionsRaw: string) => {
    const options = optionsRaw
      .split('|')
      .map((o) => o.trim())
      .filter(Boolean);
    if (options.length === 0) return '';
    return options[Math.floor(Math.random() * options.length)];
  });
}

function markMergeTags(html: string): string {
  return html.replace(MERGE_TAG_PATTERN, (_match, tag: string) => `<span class="mtag">${tag}</span>`);
}

function buildPreviewBody(html: string): string {
  return markMergeTags(resolveSpintax(html));
}

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

  const [previewMode, setPreviewMode] = useState(false);
  // Keyed by "stepIndex-variantIndex" — recomputed on toggle-on and on
  // every explicit reroll, never on an unrelated re-render, so the spintax
  // pick shown stays stable until the user actually asks to see another.
  const [resolvedBodies, setResolvedBodies] = useState<Record<string, string>>({});

  useEffect(() => {
    void fetchCampaignDetail(campaignId);
    return () => clearCampaignDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  useEffect(() => {
    setPreviewMode(false);
    setResolvedBodies({});
  }, [campaignId]);

  useEffect(() => {
    if (campaignDetailError) showToast(campaignDetailError);
  }, [campaignDetailError, showToast]);

  const steps = campaignDetail?.id === campaignId ? (campaignDetail.sequences?.[0]?.steps ?? []) : [];

  const rerollPreview = () => {
    const next: Record<string, string> = {};
    steps.forEach((step, stepIndex) => {
      step.variants.forEach((variant, variantIndex) => {
        next[`${stepIndex}-${variantIndex}`] = buildPreviewBody(variant.body);
      });
    });
    setResolvedBodies(next);
  };

  const handleTogglePreview = () => {
    if (!previewMode) rerollPreview();
    setPreviewMode((v) => !v);
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
          <div className="campaign-sequence-toolbar">
            <button type="button" className={previewMode ? 'primary' : undefined} onClick={handleTogglePreview}>
              <Eye className="icon" size={14} /> {previewMode ? 'Rodyti šabloną' : 'Peržiūra (kaip atrodys realiai)'}
            </button>
            {previewMode && (
              <button type="button" onClick={rerollPreview}>
                <Shuffle className="icon" size={14} /> Perkurti spintax
              </button>
            )}
          </div>
        )}
        {previewMode && (
          <p className="instantly-hint">
            Spintax variantai parenkami atsitiktinai, kaip realiame siuntime. Pažymėtos vietos — personalizacijos
            žymos, kurios bus užpildytos konkrečiu kontaktu, ne tikri duomenys.
          </p>
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
                    <div className="search-filter-field">
                      <span>Tekstas</span>
                      <iframe
                        className="campaign-sequence-body-preview"
                        title={`sequence-body-${stepIndex}-${variantIndex}`}
                        sandbox=""
                        srcDoc={buildPreviewDoc(
                          previewMode ? (resolvedBodies[`${stepIndex}-${variantIndex}`] ?? variant.body) : variant.body,
                        )}
                      />
                    </div>
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
