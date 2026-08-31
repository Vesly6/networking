import { useEffect, useState } from 'react';
import { useLinkedInStore } from '../../store/useLinkedInStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { useToastStore } from '../../store/useToastStore';
import {
  fetchTodaysLinkedInPlan,
  parseConnectTiming,
  type LinkedInSafetySettings,
  type LinkedInTodaysPlan,
  type LinkedInActionLogEntry,
} from '../../utils/linkedinApi';
import { CampaignsPanel } from './CampaignsPanel';
import { InboxPanel } from './InboxPanel';
import { AnalyticsPanel } from './AnalyticsPanel';
import { StaleInvitesPanel } from './StaleInvitesPanel';
import {
  Circle,
  RefreshCw,
  Play,
  Pause,
  Handshake,
  Eye,
  Mail,
  Sprout,
  Hourglass,
  BarChart3,
  Clock,
  Settings,
  Save,
  LayoutDashboard,
  Megaphone,
  MessageSquare,
  ScrollText,
  ChevronDown,
  ChevronRight,
  Calendar,
} from 'lucide-react';

type SubTab = 'overview' | 'campaigns' | 'inbox' | 'analytics' | 'stale' | 'log' | 'settings';

const SIDEBAR_ITEMS: Array<{ tab: SubTab; label: string; icon: typeof LayoutDashboard }> = [
  { tab: 'overview', label: 'Apžvalga', icon: LayoutDashboard },
  { tab: 'campaigns', label: 'Kampanijos', icon: Megaphone },
  { tab: 'inbox', label: 'Pokalbiai', icon: MessageSquare },
  { tab: 'analytics', label: 'Analitika', icon: BarChart3 },
  { tab: 'stale', label: 'Užstrigę', icon: Clock },
  { tab: 'log', label: 'Žurnalas', icon: ScrollText },
  { tab: 'settings', label: 'Nustatymai', icon: Settings },
];

/** Renders one 'connect' action-log entry's per-phase timing breakdown —
 * answers exactly what was asked for: how long spent on the profile, how
 * long dwelling on a recent-activity page, what minute Connect fired and
 * what minute it actually sent. All deltas are computed from `startedAt`
 * (when this specific send began) rather than from the previous phase, so
 * each line reads as "N seconds into this attempt" — easier to scan than
 * a chain of relative deltas. */
function ConnectTimingBreakdown({ entry }: { entry: LinkedInActionLogEntry }) {
  const timing = parseConnectTiming(entry.timingJson);
  if (!timing) return <p className="linkedin-hint">Detalaus laiko įrašo nėra šiam veiksmui.</p>;
  const since = (ms: number) => `+${((ms - timing.startedAt) / 1000).toFixed(1)}s`;
  return (
    <dl className="linkedin-timing-breakdown">
      <dt>Pradėta</dt>
      <dd>{new Date(timing.startedAt).toLocaleTimeString('lt-LT')}</dd>
      <dt>Navigacija</dt>
      <dd>
        {since(timing.navigatedAt)} {timing.navigatedViaSearch ? '(per LinkedIn paiešką)' : '(tiesiogine nuoroda)'}
      </dd>
      <dt>Prisijungimas patvirtintas</dt>
      <dd>{since(timing.loginConfirmedAt)}</dd>
      <dt>Profilio įrašas peržiūrėtas</dt>
      <dd>
        {timing.visitedRecentActivity
          ? `Taip${timing.recentActivityDwellMs !== null ? ` — užtruko ${(timing.recentActivityDwellMs / 1000).toFixed(0)}s` : ''}`
          : 'Ne'}
      </dd>
      <dt>Connect paspaustas</dt>
      <dd>{since(timing.connectClickedAt)}</dd>
      <dt>Pastaba pridėta</dt>
      <dd>{timing.noteAdded ? 'Taip' : 'Ne'}</dd>
      <dt>Išsiųsta</dt>
      <dd>{since(timing.sentAt)}</dd>
      <dt>Iš viso truko</dt>
      <dd>{(timing.totalMs / 1000).toFixed(1)}s</dd>
    </dl>
  );
}

