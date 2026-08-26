import { useEffect, useState } from 'react';
import { useLinkedInStore } from '../../store/useLinkedInStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { useToastStore } from '../../store/useToastStore';
import type { LinkedInSafetySettings } from '../../utils/linkedinApi';
import { CampaignsPanel } from './CampaignsPanel';
import { InboxPanel } from './InboxPanel';
import { AnalyticsPanel } from './AnalyticsPanel';
import { StaleInvitesPanel } from './StaleInvitesPanel';

type SubTab = 'campaigns' | 'inbox' | 'analytics' | 'stale' | 'test' | 'settings';

const STATUS_LABEL: Record<string, string> = {
  connected: '🟢 Prijungta',
  not_connected: '⚪ Neprijungta',
  logged_out: '🟠 Neprisijungta prie LinkedIn',
  checkpoint: '🔴 LinkedIn reikalauja patvirtinimo',
};

interface SettingsDraft {
  dailyConnectCap: string;
  weeklyConnectCap: string;
  dailyMessageCap: string;
  weeklyMessageCap: string;
  workHoursStart: string;
  workHoursEnd: string;
  warmUpEnabled: boolean;
  warmUpDurationDays: string;
  warmUpStartPct: string;
  manualReviewEnabled: boolean;
}

function toDraft(s: LinkedInSafetySettings): SettingsDraft {
  return {
    dailyConnectCap: String(s.dailyConnectCap),
    weeklyConnectCap: String(s.weeklyConnectCap),
    dailyMessageCap: String(s.dailyMessageCap),
    weeklyMessageCap: String(s.weeklyMessageCap),
    workHoursStart: s.workHoursStart,
    workHoursEnd: s.workHoursEnd,
    warmUpEnabled: s.warmUpEnabled,
    warmUpDurationDays: String(s.warmUpDurationDays),
    warmUpStartPct: String(s.warmUpStartPct),
    manualReviewEnabled: s.manualReviewEnabled,
  };
}

/** Phase 0 proved the CDP/Playwright connection works; this now also
 * carries Phase 1's Safety Engine (caps/work-hours/warm-up, the
 * always-visible pause switch) — see TZ_LinkedIn_Automation.md and the
 * saved plan for the rest of the roadmap (Campaign Engine, lead import,
 * inbox, analytics still ahead). "No action is executed without going
 * through the Safety Engine" — enforced server-side (safety.ts), this
 * view is just its editable front end plus the one manual test action. */
