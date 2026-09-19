import { useEffect, useState } from 'react';
import {
  FileText,
  Users,
  Phone,
  Send,
  Mail,
  MailCheck,
  Percent,
  RefreshCw,
  ArrowUp,
  ArrowDown,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Sparkles,
} from 'lucide-react';
import { useDashboardStore } from '../../store/useDashboardStore';
import { useEmployeeTasksPanelStore } from '../../store/useEmployeeTasksPanelStore';
import { useAuthStore } from '../../store/useAuthStore';
import { can } from '../../utils/permissions';
import {
  DASHBOARD_METRICS,
  fetchDashboardSyncLog,
  type DashboardMetric,
  type DashboardPeriod,
  type DashboardSyncLogEntry,
} from '../../utils/dashboardApi';

// 'Komentarai', not 'Pastabos' — matches this app's own already-established
// term for the note-type column everywhere else (permissions.ts's
// notes.delete_edit label is literally "Trinti/redaguoti komentarus", the
// "Kontaktai ir komentarai" permission group), so the dashboard doesn't
// introduce a second, inconsistent name for the same thing. 'contacts' is
// labeled "Pridėta kontaktų" (not bare "Kontaktai") on explicit request —
// there is deliberately no "companies added" metric at all (see
// aggregate.ts's own doc comment: a table's rows are an exact, pre-built
// list this CRM works from the start, not something that grows the way
// contacts genuinely do), so "Pridėta X" now applies to the one thing
// that's actually true of.
const METRIC_LABELS: Record<DashboardMetric, string> = {
  notes: 'Komentarai',
  contacts: 'Pridėta kontaktų',
  calls: 'Skambučiai',
  linkedin_sent: 'LinkedIn užklausos',
};

const METRIC_ICONS: Record<DashboardMetric, typeof FileText> = {
  notes: FileText,
  contacts: Users,
  calls: Phone,
  linkedin_sent: Send,
};

// A distinct accent per card — on explicit request ("иконки... пометить с
// каким-то цветом, думаю было бы более интерактивно"). Fixed hex values,
// not theme tokens — same reasoning as the LinkedIn badge colors and the
// "hot lead" flag elsewhere in this app's CSS: these are meant to read as
// the same distinct color in both light and dark mode, not shift with the
// theme. linkedin_sent reuses this session's own established LinkedIn
// brand blue (#0a66c2) for consistency with the LinkedIn Planner's own
// badges rather than inventing a second "LinkedIn color."
const METRIC_COLORS: Record<DashboardMetric, string> = {
  notes: '#2f6fed',
  contacts: '#1a9e6b',
  calls: '#e08a2c',
  linkedin_sent: '#0a66c2',
};

const EMAIL_CARD_COLOR = '#8b5cf6';

const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  today: 'Šiandien',
  yesterday: 'Vakar',
  '7d': '7 dienos',
  '30d': '30 dienų',
  month: 'Šis mėnuo',
  custom: 'Pasirinktas laikotarpis',
};