// Colored-dot connection-status indicator — a single Circle icon (filled
// via currentColor) instead of 4 separate colored emoji, colored per
// status by CSS class rather than a hardcoded hex, so it (like every
// other icon in this migration) automatically tracks the light/dark theme.
const STATUS_META: Record<string, { label: string; dotClass: string }> = {
  connected: { label: 'Prijungta', dotClass: 'linkedin-status-dot-connected' },
  not_connected: { label: 'Neprijungta', dotClass: 'linkedin-status-dot-muted' },
  logged_out: { label: 'Neprisijungta prie LinkedIn', dotClass: 'linkedin-status-dot-warning' },
  checkpoint: { label: 'LinkedIn reikalauja patvirtinimo', dotClass: 'linkedin-status-dot-danger' },
};

interface SettingsDraft {
  dailyConnectCap: string;
  weeklyConnectCap: string;
  dailyMessageCap: string;
  weeklyMessageCap: string;
  workHoursStart: string;
  workHoursEnd: string;
  workHoursTimezone: string;
  warmUpEnabled: boolean;
  warmUpDurationDays: string;
  warmUpStartPct: string;
  dailyTargetJitterPct: string;
  browseActivityProbability: string;
  searchNavigationProbability: string;
  dailySearchCap: string;
  searchLockoutDays: string;
  likesProbability: string;
  likesMinGapMinutes: string;
  aiScheduleEnabled: boolean;
  autoPersonalizeEnabled: boolean;
}

function toDraft(s: LinkedInSafetySettings): SettingsDraft {
  return {
    dailyConnectCap: String(s.dailyConnectCap),
    weeklyConnectCap: String(s.weeklyConnectCap),
    dailyMessageCap: String(s.dailyMessageCap),
    weeklyMessageCap: String(s.weeklyMessageCap),
    workHoursStart: s.workHoursStart,
    workHoursEnd: s.workHoursEnd,
    workHoursTimezone: s.workHoursTimezone,
    warmUpEnabled: s.warmUpEnabled,
    warmUpDurationDays: String(s.warmUpDurationDays),
    warmUpStartPct: String(s.warmUpStartPct),
    dailyTargetJitterPct: String(s.dailyTargetJitterPct),
    browseActivityProbability: String(s.browseActivityProbability),
    searchNavigationProbability: String(s.searchNavigationProbability),
    dailySearchCap: String(s.dailySearchCap),
    searchLockoutDays: String(s.searchLockoutDays),
    likesProbability: String(s.likesProbability),
    likesMinGapMinutes: String(s.likesMinGapMinutes),
    aiScheduleEnabled: s.aiScheduleEnabled,
    autoPersonalizeEnabled: s.autoPersonalizeEnabled,
  };
}

// IANA timezone list for the work-hours picker (§2) — native
// Intl.supportedValuesOf, zero new dependency, full list. Grouped by
// continent prefix via <optgroup> so a several-hundred-entry list stays
// navigable rather than one giant flat dropdown.
function groupedTimezones(): Array<[string, string[]]> {
  let zones: string[];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    // Older engines without supportedValuesOf — fall back to just always
    // including the two zones this feature has actually been used from
    // (Vilnius default, Da Nang for the account owner's current trip) so
    // the picker still shows something sane rather than an empty list.
    zones = ['Europe/Vilnius', 'Asia/Ho_Chi_Minh', 'UTC'];
  }
  const groups = new Map<string, string[]>();
  for (const zone of zones) {
    const continent = zone.split('/')[0] ?? 'Other';
    if (!groups.has(continent)) groups.set(continent, []);
    groups.get(continent)!.push(zone);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
}

