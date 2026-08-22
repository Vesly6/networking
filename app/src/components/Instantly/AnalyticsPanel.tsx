import { useEffect, useRef, useState } from 'react';
import { useInstantlyCampaignsStore, type AnalyticsPeriod, type DateRange } from '../../store/useInstantlyCampaignsStore';
import { useToastStore } from '../../store/useToastStore';
import { CAMPAIGN_STATUS_LABELS, type InstantlyCampaignDailyAnalytics } from '../../utils/instantlyApi';

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function pct(numerator: number, denominator: number): string {
  return denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : '0%';
}

function statusPillStyle(status: number): { background: string; color: string } {
  if (status === 1) return { background: '#e5f0e3', color: '#1b7a3d' };
  if (status < 0) return { background: 'var(--danger-bg)', color: 'var(--danger)' };
  return { background: 'var(--bg-alt)', color: 'var(--text-muted)' };
}

const PERIOD_LABELS: Record<AnalyticsPeriod, string> = {
  '7d': 'Paskutinės 7 dienos',
  mtd: 'Nuo mėnesio pradžios',
  '4w': 'Paskutinės 4 savaitės',
  '3m': 'Paskutiniai 3 mėnesiai',
  '6m': 'Paskutiniai 6 mėnesiai',
  '12m': 'Paskutiniai 12 mėnesių',
  all: 'Visas laikotarpis (nuo 2024-06-05)',
  custom: 'Pasirinktas laikotarpis',
};

// Open rate / Click rate removed entirely on explicit request — not just
// hideable via the filter menu, gone from KPI_LABELS/ALL_KPI_KEYS so
// there's nothing left referencing open_count_unique/link_click_count_unique
// in this panel at all.
type KpiKey = 'sent' | 'reply' | 'opportunities';
const KPI_LABELS: Record<KpiKey, string> = {
  sent: 'Iš viso išsiųsta',
  reply: 'Atsakymų rodiklis',
  opportunities: 'Galimybės',
};
const ALL_KPI_KEYS = Object.keys(KPI_LABELS) as KpiKey[];

const SERIES_COLORS = { sent: 'var(--accent)', opened: '#e08a2b', uniqueOpened: '#c7d92c', replies: '#2fae5c' };

/** Hand-rolled SVG area chart — no charting library, matching this
 * codebase's own established convention (CallsStatsView's BarChart.tsx,
 * LinkedIn's own activity chart — both for the identical "keep the
 * bundle light" reasoning documented there). "Sent" is drawn as the
 * dominant filled area (by far the largest series in absolute terms,
 * matching the reference screenshot's own mountain-shaped blue area);
 * opens/replies/clicks share the same scale as thin lines near the
 * bottom, exactly as the reference shows them.
 *
 * A real, reported problem with the first version: a fixed 700×220
 * viewBox stretched via preserveAspectRatio="none" to fill a much wider
 * (often 1400px+) container flattened every peak — 700→1400 doubles the
 * horizontal scale with the vertical one untouched, so the same data
 * reads as squashed "plateaus" instead of real mountains ("график
 * сплющенный"). Raising the viewBox height (700×340) and the matching
 * CSS height narrows that mismatch — a full fix would mean measuring the
 * actual rendered width and building a matching viewBox, but that's a
 * lot of ResizeObserver plumbing for a chart whose job is "show the
 * shape of activity over time," not pixel-exact geometry. */
