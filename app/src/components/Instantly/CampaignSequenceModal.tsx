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
// .mtag/.mtag-cond chip styles live here, not App.css, for the same
// reason — nothing outside this document's own <style> reaches inside
// the iframe.
function buildPreviewDoc(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111;margin:0;padding:0.75rem;word-wrap:break-word;}.mtag{background:#eef2ff;color:#4338ca;border-radius:4px;padding:0 0.35em;font-weight:600;}.mtag-cond{background:#fff7e6;border:1px dashed #d4a72c;border-radius:4px;padding:0 0.35em;}</style></head><body>${bodyHtml}</body></html>`;
}

function escapeChipText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Resolves one already-inner-resolved {{ ... }} tag body (no {{ }} left
// inside it — resolveTemplate below handles nesting before calling this)
// into: a real random pick for {{RANDOM | a | b}} spintax; a placeholder
// for a plain personalization tag ({{firstName}}); or, for a fallback-
// chain tag ({{companyName | your company}}, {{firstName | lastName | for
// you}} — Instantly's own "Custom Variable" pattern, confirmed against
// Instantly's help docs), a placeholder naming both the field and its
// final literal default — this app has no specific recipient bound at the
// campaign-sequence level, so there's no real per-lead value to show, but
// the fallback text itself is a real, author-written string worth surfacing
// rather than silently dropping. `asHtml` picks HTML chip markup (for the
// body, rendered in the iframe) vs. plain bracket text (for the subject
// line, rendered in a plain <input>, which can't render a <span>).
function resolveTagBody(body: string, asHtml: boolean): string {
  const parts = body.split('|').map((p) => p.trim());
  if (parts[0].toLowerCase() === 'random') {
    const options = parts.slice(1).filter(Boolean);
    if (options.length === 0) return '';
    return options[Math.floor(Math.random() * options.length)];
  }
  if (parts.length > 1) {
    const tagName = parts[0];
    const fallback = parts[parts.length - 1];
    return asHtml
      ? `<span class="mtag">${escapeChipText(tagName)} (numatyta: ${escapeChipText(fallback)})</span>`
      : `[${tagName} (numatyta: ${fallback})]`;
  }
  return asHtml ? `<span class="mtag">${escapeChipText(parts[0])}</span>` : `[${parts[0]}]`;
}

// Instantly's merge/spintax tags can nest — e.g. {{RANDOM | text
// {{companyName}} | {{firstName | lastName | for you}}}} (a documented
// real example, not a hypothetical) — so a single non-recursive regex
// silently breaks on the very first inner "}}" it finds. This scans for
// balanced {{ }} pairs and resolves innermost-first, matching how
// Instantly's own send-time engine handles arbitrary nesting depth. On
// explicit follow-up request after real campaign content (a
// Custom-Variable fallback tag) still showed up raw and unconverted.
function resolveTemplate(text: string, asHtml: boolean): string {
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{' && text[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < text.length && depth > 0) {
        if (text[j] === '{' && text[j + 1] === '{') {
          depth++;
          j += 2;
        } else if (text[j] === '}' && text[j + 1] === '}') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      if (depth > 0) {
        // Unterminated tag — nothing sane to resolve, keep it literal.
        result += text.slice(i);
        break;
      }
      const inner = text.slice(i + 2, j - 2);
      result += resolveTagBody(resolveTemplate(inner, asHtml), asHtml);
      i = j;
    } else {
      result += text[i];
      i++;
    }
  }
  return result;
}

// Instantly's conditional blocks ({% if field == "value" %} ... {% endif
// %}) can't be evaluated without one specific recipient's real data —
// unwrapped to just the enclosed text (marked, in the HTML case, rather
// than silently hidden) instead of left as raw, confusing template syntax.
function resolveConditionals(text: string, asHtml: boolean): string {
  return text.replace(/\{%\s*if[^%]*%\}([\s\S]*?)\{%\s*endif\s*%\}/gi, (_match, inner: string) =>
    asHtml ? `<span class="mtag-cond">${inner}</span>` : inner,
  );
}

function buildPreviewBody(html: string): string {
  return resolveTemplate(resolveConditionals(html, true), true);
}

function buildPreviewSubject(text: string): string {
  return resolveTemplate(resolveConditionals(text, false), false);
}

interface ResolvedVariant {
  subject: string;
  body: string;
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
 * Defaults straight to the resolved preview (previewMode starts true,
 * auto-computed the moment the campaign's steps load) — on explicit
 * follow-up request ("хочу видеть сразу полный вариант без спинтакс"),
 * rather than requiring a manual toggle click first every time this
 * modal opens. The raw/template view is still one click away ("Rodyti
 * šabloną") for anyone who actually wants to see the stored spintax
 * syntax itself.
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

  const [previewMode, setPreviewMode] = useState(true);
  // Keyed by "stepIndex-variantIndex" — recomputed when the campaign's
  // steps first load and on every explicit reroll, never on an unrelated
  // re-render, so the spintax pick shown stays stable until the user
  // actually asks to see another.
  const [resolvedVariants, setResolvedVariants] = useState<Record<string, ResolvedVariant>>({});

  useEffect(() => {
    void fetchCampaignDetail(campaignId);
    return () => clearCampaignDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId]);

  useEffect(() => {
    setPreviewMode(true);
    setResolvedVariants({});
  }, [campaignId]);

  useEffect(() => {
    if (campaignDetailError) showToast(campaignDetailError);
  }, [campaignDetailError, showToast]);

  const steps = campaignDetail?.id === campaignId ? (campaignDetail.sequences?.[0]?.steps ?? []) : [];

  const rerollPreview = () => {
    const next: Record<string, ResolvedVariant> = {};
    steps.forEach((step, stepIndex) => {
      step.variants.forEach((variant, variantIndex) => {
        next[`${stepIndex}-${variantIndex}`] = {
          subject: buildPreviewSubject(variant.subject),
          body: buildPreviewBody(variant.body),
        };
      });
    });
    setResolvedVariants(next);
  };

  useEffect(() => {
    if (steps.length > 0) rerollPreview();
    // Only when the step count actually changes (i.e. once this
    // campaign's data has loaded) — not on every re-render, or an
    // already-shown spintax pick would silently reroll itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.length]);

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
            <button type="button" className={previewMode ? 'primary' : undefined} onClick={() => setPreviewMode((v) => !v)}>
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
                {step.variants.map((variant, variantIndex) => {
                  const resolved = resolvedVariants[`${stepIndex}-${variantIndex}`];
                  return (
                    <div className="campaign-sequence-variant" key={variantIndex}>
                      {step.variants.length > 1 && (
                        <span className="campaign-sequence-variant-label">
                          Variantas {String.fromCharCode(65 + variantIndex)}
                          {variant.v_disabled ? ' (išjungtas)' : ''}
                        </span>
                      )}
                      <label className="search-filter-field">
                        <span>Tema</span>
                        <input value={previewMode ? (resolved?.subject ?? variant.subject) : variant.subject} readOnly />
                      </label>
                      <div className="search-filter-field">
                        <span>Tekstas</span>
                        <iframe
                          className="campaign-sequence-body-preview"
                          title={`sequence-body-${stepIndex}-${variantIndex}`}
                          sandbox=""
                          srcDoc={buildPreviewDoc(previewMode ? (resolved?.body ?? variant.body) : variant.body)}
                        />
                      </div>
                    </div>
                  );
                })}
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
