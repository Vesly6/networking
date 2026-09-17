import { useEffect, useState } from 'react';
import { FileText, Users, Phone, Send, Mail, RefreshCw, ArrowUp, ArrowDown, ChevronDown, ChevronUp } from 'lucide-react';
import { useDashboardStore } from '../../store/useDashboardStore';
import { useAuthStore } from '../../store/useAuthStore';
import { can } from '../../utils/permissions';
import { DASHBOARD_METRICS, fetchDashboardSyncLog, type DashboardMetric, type DashboardPeriod, type DashboardSyncLogEntry } from '../../utils/dashboardApi';

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

const PERIOD_LABELS: Record<DashboardPeriod, string> = {
  today: 'Šiandien',
  yesterday: 'Vakar',
  '7d': '7 dienos',
  '30d': '30 dienų',
  month: 'Šis mėnuo',
  custom: 'Pasirinktas laikotarpis',
};

const PERIOD_OPTIONS: DashboardPeriod[] = ['today', 'yesterday', '7d', '30d', 'month'];

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
          {!loading && lastError && (
            <div className="activity-dashboard-error">
              Paskutinė sinchronizacija nepavyko: {lastError}
            </div>
          )}
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

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) {
    return (
      <div className="activity-dashboard" data-tutorial-id="activity-dashboard">
        <div className="activity-dashboard-loading">Kraunama aktyvumo statistika…</div>
      </div>
    );
  }

  if (error && !summary) {
    return (
      <div className="activity-dashboard" data-tutorial-id="activity-dashboard">
        <div className="activity-dashboard-error">{error}</div>
      </div>
    );
  }

  if (!summary) return null;

  const showTeam = summary.canViewTeam;
  const totals = showTeam ? summary.team! : summary.own;
  const previousTotals = showTeam ? summary.teamPrevious! : summary.ownPrevious;
  const hasAnyActivity = DASHBOARD_METRICS.some((m) => totals[m] > 0);

  return (
    <div className="activity-dashboard" data-tutorial-id="activity-dashboard">
      <div className="activity-dashboard-header">
        <h3>Komandos aktyvumas</h3>
        <div className="activity-dashboard-controls" data-tutorial-id="dashboard-period-selector">
          <select value={period} onChange={(e) => setPeriod(e.target.value as DashboardPeriod)}>
            {PERIOD_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABELS[p]}
              </option>
            ))}
          </select>
          <span className="activity-dashboard-updated">{timeAgoLabel(summary.updatedAt)}</span>
          <button type="button" onClick={() => void forceRefresh()} disabled={refreshing} title="Priverstinai atnaujinti">
            <RefreshCw className={`icon${refreshing ? ' activity-dashboard-spinning' : ''}`} size={14} />
            Atnaujinti
          </button>
        </div>
      </div>

      {error && <div className="activity-dashboard-error activity-dashboard-error-inline">{error}</div>}

      {!hasAnyActivity ? (
        <div className="activity-dashboard-empty">Šiuo laikotarpiu veiklos dar nėra.</div>
      ) : (
        <div className="activity-dashboard-cards">
          {DASHBOARD_METRICS.map((metric) => {
            const Icon = METRIC_ICONS[metric];
            return (
              <div className="activity-dashboard-card" key={metric} data-tutorial-id="dashboard-metric-card">
                <div className="activity-dashboard-card-label">
                  <Icon className="icon" size={14} />
                  {METRIC_LABELS[metric]}
                </div>
                <div className="activity-dashboard-card-value">{totals[metric]}</div>
                <ChangeIndicator current={totals[metric]} previous={previousTotals[metric]} />
              </div>
            );
          })}
        </div>
      )}

      {showTeam && summary.email && summary.emailPrevious && (
        <div className="activity-dashboard-cards activity-dashboard-cards-secondary">
          <div className="activity-dashboard-card" data-tutorial-id="dashboard-metric-card">
            <div className="activity-dashboard-card-label">
              <Mail className="icon" size={14} />
              Laiškai išsiųsta
            </div>
            <div className="activity-dashboard-card-value">{summary.email.sent}</div>
            <ChangeIndicator current={summary.email.sent} previous={summary.emailPrevious.sent} />
          </div>
          <div className="activity-dashboard-card" data-tutorial-id="dashboard-metric-card">
            <div className="activity-dashboard-card-label">
              <Mail className="icon" size={14} />
              Gauta atsakymų
            </div>
            <div className="activity-dashboard-card-value">{summary.email.replies}</div>
            <ChangeIndicator current={summary.email.replies} previous={summary.emailPrevious.replies} />
          </div>
          <div className="activity-dashboard-card" data-tutorial-id="dashboard-metric-card">
            <div className="activity-dashboard-card-label">
              <Mail className="icon" size={14} />
              Atsakymų rodiklis
            </div>
            <div className="activity-dashboard-card-value">
              {summary.email.sent > 0 ? `${Math.round((summary.email.replies / summary.email.sent) * 1000) / 10}%` : '—'}
            </div>
          </div>
          {canDiagnose && <SourceLogToggle source="instantly" />}
        </div>
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
                      <td key={m}>{w.metrics[m]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