export function LinkedInView() {
  const status = useLinkedInStore((s) => s.status);
  const statusLoading = useLinkedInStore((s) => s.statusLoading);
  const refreshStatus = useLinkedInStore((s) => s.refreshStatus);
  const actions = useLinkedInStore((s) => s.actions);
  const refreshActions = useLinkedInStore((s) => s.refreshActions);
  const sending = useLinkedInStore((s) => s.sending);
  const sendError = useLinkedInStore((s) => s.sendError);
  const sendTestConnect = useLinkedInStore((s) => s.sendTestConnect);
  const safety = useLinkedInStore((s) => s.safety);
  const refreshSafety = useLinkedInStore((s) => s.refreshSafety);
  const savingSettings = useLinkedInStore((s) => s.savingSettings);
  const saveSettingsError = useLinkedInStore((s) => s.saveSettingsError);
  const saveSafetySettings = useLinkedInStore((s) => s.saveSafetySettings);
  const togglePause = useLinkedInStore((s) => s.togglePause);
  const runningScheduler = useLinkedInStore((s) => s.runningScheduler);
  const runSchedulerError = useLinkedInStore((s) => s.runSchedulerError);
  const runScheduler = useLinkedInStore((s) => s.runScheduler);
  const showToast = useToastStore((s) => s.show);

  const [profileUrl, setProfileUrl] = useState('');
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [subTab, setSubTab] = useState<SubTab>('campaigns');

  useEffect(() => {
    void refreshStatus();
    void refreshActions();
    void refreshSafety();
  }, [refreshStatus, refreshActions, refreshSafety]);

  // Only seeds the draft the first time settings arrive (or after a save
  // resets it below) — an in-progress edit shouldn't get silently
  // overwritten by a background refreshSafety() poll landing mid-edit.
  useEffect(() => {
    if (safety && !draft) setDraft(toDraft(safety.settings));
  }, [safety, draft]);

  useEffect(() => {
    if (sendError) showToast(sendError);
  }, [sendError, showToast]);

  useEffect(() => {
    if (saveSettingsError) showToast(saveSettingsError);
  }, [saveSettingsError, showToast]);

  useEffect(() => {
    if (runSchedulerError) showToast(runSchedulerError);
  }, [runSchedulerError, showToast]);

  const paused = safety?.settings.paused ?? false;

  const handleTogglePause = async () => {
    const ok = await confirmDialog({
      message: paused
        ? 'Tęsti LinkedIn automatizaciją? Veiksmai vėl bus leidžiami pagal Safety Engine limitus.'
        : 'Sustabdyti VISUS LinkedIn automatizacijos veiksmus dabar?',
      confirmLabel: paused ? 'Tęsti' : 'Sustabdyti',
      danger: !paused,
    });
    if (!ok) return;
    await togglePause();
    showToast(paused ? 'Automatizacija tęsiama' : 'Automatizacija sustabdyta');
  };

  // The scheduler no longer runs on its own background timer at all (see
  // server/src/index.ts's own doc comment on why — real Chrome window
  // activity happening with no user action was the reported problem) —
  // this button is now the only way a due sequence step ever gets
  // processed. With manual review on (the default) it just refreshes what
  // Pending Approval already shows; with it off, this is what actually
  // sends, so it gets a toast summarizing what happened either way.
  const handleRunScheduler = async () => {
    const result = await runScheduler();
    if (!result) return;
    if (result.skippedConcurrent) {
      showToast('Kita vykdymo eiga jau vyksta — bandykite dar kartą po akimirkos');
      return;
    }
    const parts = [`Rasta veiksmų: ${result.due}`];
    if (result.autoExecuted > 0) parts.push(`įvykdyta: ${result.autoExecuted}`);
    if (result.pendingApproval > 0) parts.push(`laukia patvirtinimo: ${result.pendingApproval}`);
    if (result.errors > 0) parts.push(`klaidų: ${result.errors}`);
    showToast(parts.join(' · '));
  };

  const handleSaveSettings = async () => {
    if (!draft) return;
    const ok = await saveSafetySettings({
      daily_connect_cap: Number(draft.dailyConnectCap) || 0,
      weekly_connect_cap: Number(draft.weeklyConnectCap) || 0,
      daily_message_cap: Number(draft.dailyMessageCap) || 0,
      weekly_message_cap: Number(draft.weeklyMessageCap) || 0,
      work_hours_start: draft.workHoursStart,
      work_hours_end: draft.workHoursEnd,
      warm_up_enabled: draft.warmUpEnabled,
      warm_up_duration_days: Number(draft.warmUpDurationDays) || 1,
      warm_up_start_pct: Number(draft.warmUpStartPct) || 0,
      manual_review_enabled: draft.manualReviewEnabled,
    });
    if (ok) showToast('Nustatymai išsaugoti');
  };

  // A real, unrecoverable side effect against an actual person's LinkedIn
  // account — same "explicit confirm, never automatic or speculative"
  // rule this app already applies to SMS sending and click-to-call.
  const handleSendTestConnect = async () => {
    const url = profileUrl.trim();
    if (!url) return;
    const ok = await confirmDialog({
      message: `Siųsti tikrą LinkedIn connection request į:\n\n${url}${note.trim() ? `\n\nSu žinute: "${note.trim()}"` : ''}\n\nŠio veiksmo atšaukti negalima.`,
      danger: true,
      confirmLabel: 'Siųsti',
    });
    if (!ok) return;
    const success = await sendTestConnect(url, note.trim() || undefined);
    if (success) {
      showToast('Connection request išsiųstas');
      setProfileUrl('');
      setNote('');
    }
  };

  return (
    <div className="linkedin-view">
      <div className="linkedin-header">
        <h2>LinkedIn</h2>
        <div className="linkedin-status-row">
          <span className={`linkedin-status linkedin-status-${status?.status ?? 'not_connected'}`}>
            {statusLoading ? '⏳ Tikrinama…' : STATUS_LABEL[status?.status ?? 'not_connected']}
          </span>
          <button type="button" onClick={() => void refreshStatus()} disabled={statusLoading}>
            ↻ Atnaujinti
          </button>
          <button
            type="button"
            onClick={() => void handleRunScheduler()}
            disabled={runningScheduler || paused}
            title="Sekos nebevyksta automatiškai fone — paspauskite, kad patikrintumėte/vykdytumėte, kas šiuo metu suplanuota"
          >
            {runningScheduler ? 'Vykdoma…' : '▶ Vykdyti dabar'}
          </button>
          {/* Always visible regardless of which section is open below —
              the whole premise of a kill switch is not having to go dig
              for it once something looks off. */}
          <button
            type="button"
            className={paused ? 'primary' : 'linkedin-pause-btn'}
            onClick={() => void handleTogglePause()}
          >
            {paused ? '▶ Tęsti' : '⏸ Sustabdyti viską'}
          </button>
        </div>
      </div>

      {status && status.status !== 'connected' && <p className="linkedin-status-message">{status.message}</p>}
      {paused && <p className="linkedin-paused-banner">⏸ Automatizacija šiuo metu sustabdyta.</p>}

      {safety && (
        <div className="linkedin-safety-summary">
          <span>
            🤝 Šiandien: <strong>{safety.connectsToday}</strong> / {safety.effectiveDailyCap}
          </span>
          <span>
            🤝 Šią savaitę: <strong>{safety.connectsThisWeek}</strong> / {safety.effectiveWeeklyCap}
          </span>
          <span
            title="Kiek profilių iš viso patikrinta šiandien (nesvarbu, sėkmingai ar ne) — atskira riba, apsauganti nuo per didelio aktyvumo, kai dauguma laidų pasirodo jau esami kontaktai"
          >
            👀 Patikrinta šiandien: <strong>{safety.attemptsToday}</strong> / {safety.dailyAttemptCap}
          </span>
          <span>
            ✉️ Šiandien: <strong>{safety.messagesToday}</strong> / {safety.effectiveDailyMessageCap}
          </span>
          <span>
            ✉️ Šią savaitę: <strong>{safety.messagesThisWeek}</strong> / {safety.effectiveWeeklyMessageCap}
          </span>
          {safety.warmUpMultiplier < 1 && (
            <span className="linkedin-warmup-note">🌱 Warm-up: {Math.round(safety.warmUpMultiplier * 100)}%</span>
          )}
          {!safety.withinWorkHours && <span className="linkedin-warmup-note">Šiuo metu ne darbo valandos</span>}
        </div>
      )}

      <nav className="linkedin-subnav">
        <button type="button" className={subTab === 'campaigns' ? 'active' : ''} onClick={() => setSubTab('campaigns')}>
          Kampanijos
        </button>
        <button type="button" className={subTab === 'inbox' ? 'active' : ''} onClick={() => setSubTab('inbox')}>
          Pokalbiai
        </button>
        <button type="button" className={subTab === 'analytics' ? 'active' : ''} onClick={() => setSubTab('analytics')}>
          📊 Analitika
        </button>
        <button type="button" className={subTab === 'stale' ? 'active' : ''} onClick={() => setSubTab('stale')}>
          🕐 Užstrigę
        </button>
        <button type="button" className={subTab === 'test' ? 'active' : ''} onClick={() => setSubTab('test')}>
          Testas
        </button>
        <button type="button" className={subTab === 'settings' ? 'active' : ''} onClick={() => setSubTab('settings')}>
          ⚙️ Nustatymai
        </button>
      </nav>

      {subTab === 'campaigns' && <CampaignsPanel />}

      {subTab === 'inbox' && <InboxPanel />}

      {subTab === 'analytics' && <AnalyticsPanel />}

      {subTab === 'stale' && <StaleInvitesPanel />}

      {subTab === 'test' && (
        <>
          <div className="linkedin-test-connect">
            <h3>Siųsti testinį connection request</h3>
            <p className="linkedin-hint">
              Vienas rankinis, aiškiai patvirtintas veiksmas iš karto, be kampanijų/sekų — bet vis tiek tikrinamas per
              Safety Engine (limitai/darbo valandos/warm-up/pauzė). Kiekvienas siuntimas — realus veiksmas realiame
              LinkedIn profilyje.
            </p>
            <input
              type="url"
              placeholder="https://www.linkedin.com/in/..."
              value={profileUrl}
              onChange={(e) => setProfileUrl(e.target.value)}
            />
            <input type="text" placeholder="Žinutė (nebūtina)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button
              type="button"
              className="primary"
              disabled={sending || !profileUrl.trim() || status?.status !== 'connected' || paused}
              onClick={() => void handleSendTestConnect()}
            >
              {sending ? 'Siunčiama…' : '+ Siųsti connection request'}
            </button>
          </div>

          <div className="linkedin-actions-log">
            <h3>Paskutiniai veiksmai</h3>
            {actions.length === 0 && <p className="linkedin-hint">Kol kas nieko nesiųsta.</p>}
            {actions.map((a) => (
              <div key={a.id} className={`linkedin-action-entry linkedin-action-${a.status}`}>
                <span className="linkedin-action-type">{a.actionType}</span>
                <span className="linkedin-action-target">{a.targetUrl}</span>
                <span className="linkedin-action-time">{new Date(a.executedAt).toLocaleString('lt-LT')}</span>
                {a.detail && <span className="linkedin-action-detail">{a.detail}</span>}
              </div>
            ))}
          </div>
        </>
      )}

      {subTab === 'settings' && draft && (
        <div className="linkedin-settings-form">
          <label>
            Dienos limitas (connects)
            <input
              type="number"
              min={1}
              value={draft.dailyConnectCap}
              onChange={(e) => setDraft({ ...draft, dailyConnectCap: e.target.value })}
            />
          </label>
          <label>
            Savaitės limitas (connects)
            <input
              type="number"
              min={1}
              value={draft.weeklyConnectCap}
              onChange={(e) => setDraft({ ...draft, weeklyConnectCap: e.target.value })}
            />
          </label>
          <label>
            Dienos limitas (žinutės)
            <input
              type="number"
              min={1}
              value={draft.dailyMessageCap}
              onChange={(e) => setDraft({ ...draft, dailyMessageCap: e.target.value })}
            />
          </label>
          <label>
            Savaitės limitas (žinutės)
            <input
              type="number"
              min={1}
              value={draft.weeklyMessageCap}
              onChange={(e) => setDraft({ ...draft, weeklyMessageCap: e.target.value })}
            />
          </label>
          <label>
            Darbo valandos nuo
            <input
              type="time"
              value={draft.workHoursStart}
              onChange={(e) => setDraft({ ...draft, workHoursStart: e.target.value })}
            />
          </label>
          <label>
            Darbo valandos iki
            <input
              type="time"
              value={draft.workHoursEnd}
              onChange={(e) => setDraft({ ...draft, workHoursEnd: e.target.value })}
            />
          </label>
          <label className="linkedin-settings-checkbox">
            <input
              type="checkbox"
              checked={draft.warmUpEnabled}
              onChange={(e) => setDraft({ ...draft, warmUpEnabled: e.target.checked })}
            />
            Warm-up režimas (naujam/ilgai neaktyviam accountui)
          </label>
          <label>
            Warm-up trukmė (dienomis)
            <input
              type="number"
              min={1}
              value={draft.warmUpDurationDays}
              onChange={(e) => setDraft({ ...draft, warmUpDurationDays: e.target.value })}
            />
          </label>
          <label>
            Warm-up pradžia (% nuo limito)
            <input
              type="number"
              min={1}
              max={100}
              value={draft.warmUpStartPct}
              onChange={(e) => setDraft({ ...draft, warmUpStartPct: e.target.value })}
            />
          </label>
          <label className="linkedin-settings-checkbox">
            <input
              type="checkbox"
              checked={draft.manualReviewEnabled}
              onChange={(e) => setDraft({ ...draft, manualReviewEnabled: e.target.checked })}
            />
            Rankinis kiekvieno veiksmo patvirtinimas (rekomenduojama pirmomis savaitėmis)
          </label>
          <button type="button" className="primary" disabled={savingSettings} onClick={() => void handleSaveSettings()}>
            {savingSettings ? 'Saugoma…' : '💾 Išsaugoti nustatymus'}
          </button>
        </div>
      )}
    </div>
  );
}