const PERIOD_OPTIONS: DashboardPeriod[] = ['today', 'yesterday', '7d', '30d', 'month', 'custom'];

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoStr(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** "Обновлено N minučių atgal" — deliberately not a generic date-fns-style
 * library dependency for one label; this app already avoids heavy date
 * libraries everywhere (see CLAUDE.md's callStats.ts/BarChart.tsx notes on
 * the same "keep the bundle light" preference). */
function timeAgoLabel(updatedAt: number | null): string {
  if (updatedAt === null) return 'Dar nesinchronizuota';
  const minutes = Math.max(0, Math.round((Date.now() - updatedAt) / 60_000));
  if (minutes < 1) return 'Atnaujinta ką tik';
  if (minutes < 60) return `Atnaujinta prieš ${minutes} min.`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Atnaujinta prieš ${hours} val.`;
  const days = Math.round(hours / 24);
  return `Atnaujinta prieš ${days} d.`;
}

function ChangeIndicator({ current, previous }: { current: number; previous: number }) {
  // No comparison rendered when the previous period was zero — a "+∞%"
  // or fabricated percentage would be more misleading than showing
  // nothing at all for a metric that simply didn't exist before.
  if (previous === 0) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return <span className="activity-dashboard-change activity-dashboard-change-flat">0%</span>;
  const Icon = pct > 0 ? ArrowUp : ArrowDown;
  return (
    <span className={`activity-dashboard-change ${pct > 0 ? 'activity-dashboard-change-up' : 'activity-dashboard-change-down'}`}>
      <Icon className="icon" size={12} />
      {Math.abs(pct)}%
    </span>
  );
}

/** A colored, tinted icon chip — the "more interactive"-looking card
 * accent requested. `color-mix()` derives the tinted background from the
 * same solid color as the icon itself, so light/dark theme (whatever
 * `--bg`/`--border` currently are) is blended in automatically instead of
 * needing separate light/dark hex pairs per metric. */
function MetricIcon({ Icon, color }: { Icon: typeof FileText; color: string }) {
  return (
    <span className="activity-dashboard-icon" style={{ color, backgroundColor: `color-mix(in srgb, ${color} 16%, var(--bg))` }}>
      <Icon className="icon" size={15} />
    </span>
  );
}

interface MetricCardProps {
  icon: typeof FileText;
  color: string;
  label: string;
  value: number | string;
  change?: { current: number; previous: number };
}

function MetricCard({ icon, color, label, value, change }: MetricCardProps) {
  return (
    <div className="activity-dashboard-card" data-tutorial-id="dashboard-metric-card">
      <MetricIcon Icon={icon} color={color} />
      <div className="activity-dashboard-card-body">
        <div className="activity-dashboard-card-label">{label}</div>
        <div className="activity-dashboard-card-value">{value}</div>
        {change && <ChangeIndicator current={change.current} previous={change.previous} />}
      </div>
    </div>
  );
}

/** "Rodyti šaltinio duomenis" — the account owner's own explicit "let me
 * see how this looks from the real side" request: expands to the exact
 * request params + raw response body the last background sync got back,
 * so a computed number here can be cross-checked against the provider's
 * own dashboard for the identical range. Deliberately generic wording
 * ("šaltinis"/source), not the provider's own name — matches this
 * dashboard's existing convention of functional, not brand, labels.
 * Follows WebhookLogPanel.tsx's existing expand-to-see-raw-JSON pattern
 * rather than inventing a new one. */
function SourceLogToggle({ source }: { source: 'instantly' | 'zadarma' }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [entry, setEntry] = useState<DashboardSyncLogEntry | null | undefined>(undefined);
  const [lastError, setLastError] = useState<string | null>(null);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (entry !== undefined) return;
    setLoading(true);
    try {
      const res = await fetchDashboardSyncLog(source);
      setEntry(res.entry);
      setLastError(res.lastError);
    } catch {
      setEntry(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="activity-dashboard-sync-log">
      <button type="button" className="activity-dashboard-sync-log-toggle" onClick={() => void toggle()}>
        {open ? <ChevronUp className="icon" size={13} /> : <ChevronDown className="icon" size={13} />}
        Rodyti šaltinio duomenis
      </button>
      {open && (
        <div className="activity-dashboard-sync-log-body">
          {loading && <div className="activity-dashboard-loading">Kraunama…</div>}
          {!loading && lastError && <div className="activity-dashboard-error">Paskutinė sinchronizacija nepavyko: {lastError}</div>}
          {!loading && entry === null && !lastError && <div className="activity-dashboard-empty">Dar nesinchronizuota — nėra ką rodyti.</div>}
          {!loading && entry && (
            <>
              <div className="activity-dashboard-sync-log-meta">Užklausta: {new Date(entry.requestedAt).toLocaleString('lt-LT')}</div>
              <div className="activity-dashboard-sync-log-meta">Parametrai:</div>
              <pre className="activity-dashboard-sync-log-json">{JSON.stringify(entry.requestParams, null, 2)}</pre>
              <div className="activity-dashboard-sync-log-meta">Gautas atsakymas (be pakeitimų):</div>
              <pre className="activity-dashboard-sync-log-json">{JSON.stringify(entry.rawResponse, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The home-screen Team Activity Dashboard — see server/src/dashboard/
 * aggregate.ts's own doc comments for where every number actually comes
 * from. Rendered inline on WorkspaceView.tsx (not a separate nav tab),
 * gated by dashboard.view_own — WorkspaceView itself decides whether to
 * mount this at all; once mounted, the per-worker table section is
 * further gated by summary.canViewTeam (server-enforced, not just hidden
 * here — see index.ts's GET /api/dashboard/workers). */
export function ActivityDashboard() {
  const period = useDashboardStore((s) => s.period);
  const summary = useDashboardStore((s) => s.summary);
  const workers = useDashboardStore((s) => s.workers);
  const ready = useDashboardStore((s) => s.ready);
  const error = useDashboardStore((s) => s.error);
  const refreshing = useDashboardStore((s) => s.refreshing);
  const setPeriod = useDashboardStore((s) => s.setPeriod);
  const load = useDashboardStore((s) => s.load);
  const forceRefresh = useDashboardStore((s) => s.forceRefresh);
  const canDiagnose = useAuthStore((s) => can(s.user?.permissionKeys, 'dashboard.integrations.diagnose'));

  // A specific-date-to-specific-date (or specific-year-to-specific-year,
  // since a plain <input type="date"> already lets you pick any year, not
  // just navigate day-by-day) range — on explicit request, alongside the
  // existing preset buttons. Local draft state so partially-typed dates
  // (only "from" picked yet) don't fire a request with a missing "to."
  const [customFrom, setCustomFrom] = useState(daysAgoStr(30));
  const [customTo, setCustomTo] = useState(todayStr());

  // Collapse/expand the whole block — on explicit request ("чтобы можно
  // было бы сворачивать... когда мне это захочется увидеть"). Persisted
  // per-browser (localStorage) — a per-viewer convenience, not real state
  // (see CLAUDE.md's own established "localStorage is fine for a
  // remembered collapsed section" convention), so it survives a reload
  // but never needs a server round trip. Still loads its own data in the
  // background even while collapsed (below), so expanding it later shows
  // fresh numbers immediately instead of a loading flash.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('activity-dashboard-collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('activity-dashboard-collapsed', String(next));
      } catch {
        // Private window / blocked storage — collapsing still works for
        // this session, it just won't be remembered next visit.
      }
      return next;
    });
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePeriodChange = (next: DashboardPeriod) => {
    if (next === 'custom') {
      setPeriod('custom', { from: customFrom, to: customTo });
    } else {
      setPeriod(next);
    }
  };

  const applyCustomRange = (from: string, to: string) => {
    setCustomFrom(from);
    setCustomTo(to);
    if (from && to) setPeriod('custom', { from, to });
  };

  // "Atverti" opens the pinned EmployeeTasksPanel (mounted once at
  // App.tsx's root — see its own doc comment) instead of a per-click
  // modal, so checking a worker's 30 comments one at a time no longer
  // means 30 separate open/close cycles.
  const openTasksPanel = useEmployeeTasksPanelStore((s) => s.open);

// Reused by every branch below (loading/error/loaded) so the collapse
  // toggle is always there regardless of load state — collapsing shouldn't
  // require the data to have finished loading first.
  const collapseHeader = (
    <div className="activity-dashboard-header">
      <button type="button" className="activity-dashboard-collapse-toggle" onClick={toggleCollapsed}>
        {collapsed ? <ChevronRight className="icon" size={16} /> : <ChevronDown className="icon" size={16} />}
        <h3>Komandos aktyvumas</h3>
      </button>
    </div>
  );

  if (!ready) {
    return (
      <div className="activity-dashboard" data-tutorial-id="activity-dashboard">
        {collapseHeader}
        {!collapsed && <div className="activity-dashboard-loading">Kraunama aktyvumo statistika…</div>}
      </div>
    );
  }

  if (error && !summary) {
    return (
      <div className="activity-dashboard" data-tutorial-id="activity-dashboard">
        {collapseHeader}
        {!collapsed && <div className="activity-dashboard-error">{error}</div>}
      </div>
    );
  }

  if (!summary) return null;

  const showTeam = summary.canViewTeam;
  const totals = showTeam ? summary.team! : summary.own;
  const previousTotals = showTeam ? summary.teamPrevious! : summary.ownPrevious;
  const hasAnyActivity = DASHBOARD_METRICS.some((m) => totals[m] > 0);
  const hasEmail = showTeam && summary.email && summary.emailPrevious;

  return (
    <div className="activity-dashboard" data-tutorial-id="activity-dashboard">
      <div className="activity-dashboard-header">
        <button type="button" className="activity-dashboard-collapse-toggle" onClick={toggleCollapsed}>
          {collapsed ? <ChevronRight className="icon" size={16} /> : <ChevronDown className="icon" size={16} />}
          <h3>Komandos aktyvumas</h3>
        </button>
        {!collapsed && (
          <div className="activity-dashboard-controls" data-tutorial-id="dashboard-period-selector">
            <select value={period} onChange={(e) => handlePeriodChange(e.target.value as DashboardPeriod)}>
              {PERIOD_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {PERIOD_LABELS[p]}
                </option>
              ))}
            </select>
            {period === 'custom' && (
              <span className="activity-dashboard-custom-range">
                <input type="date" value={customFrom} max={customTo} onChange={(e) => applyCustomRange(e.target.value, customTo)} />
                <span>—</span>
                <input type="date" value={customTo} min={customFrom} max={todayStr()} onChange={(e) => applyCustomRange(customFrom, e.target.value)} />
              </span>
            )}
            <span className="activity-dashboard-updated">{timeAgoLabel(summary.updatedAt)}</span>
            <button type="button" onClick={() => void forceRefresh()} disabled={refreshing} title="Priverstinai atnaujinti">
              <RefreshCw className={`icon${refreshing ? ' activity-dashboard-spinning' : ''}`} size={14} />
              Atnaujinti
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        <>
          {error && <div className="activity-dashboard-error activity-dashboard-error-inline">{error}</div>}

          {!hasAnyActivity && !hasEmail ? (
            <div className="activity-dashboard-empty">Šiuo laikotarpiu veiklos dar nėra.</div>
          ) : (
            <>
              <div className="activity-dashboard-cards">
                {DASHBOARD_METRICS.map((metric) => (
                  <MetricCard
                    key={metric}
                    icon={METRIC_ICONS[metric]}
                    color={METRIC_COLORS[metric]}
                    label={METRIC_LABELS[metric]}
                    value={totals[metric]}
                    change={{ current: totals[metric], previous: previousTotals[metric] }}
                  />
                ))}
              </div>
              {hasEmail && (
                <div className="activity-dashboard-section">
                  <h4>El. paštas</h4>
                  <div className="activity-dashboard-cards">
                    <MetricCard
                      icon={Mail}
                      color={EMAIL_CARD_COLOR}
                      label="Laiškai išsiųsta"
                      value={summary.email!.sent}
                      change={{ current: summary.email!.sent, previous: summary.emailPrevious!.sent }}
                    />
                    <MetricCard
                      icon={MailCheck}
                      color={EMAIL_CARD_COLOR}
                      label="Gauta atsakymų"
                      value={summary.email!.replies}
                      change={{ current: summary.email!.replies, previous: summary.emailPrevious!.replies }}
                    />
                    <MetricCard
                      icon={Percent}
                      color={EMAIL_CARD_COLOR}
                      label="Atsakymų rodiklis"
                      value={summary.email!.sent > 0 ? `${Math.round((summary.email!.replies / summary.email!.sent) * 1000) / 10}%` : '—'}
                    />
                    <MetricCard
                      icon={Sparkles}
                      color={EMAIL_CARD_COLOR}
                      label="Pozityvių atsakymų dalis"
                      value={summary.email!.replies > 0 ? `${Math.round((summary.email!.positiveReplies / summary.email!.replies) * 1000) / 10}%` : '—'}
                    />
                  </div>
                  {canDiagnose && <SourceLogToggle source="instantly" />}
                </div>
              )}
            </>
          )}

          {showTeam && workers && workers.length > 0 && (
            <div className="activity-dashboard-workers">
              <h4>Pagal darbuotoją</h4>
              <div className="activity-dashboard-table-wrap">
                <table className="activity-dashboard-table" data-tutorial-id="dashboard-employee-table">
                  <thead>
                    <tr>
                      <th>Darbuotojas</th>
                      {DASHBOARD_METRICS.map((m) => (
                        <th key={m}>{METRIC_LABELS[m]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {workers.map((w) => (
                      <tr key={w.workerId}>
                        <td>{w.workerName}</td>
                        {DASHBOARD_METRICS.map((m) => (
                          <td key={m}>
                            <span className="activity-dashboard-table-cell">
                              <span>{w.metrics[m]}</span>
                              {/* Only when there's something to actually open —
                                  a zero-value cell has no underlying events to
                                  drill into. */}
                              {w.metrics[m] > 0 && (
                                <button
                                  type="button"
                                  className="activity-dashboard-open-btn"
                                  onClick={() => openTasksPanel(w.workerId, w.workerName, m)}
                                >
                                  Atverti
                                </button>
                              )}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