const TIMEZONE_GROUPS = groupedTimezones();

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
  const [subTab, setSubTab] = useState<SubTab>('overview');
  const [todaysPlan, setTodaysPlan] = useState<LinkedInTodaysPlan | null>(null);
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set());

  // refreshStatus() deliberately does NOT run here — a real, reported
  // problem: this component is mounted unconditionally the moment any
  // table is open (App.tsx's own tab-panel comment explains why — it's
  // account-level, not scoped to a specific table, same as Search), so
  // auto-firing a status check on every mount meant checking LinkedIn
  // connectivity — which calls getLinkedInPage() (browser.ts), opening a
  // new Chrome tab/navigating to linkedin.com when none is already open —
  // fired every single time the user opened or switched tables, making
  // the automation Chrome window visibly pop up/activate with no action
  // on the user's part. refreshActions/refreshSafety are plain DB-backed
  // reads (no Chrome involved) and stay automatic; status is now only
  // ever checked by the existing "↻ Atnaujinti" button below, which was
  // already there but redundant while this ran on every mount anyway.
  useEffect(() => {
    void refreshActions();
    void refreshSafety();
    // Read-only, cheap DB-backed read (same class as refreshActions/
    // refreshSafety above) — no Chrome/CDP involved, so it's safe to fire
    // unconditionally on mount. Not routed through a dedicated store since
    // it's a single small glance widget for the Apžvalga tab, not state
    // any other component needs to react to.
    fetchTodaysLinkedInPlan()
      .then(setTodaysPlan)
      .catch(() => {});
  }, [refreshActions, refreshSafety]);

  const toggleLogExpanded = (id: string) => {
    setExpandedLogIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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

  // The background 5-minute automatic tick (server/src/index.ts) is what
  // actually runs this feature "on its own, without stopping" — this
  // button is a manual "run right now" shortcut for a human-supervised
  // burst (up to MAX_ATTEMPTS_PER_TICK), same Safety Engine gate either
  // way. There is no approval queue anymore — a due action always
  // executes, so the toast reports what actually happened, not what's
  // waiting.
  const handleRunScheduler = async () => {
    const result = await runScheduler();
    if (!result) return;
    if (result.skippedConcurrent) {
      showToast('Kita vykdymo eiga jau vyksta — bandykite dar kartą po akimirkos');
      return;
    }
    const parts = [`Rasta veiksmų: ${result.due}`];
    if (result.autoExecuted > 0) parts.push(`įvykdyta: ${result.autoExecuted}`);
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
      work_hours_timezone: draft.workHoursTimezone,
      warm_up_enabled: draft.warmUpEnabled,
      warm_up_duration_days: Number(draft.warmUpDurationDays) || 1,
      warm_up_start_pct: Number(draft.warmUpStartPct) || 0,
      daily_target_jitter_pct: Number(draft.dailyTargetJitterPct) || 0,
      browse_activity_probability: Number(draft.browseActivityProbability) || 0,
      search_navigation_probability: Number(draft.searchNavigationProbability) || 0,
      daily_search_cap: Number(draft.dailySearchCap) || 0,
      search_lockout_days: Number(draft.searchLockoutDays) || 1,
      likes_probability: Number(draft.likesProbability) || 0,
      likes_min_gap_minutes: Number(draft.likesMinGapMinutes) || 0,
      ai_schedule_enabled: draft.aiScheduleEnabled,
      auto_personalize_enabled: draft.autoPersonalizeEnabled,
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
            {statusLoading ? (
              <>
                <Hourglass className="icon" size={14} /> Tikrinama…
              </>
            ) : // `status === null` means "never checked this session" (see
            // this file's own mount-effect comment for why that check
            // is no longer automatic) — worth its own honest label
            // rather than reusing not_connected's wording, which would
            // otherwise read as "the connection is broken" when really
            // nothing has looked yet.
            status ? (
              <>
                <Circle className={`icon linkedin-status-dot ${STATUS_META[status.status].dotClass}`} size={10} fill="currentColor" />{' '}
                {STATUS_META[status.status].label}
              </>
            ) : (
              '— Nepatikrinta'
            )}
          </span>
          <button type="button" onClick={() => void refreshStatus()} disabled={statusLoading}>
            <RefreshCw className="icon" size={16} /> Atnaujinti
          </button>
          <button
            type="button"
            onClick={() => void handleRunScheduler()}
            disabled={runningScheduler || paused}
            title="Automatika jau veikia fone kas 5 min. — šis mygtukas paleidžia rankinį, prižiūrimą vykdymą iš karto, ta pačia Safety Engine riba"
          >
            {runningScheduler ? 'Vykdoma…' : <><Play className="icon" size={16} /> Vykdyti dabar</>}
          </button>
          {/* Always visible regardless of which section is open below —
              the whole premise of a kill switch is not having to go dig
              for it once something looks off. */}
          <button
            type="button"
            className={paused ? 'primary' : 'linkedin-pause-btn'}
            onClick={() => void handleTogglePause()}
          >
            {paused ? <><Play className="icon" size={16} /> Tęsti</> : <><Pause className="icon" size={16} /> Sustabdyti viską</>}
          </button>
        </div>
      </div>

      {status && status.status !== 'connected' && <p className="linkedin-status-message">{status.message}</p>}
      {paused && (
        <p className="linkedin-paused-banner">
          <Pause className="icon" size={14} /> Automatizacija šiuo metu sustabdyta.
        </p>
      )}
      {safety && safety.settings.searchBlockedUntil !== null && safety.settings.searchBlockedUntil > Date.now() && (
        <p className="linkedin-paused-banner" title="LinkedIn parodė, kad pasiektas mėnesio paieškos limitas (arba paieška du kartus iš eilės negrąžino rezultatų) — paieška pagal vardą laikinai išjungta, siuntimai naudoja tiesioginę nuorodą.">
          <Clock className="icon" size={14} /> Paieška pagal vardą užblokuota iki{' '}
          {new Date(safety.settings.searchBlockedUntil).toLocaleString('lt-LT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
        </p>
      )}

      {safety && (
        <div className="linkedin-safety-summary">
          <span>
            <Handshake className="icon" size={14} /> Šiandien: <strong>{safety.connectsToday}</strong> / {safety.effectiveDailyCap}
          </span>
          <span>
            <Handshake className="icon" size={14} /> Šią savaitę: <strong>{safety.connectsThisWeek}</strong> / {safety.effectiveWeeklyCap}
          </span>
          <span
            title="Kiek profilių iš viso patikrinta šiandien (nesvarbu, sėkmingai ar ne) — atskira riba, apsauganti nuo per didelio aktyvumo, kai dauguma laidų pasirodo jau esami kontaktai"
          >
            <Eye className="icon" size={14} /> Patikrinta šiandien: <strong>{safety.attemptsToday}</strong> / {safety.dailyAttemptCap}
          </span>
          <span>
            <Mail className="icon" size={14} /> Šiandien: <strong>{safety.messagesToday}</strong> / {safety.effectiveDailyMessageCap}
          </span>
          <span>
            <Mail className="icon" size={14} /> Šią savaitę: <strong>{safety.messagesThisWeek}</strong> / {safety.effectiveWeeklyMessageCap}
          </span>
          {safety.warmUpMultiplier < 1 && (
            <span className="linkedin-warmup-note">
              <Sprout className="icon" size={14} /> Warm-up: {Math.round(safety.warmUpMultiplier * 100)}%
            </span>
          )}
          {!safety.withinWorkHours && <span className="linkedin-warmup-note">Šiuo metu ne darbo valandos</span>}
        </div>
      )}

      <div className="linkedin-body">
        <nav className="linkedin-sidebar">
          {SIDEBAR_ITEMS.map(({ tab, label, icon: Icon }) => (
            <button key={tab} type="button" className={subTab === tab ? 'active' : ''} onClick={() => setSubTab(tab)}>
              <Icon className="icon" size={16} /> {label}
            </button>
          ))}
        </nav>

        <div className="linkedin-main">
          {subTab === 'overview' && (
            <div className="linkedin-overview">
              <div className="linkedin-overview-card">
                <h3>
                  <Calendar className="icon" size={16} /> Šiandienos planas
                </h3>
                {todaysPlan ? (
                  <>
                    <p className="linkedin-plan-progress-line">
                      <strong>
                        {todaysPlan.firedCount} / {todaysPlan.targetCount}
                      </strong>{' '}
                      suplanuotų veiksmų atlikta šiandien
                    </p>
                    <div className="linkedin-plan-progress-bar">
                      <div
                        className="linkedin-plan-progress-fill"
                        style={{ width: `${todaysPlan.targetCount > 0 ? Math.min(100, (todaysPlan.firedCount / todaysPlan.targetCount) * 100) : 0}%` }}
                      />
                    </div>
                    {todaysPlan.nextSlotDueNowAt !== null ? (
                      <p className="linkedin-hint">Kitas veiksmas jau turėtų būti vykdomas dabar (laukia fono ciklo).</p>
                    ) : todaysPlan.firedCount < todaysPlan.targetCount ? (
                      <p className="linkedin-hint">Kitas suplanuotas veiksmas dar ne dabar — automatika pati paims jį, kai ateis laikas.</p>
                    ) : (
                      <p className="linkedin-hint">Šiandienos planas jau įvykdytas.</p>
                    )}
                  </>
                ) : (
                  <p className="linkedin-hint">Kraunama…</p>
                )}
              </div>

              {safety && (
                <div className="linkedin-overview-card">
                  <h3>Saugumo būsena</h3>
                  <ul className="linkedin-overview-list">
                    <li>
                      Connect šiandien: <strong>{safety.connectsToday}</strong> / {safety.effectiveDailyCap}
                    </li>
                    <li>
                      Connect šią savaitę: <strong>{safety.connectsThisWeek}</strong> / {safety.effectiveWeeklyCap}
                    </li>
                    <li>
                      Žinutės šiandien: <strong>{safety.messagesToday}</strong> / {safety.effectiveDailyMessageCap}
                    </li>
                    <li>
                      Patikrinta profilių šiandien: <strong>{safety.attemptsToday}</strong> / {safety.dailyAttemptCap}
                    </li>
                    {safety.warmUpMultiplier < 1 && (
                      <li className="linkedin-warmup-note">Warm-up: {Math.round(safety.warmUpMultiplier * 100)}% nuo pilno limito</li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}

          {subTab === 'campaigns' && <CampaignsPanel />}

          {subTab === 'inbox' && <InboxPanel />}

          {subTab === 'analytics' && <AnalyticsPanel />}

          {subTab === 'stale' && <StaleInvitesPanel />}

          {subTab === 'log' && (
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
                {actions.map((a) => {
                  const hasTiming = a.actionType === 'connect' && a.timingJson !== null;
                  const isExpanded = expandedLogIds.has(a.id);
                  return (
                    <div key={a.id} className={`linkedin-action-entry linkedin-action-${a.status}`}>
                      <div className="linkedin-action-entry-row">
                        {hasTiming ? (
                          <button type="button" className="linkedin-action-expand-toggle" onClick={() => toggleLogExpanded(a.id)}>
                            {isExpanded ? <ChevronDown className="icon" size={14} /> : <ChevronRight className="icon" size={14} />}
                          </button>
                        ) : (
                          <span className="linkedin-action-expand-spacer" />
                        )}
                        <span className="linkedin-action-type">{a.actionType}</span>
                        <span className="linkedin-action-target">{a.targetUrl}</span>
                        <span className="linkedin-action-time">{new Date(a.executedAt).toLocaleString('lt-LT')}</span>
                        {a.detail && <span className="linkedin-action-detail">{a.detail}</span>}
                      </div>
                      {hasTiming && isExpanded && <ConnectTimingBreakdown entry={a} />}
                    </div>
                  );
                })}
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
          <label>
            Laiko juosta
            <select
              value={draft.workHoursTimezone}
              onChange={(e) => setDraft({ ...draft, workHoursTimezone: e.target.value })}
              title="Darbo valandos (žemiau) tikrinamos šioje laiko juostoje — kiekvienas naudotojas gali pasirinkti savo, nebūtina Vilniaus."
            >
              {!TIMEZONE_GROUPS.some(([, zones]) => zones.includes(draft.workHoursTimezone)) && (
                <option value={draft.workHoursTimezone}>{draft.workHoursTimezone}</option>
              )}
              {TIMEZONE_GROUPS.map(([continent, zones]) => (
                <optgroup key={continent} label={continent}>
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <label>
            Dienos tikslo svyravimas (± % nuo limito)
            <input
              type="number"
              min={0}
              max={100}
              value={draft.dailyTargetJitterPct}
              onChange={(e) => setDraft({ ...draft, dailyTargetJitterPct: e.target.value })}
              title="Kiek žemiau dienos limito realus tikslas gali atsitiktinai nukristi, procentais nuo TOS DIENOS limito (ne fiksuotu skaičiumi) — taip svyravimas išlieka prasmingas ir warm-up laikotarpiu, kai limitas mažas."
            />
          </label>
          <label>
            Tikimybė peržiūrėti profilio įrašus (%)
            <input
              type="number"
              min={0}
              max={100}
              value={draft.browseActivityProbability}
              onChange={(e) => setDraft({ ...draft, browseActivityProbability: e.target.value })}
              title="Kaip dažnai prieš siunčiant Connect užklausą atsitiktinai peržiūrimas vienas profilio įrašas."
            />
          </label>
          <label>
            Tikimybė ieškoti pagal vardą (%)
            <input
              type="number"
              min={0}
              max={100}
              value={draft.searchNavigationProbability}
              onChange={(e) => setDraft({ ...draft, searchNavigationProbability: e.target.value })}
              title="Kaip dažnai vietoj tiesioginės nuorodos einama per LinkedIn paiešką pagal vardą — palaikoma žemai, nes LinkedIn paieška ribojama ne-premium paskyrose."
            />
          </label>
          <label>
            Dienos limitas (paieškos)
            <input
              type="number"
              min={0}
              value={draft.dailySearchCap}
              onChange={(e) => setDraft({ ...draft, dailySearchCap: e.target.value })}
              title="Kietas dienos apribojimas LinkedIn paieškos naudojimui — pasiekus, likusios dienos siuntimai naudoja tiesioginę nuorodą."
            />
          </label>
          <label>
            Paieškos blokavimo trukmė (dienomis)
            <input
              type="number"
              min={1}
              value={draft.searchLockoutDays}
              onChange={(e) => setDraft({ ...draft, searchLockoutDays: e.target.value })}
              title="Jei LinkedIn parodo, kad pasiektas mėnesio paieškos limitas (arba du kartus iš eilės paieška negrąžina rezultatų), paieška pagal vardą laikinai išjungiama šiam dienų skaičiui, kad nebūtų be reikalo kartojama."
            />
          </label>
          <label>
            Tikimybė paspausti "Patinka" naujienose (%)
            <input
              type="number"
              min={0}
              max={100}
              value={draft.likesProbability}
              onChange={(e) => setDraft({ ...draft, likesProbability: e.target.value })}
              title="Kai ateina eilė patikrinti naujienas (žr. žemiau), kokia tikimybė, kad bus paspaustas 'Patinka' po 1-2 įrašus. Tik 'Patinka' — jokių komentarų."
            />
          </label>
          <label>
            Min. tarpas tarp naujienų patikrinimų (min.)
            <input
              type="number"
              min={0}
              value={draft.likesMinGapMinutes}
              onChange={(e) => setDraft({ ...draft, likesMinGapMinutes: e.target.value })}
              title="Kiek laiko bent turi praeiti tarp dviejų naujienų peržiūrų — apsaugo nuo per dažno patikrinimo kas kelias minutes."
            />
          </label>
          <label className="linkedin-settings-checkbox">
            <input
              type="checkbox"
              checked={draft.aiScheduleEnabled}
              onChange={(e) => setDraft({ ...draft, aiScheduleEnabled: e.target.checked })}
            />
            Eksperimentinis: leisti DI siūlyti dienos grafiką (vietoj įprasto algoritmo)
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
              checked={draft.autoPersonalizeEnabled}
              onChange={(e) => setDraft({ ...draft, autoPersonalizeEnabled: e.target.checked })}
            />
            Automatiškai DI-personalizuoti kiekvieną žinutę prieš siunčiant (be to — tik {'{{firstName}}'} ir pan. pakeitimas)
          </label>
          <button type="button" className="primary" disabled={savingSettings} onClick={() => void handleSaveSettings()}>
            {savingSettings ? 'Saugoma…' : <><Save className="icon" size={16} /> Išsaugoti nustatymus</>}
          </button>
        </div>
          )}
        </div>
      </div>
    </div>
  );
}
