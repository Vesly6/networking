import { useEffect, useState } from 'react';
import { useLinkedInCampaignsStore } from '../../store/useLinkedInCampaignsStore';
import { useLinkedInStore } from '../../store/useLinkedInStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { useToastStore } from '../../store/useToastStore';

const STEP_TYPE_LABEL: Record<string, string> = {
  connect: '🤝 Connection request',
  message: '✉️ Žinutė',
};

/** Only ever shows anything while "manual review" is on (the Safety
 * Engine default) — with it off, the Scheduler's own background tick
 * executes due actions itself, and this list stays empty. Each row is one
 * lead's next due sequence step; approving it fires the real LinkedIn
 * action immediately (see useLinkedInCampaignsStore's approveAction) —
 * same "explicit confirm before a real, unrecoverable side effect" rule
 * as the Testas tab's manual connect and every other real-world action in
 * this app. */
export function PendingApprovalPanel() {
  // GET /api/linkedin/scheduler/pending always returns findDueActions()
  // regardless of manualReviewEnabled — this component's own doc comment
  // above says it "only ever shows anything while manual review is on,"
  // but nothing actually enforced that, which is a real bug: with review
  // off (this account's current, deliberate setting), the background
  // scheduler already handles every due item automatically, yet this panel
  // kept rendering the full due list — 150+ rows, every one framed as
  // "waiting for you to approve," when none of them actually were. Fixed
  // by gating the whole panel on the real setting, matching what the doc
  // comment always claimed. When review is off, there's nothing actionable
  // here at all — progress is what CampaignDetail's Sent/Connected/
  // Messaged panels are for.
  const manualReviewEnabled = useLinkedInStore((s) => s.safety?.settings.manualReviewEnabled ?? true);
  const pendingActions = useLinkedInCampaignsStore((s) => s.pendingActions);
  const pendingReady = useLinkedInCampaignsStore((s) => s.pendingReady);
  const refreshPending = useLinkedInCampaignsStore((s) => s.refreshPending);
  const approvingKeys = useLinkedInCampaignsStore((s) => s.approvingKeys);
  const approveAction = useLinkedInCampaignsStore((s) => s.approveAction);
  const skipLead = useLinkedInCampaignsStore((s) => s.skipLead);
  const personalizingKeys = useLinkedInCampaignsStore((s) => s.personalizingKeys);
  const personalizeAction = useLinkedInCampaignsStore((s) => s.personalizeAction);
  const showToast = useToastStore((s) => s.show);

  // Which row's message is currently open for edit/review — and its
  // draft text, which starts as the AI-personalized suggestion but stays
  // fully editable (the "AI drafts, human reviews" pattern this app uses
  // everywhere an AI feature touches something that gets sent). Only one
  // row at a time, same convention as every other single-item-open state
  // in this codebase (e.g. CellHoverEditor's editingContactId).
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');

  useEffect(() => {
    void refreshPending();
  }, [refreshPending]);

  const handlePersonalize = async (leadId: string, stepId: string) => {
    const key = `${leadId}:${stepId}`;
    const result = await personalizeAction(leadId, stepId);
    if (!result) {
      showToast(useLinkedInCampaignsStore.getState().personalizeError ?? 'Nepavyko personalizuoti');
      return;
    }
    setEditingKey(key);
    setDraftText(result.personalizedText);
  };

  const handleApprove = async (leadId: string, stepId: string, label: string) => {
    const key = `${leadId}:${stepId}`;
    const override = editingKey === key ? draftText.trim() : undefined;
    const previewText = override ? `\n\n"${override}"` : '';
    const ok = await confirmDialog({
      message: `Vykdyti šį veiksmą dabar?\n\n${label}${previewText}\n\nŠio veiksmo atšaukti negalima.`,
      danger: true,
      confirmLabel: 'Vykdyti',
    });
    if (!ok) return;
    const success = await approveAction(leadId, stepId, override);
    showToast(success ? 'Veiksmas įvykdytas' : 'Nepavyko įvykdyti veiksmo');
    if (success && editingKey === key) {
      setEditingKey(null);
      setDraftText('');
    }
  };

  // Permanently removes this lead from the sequence (marks it 'skipped'
  // locally) — not a "snooze until later," which the current due-action
  // model has no real way to express (findDueActions() has no per-item
  // dismissed state to snooze against). Confirmed since it's a one-way
  // door: once skipped, this lead won't come up as due again.
  const handleSkip = async (leadId: string, leadLabel: string) => {
    const ok = await confirmDialog({
      message: `Praleisti "${leadLabel}"? Šis lyderis daugiau nebus siūlomas šioje sekoje.`,
      danger: true,
      confirmLabel: 'Praleisti',
    });
    if (!ok) return;
    await skipLead(leadId);
  };

  if (!manualReviewEnabled) return null;
  if (pendingReady && pendingActions.length === 0) return null;

  return (
    <div className="linkedin-pending-approval">
      <div className="linkedin-pending-approval-header">
        <h4>⏳ Laukia patvirtinimo ({pendingActions.length})</h4>
        <button type="button" onClick={() => void refreshPending()}>
          ↻
        </button>
      </div>
      <p className="linkedin-hint">
        "Rankinis patvirtinimas" įjungtas (numatytasis Safety Engine nustatymas) — šie veiksmai yra jau laukiantys, bet
        nebus vykdomi automatiškai, kol nepatvirtinsite kiekvieno atskirai.
      </p>
      {pendingActions.map((a) => {
        const key = `${a.leadId}:${a.stepId}`;
        const label = `${STEP_TYPE_LABEL[a.stepType] ?? a.stepType} — ${a.leadName ?? a.leadUrl} (${a.campaignName})`;
        const isEditing = editingKey === key;
        return (
          <div key={key} className="linkedin-pending-row-wrap">
            <div className="linkedin-pending-row">
              <span className="linkedin-sequence-step-type">{STEP_TYPE_LABEL[a.stepType] ?? a.stepType}</span>
              <span>{a.leadName || a.leadUrl}</span>
              <span className="linkedin-hint">{a.campaignName}</span>
              {a.messageTemplate?.trim() && (
                <button
                  type="button"
                  disabled={personalizingKeys.has(key)}
                  title="AI perrašo šio žingsnio tekstą šiam konkrečiam lyderiui (vardas/pareigos/įmonė) — galėsite peržiūrėti ir pakeisti prieš siunčiant"
                  onClick={() => void handlePersonalize(a.leadId, a.stepId)}
                >
                  {personalizingKeys.has(key) ? 'Personalizuojama…' : '🤖 Personalizuoti'}
                </button>
              )}
              <button
                type="button"
                className="primary"
                disabled={approvingKeys.has(key)}
                onClick={() => void handleApprove(a.leadId, a.stepId, label)}
              >
                {approvingKeys.has(key) ? 'Vykdoma…' : '✓ Patvirtinti ir siųsti'}
              </button>
              <button type="button" onClick={() => void handleSkip(a.leadId, a.leadName || a.leadUrl)}>
                Praleisti
              </button>
            </div>
            {isEditing && (
              <div className="linkedin-pending-edit">
                <textarea
                  autoFocus
                  value={draftText}
                  onChange={(e) => setDraftText(e.target.value)}
                  placeholder="Tekstas, kuris bus išsiųstas…"
                />
                <div className="linkedin-pending-edit-actions">
                  <span className="linkedin-hint">
                    Šis tekstas bus išsiųstas vietoj šablono — peržiūrėkite ir pataisykite prieš patvirtindami.
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingKey(null);
                      setDraftText('');
                    }}
                  >
                    ✕ Atšaukti personalizaciją
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