function AnalyticsAreaChart({ daily }: { daily: InstantlyCampaignDailyAnalytics[] }) {
  const width = 700;
  const height = 340;
  // bottom is small now — just breathing room below the lowest point,
  // not room for axis-label text anymore (see the date-label row below).
  const padding = { top: 10, right: 10, bottom: 8, left: 10 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const svgRef = useRef<SVGSVGElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  if (daily.length === 0) {
    return <p className="instantly-hint">Nėra duomenų šiam laikotarpiui.</p>;
  }

  const x = (i: number) => padding.left + (daily.length === 1 ? innerW / 2 : (i / (daily.length - 1)) * innerW);

  const sent = daily.map((d) => d.sent);
  const opened = daily.map((d) => d.opened);
  const uniqueOpened = daily.map((d) => d.unique_opened);
  const replies = daily.map((d) => d.replies);

  // Each smaller series gets its own y-scale (own max, not shared with
  // Sent) — a real, reported problem otherwise: Sent routinely runs
  // 800-1500/day while opens/replies are single digits to tens, so on one
  // shared linear scale the smaller lines rendered as a flat line
  // squashed against the bottom axis regardless of their real day-to-day
  // shape ("цыфры сплющенные" — a real screenshot confirmed this).
  // Trade-off, noted in the legend: a line reaching near the chart's top
  // means "near that series' own daily peak," not "close to Sent" — this
  // is the standard normalize-per-series approach any multi-magnitude
  // dashboard without a real second axis has to make.
  const makeY = (values: number[]) => {
    const max = Math.max(1, ...values);
    return (v: number) => padding.top + innerH - (Math.min(v, max) / max) * innerH;
  };
  const ySent = makeY(sent);
  const yOpened = makeY(opened);
  const yUniqueOpened = makeY(uniqueOpened);
  const yReplies = makeY(replies);

  const linePath = (values: number[], yFn: (v: number) => number) =>
    values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${yFn(v)}`).join(' ');
  const areaPath = (values: number[], yFn: (v: number) => number) =>
    `${linePath(values, yFn)} L ${x(values.length - 1)} ${yFn(0)} L ${x(0)} ${yFn(0)} Z`;

  const labelEvery = Math.max(1, Math.ceil(daily.length / 7));

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const relX = (e.clientX - rect.left) / rect.width;
    const idx = Math.max(0, Math.min(daily.length - 1, Math.round(relX * (daily.length - 1))));
    setHovered(idx);
    setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  const point = hovered !== null ? daily[hovered] : null;

  return (
    <div className="instantly-analytics-chart-wrap">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="instantly-analytics-chart"
        onMouseMove={handleMove}
        onMouseLeave={() => setHovered(null)}
      >
        <path d={areaPath(sent, ySent)} fill={SERIES_COLORS.sent} opacity="0.55" />
        <path d={linePath(sent, ySent)} fill="none" stroke={SERIES_COLORS.sent} strokeWidth="2" />
        <path d={linePath(opened, yOpened)} fill="none" stroke={SERIES_COLORS.opened} strokeWidth="1.5" />
        <path d={linePath(uniqueOpened, yUniqueOpened)} fill="none" stroke={SERIES_COLORS.uniqueOpened} strokeWidth="1.5" />
        <path d={linePath(replies, yReplies)} fill="none" stroke={SERIES_COLORS.replies} strokeWidth="1.5" />
        {hovered !== null && (
          <>
            <line x1={x(hovered)} y1={padding.top} x2={x(hovered)} y2={height - padding.bottom} stroke="var(--border-strong)" strokeDasharray="3 3" />
            <circle cx={x(hovered)} cy={ySent(sent[hovered])} r="5" fill={SERIES_COLORS.sent} stroke="var(--bg)" strokeWidth="2" />
          </>
        )}
      </svg>
      {/* Date labels are plain HTML, positioned by percentage, deliberately
       * NOT SVG <text> inside the chart above. A real, reported bug: the
       * viewBox (700 wide) gets stretched by preserveAspectRatio="none" to
       * fill a much wider real container (often 1400px+), and that
       * non-uniform x/y scaling distorts everything inside the SVG's
       * coordinate system — including glyph shapes, since text scales with
       * its surrounding transform same as any other SVG content. Lines
       * just look like a wider mountain either way, so nobody notices, but
       * digits warp into a visibly stretched, squashed shape ("цыфры
       * растянутые"). Plain HTML text sitting *outside* the SVG's own
       * transform never gets stretched, regardless of how wide the SVG
       * itself is scaled — position: percentage-of-container keeps each
       * label aligned under its own data point without needing any of the
       * SVG's internal coordinate math to leak out. */}
      <div className="instantly-analytics-chart-labels">
        {daily.map((d, i) =>
          i % labelEvery === 0 ? (
            <span key={d.date} className="instantly-analytics-chart-label" style={{ left: `${(x(i) / width) * 100}%` }}>
              {d.date.slice(5)}
            </span>
          ) : null,
        )}
      </div>
      {point && (
        <div
          className="instantly-analytics-tooltip"
          style={{ left: tooltipPos.x, top: Math.max(0, tooltipPos.y - 140) }}
        >
          <div className="instantly-analytics-tooltip-title">{point.date}</div>
          <div className="instantly-analytics-tooltip-row">
            <i style={{ background: SERIES_COLORS.sent }} /> Išsiųsta: <b>{point.sent}</b>
          </div>
          <div className="instantly-analytics-tooltip-row">
            <i style={{ background: SERIES_COLORS.opened }} /> Atidarymai: <b>{point.opened}</b>
          </div>
          <div className="instantly-analytics-tooltip-row">
            <i style={{ background: SERIES_COLORS.uniqueOpened }} /> Unikalūs atidarymai: <b>{point.unique_opened}</b>
          </div>
          <div className="instantly-analytics-tooltip-row">
            <i style={{ background: SERIES_COLORS.replies }} /> Atsakymai: <b>{point.replies}</b>
          </div>
        </div>
      )}
    </div>
  );
}

function DateRangePicker() {
  const period = useInstantlyCampaignsStore((s) => s.dashboardPeriod);
  const setPeriod = useInstantlyCampaignsStore((s) => s.setDashboardPeriod);
  const customRange = useInstantlyCampaignsStore((s) => s.dashboardCustomRange);
  const setCustomRange = useInstantlyCampaignsStore((s) => s.setDashboardCustomRange);
  const [draft, setDraft] = useState<DateRange>(customRange ?? { start_date: '', end_date: '' });

  return (
    <div className="instantly-analytics-range">
      <select value={period} onChange={(e) => setPeriod(e.target.value as AnalyticsPeriod)}>
        {(Object.keys(PERIOD_LABELS) as AnalyticsPeriod[]).map((p) => (
          <option key={p} value={p}>
            {PERIOD_LABELS[p]}
          </option>
        ))}
      </select>
      {period === 'custom' && (
        <>
          <input type="date" value={draft.start_date} onChange={(e) => setDraft((d) => ({ ...d, start_date: e.target.value }))} />
          <span>–</span>
          <input type="date" value={draft.end_date} onChange={(e) => setDraft((d) => ({ ...d, end_date: e.target.value }))} />
          <button
            type="button"
            disabled={!draft.start_date || !draft.end_date}
            onClick={() => setCustomRange(draft)}
          >
            Taikyti
          </button>
        </>
      )}
    </div>
  );
}

function KpiFilterMenu({ visible, onToggle }: { visible: Set<KpiKey>; onToggle: (key: KpiKey) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="instantly-analytics-kpi-filter">
      <button type="button" onClick={() => setOpen((v) => !v)}>
        ⚙️ Rodikliai
      </button>
      {open && (
        <div className="instantly-analytics-kpi-filter-menu">
          {ALL_KPI_KEYS.map((key) => (
            <label key={key} className="instantly-analytics-kpi-filter-item">
              <input type="checkbox" checked={visible.has(key)} onChange={() => onToggle(key)} />
              {KPI_LABELS[key]}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

export function AnalyticsPanel() {
  const overview = useInstantlyCampaignsStore((s) => s.dashboardOverview);
  const daily = useInstantlyCampaignsStore((s) => s.dashboardDaily);
  const rows = useInstantlyCampaignsStore((s) => s.dashboardRows);
  const ready = useInstantlyCampaignsStore((s) => s.dashboardReady);
  const error = useInstantlyCampaignsStore((s) => s.dashboardError);
  const refreshDashboard = useInstantlyCampaignsStore((s) => s.refreshDashboard);
  const showToast = useToastStore((s) => s.show);

  const [visibleKpis, setVisibleKpis] = useState<Set<KpiKey>>(new Set(ALL_KPI_KEYS));
  const toggleKpi = (key: KpiKey) =>
    setVisibleKpis((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  useEffect(() => {
    void refreshDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);

  const sentTotal = overview?.emails_sent_count ?? 0;

  return (
    <div className="instantly-panel instantly-analytics">
      <div className="instantly-toolbar">
        <DateRangePicker />
        <KpiFilterMenu visible={visibleKpis} onToggle={toggleKpi} />
      </div>

      {!ready && <p className="instantly-hint">Kraunama…</p>}

      {overview && (
        <div className="instantly-analytics-kpis">
          {visibleKpis.has('sent') && (
            <div className="instantly-analytics-kpi">
              <span className="instantly-analytics-kpi-label">{KPI_LABELS.sent}</span>
              <span className="instantly-analytics-kpi-value">{formatCount(sentTotal)}</span>
            </div>
          )}
          {visibleKpis.has('reply') && (
            <div className="instantly-analytics-kpi">
              <span className="instantly-analytics-kpi-label">{KPI_LABELS.reply}</span>
              <span className="instantly-analytics-kpi-value">{pct(overview.reply_count_unique, sentTotal)}</span>
            </div>
          )}
          {visibleKpis.has('opportunities') && (
            <div className="instantly-analytics-kpi">
              <span className="instantly-analytics-kpi-label">{KPI_LABELS.opportunities}</span>
              {/* total_opportunity_value ($ amount) deliberately not shown
                  here, on explicit request. */}
              <span className="instantly-analytics-kpi-value">{overview.total_opportunities}</span>
            </div>
          )}
        </div>
      )}

      <div className="instantly-analytics-chart-legend">
        <span>
          <i style={{ background: SERIES_COLORS.sent }} /> Išsiųsta
        </span>
        <span>
          <i style={{ background: SERIES_COLORS.opened }} /> Atidarymai
        </span>
        <span>
          <i style={{ background: SERIES_COLORS.uniqueOpened }} /> Unikalūs atidarymai
        </span>
        <span>
          <i style={{ background: SERIES_COLORS.replies }} /> Atsakymai
        </span>
        <span className="instantly-analytics-chart-legend-note">(kiekviena linija savo mastelyje)</span>
      </div>
      <AnalyticsAreaChart daily={daily} />

      <h3 className="instantly-analytics-table-title">Kampanijų analitika</h3>
      <div className="instantly-table-wrap">
        <table className="instantly-table">
          <thead>
            <tr>
              <th>Kampanija</th>
              <th></th>
              <th>Pradėta seka</th>
              <th>Atidaryta</th>
              <th>Atsakyta</th>
              <th>Galimybės</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const pill = statusPillStyle(r.campaign_status);
              return (
                <tr key={r.campaign_id}>
                  <td>{r.campaign_name}</td>
                  <td>
                    <span className="instantly-pill" style={pill}>
                      {CAMPAIGN_STATUS_LABELS[r.campaign_status] ?? r.campaign_status}
                    </span>
                  </td>
                  <td>{r.contacted_count}</td>
                  <td>{r.open_count}</td>
                  <td>
                    {r.reply_count} | {pct(r.reply_count, r.contacted_count)}
                  </td>
                  <td>{r.total_opportunities}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {ready && rows.length === 0 && <p className="instantly-hint">Nėra kampanijų duomenų šiam laikotarpiui.</p>}
    </div>
  );
}
