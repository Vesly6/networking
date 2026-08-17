export interface BarChartPoint {
  label: string;
  fullLabel: string;
  total: number;
  answered: number;
}

interface BarChartProps {
  data: BarChartPoint[];
}

// Fixed logical coordinate space, scaled to the container's real width via
// `width="100%"` + `preserveAspectRatio="none"` on the <svg> — a standard,
// dependency-free way to get a chart that's responsive horizontally while
// keeping a fixed aspect/height. No charting library needed for what's
// just bars in a row; kept it hand-rolled to avoid pulling in something
// like recharts for this one view (this app has stayed dependency-light
// everywhere else, e.g. the hand-drawn dropdown chevron in App.css).
const WIDTH = 600;
const HEIGHT = 160;
const AXIS_HEIGHT = 18;
const PLOT_HEIGHT = HEIGHT - AXIS_HEIGHT;

/** A bar per data point — the full bar is the total dial count (muted),
 * with the answered count drawn as a shorter, filled-in overlay from the
 * same baseline, so "answered vs. total" reads as one glance per bar
 * rather than needing a legend to compare two separate series. Native
 * <title> tooltips carry the exact numbers per bar (fullLabel), so axis
 * labels below can stay short without losing precision on hover. */
export function BarChart({ data }: BarChartProps) {
  const max = Math.max(1, ...data.map((d) => d.total));
  const slot = WIDTH / Math.max(1, data.length);
  const barWidth = Math.min(slot * 0.6, 28);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className="calls-bar-chart"
      role="img"
      aria-label="Calls per day"
    >
      <line x1={0} y1={PLOT_HEIGHT} x2={WIDTH} y2={PLOT_HEIGHT} className="calls-bar-chart-baseline" />
      {data.map((d, i) => {
        const x = i * slot + (slot - barWidth) / 2;
        const totalH = (d.total / max) * (PLOT_HEIGHT - 4);
        const answeredH = (d.answered / max) * (PLOT_HEIGHT - 4);
        // Sparse x-axis labels for wide (month-length) datasets — showing
        // all ~30 would just overlap into an unreadable smear.
        const showLabel = data.length <= 10 || i === 0 || i === data.length - 1 || i % 5 === 0;
        return (
          <g key={d.label}>
            <title>{d.fullLabel}</title>
            <rect x={x} y={PLOT_HEIGHT - totalH} width={barWidth} height={totalH} rx={2} className="calls-bar-total" />
            <rect x={x} y={PLOT_HEIGHT - answeredH} width={barWidth} height={answeredH} rx={2} className="calls-bar-answered" />
            {showLabel && (
              <text x={x + barWidth / 2} y={HEIGHT - 4} textAnchor="middle" className="calls-bar-chart-label">
                {d.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
