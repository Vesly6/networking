import type { LinkedInDailyActivity } from '../../utils/linkedinCampaignsApi';

// Same hand-rolled-SVG approach as Calls/BarChart.tsx — fixed logical
// viewBox scaled to the container's real width, no charting library. Two
// independent bars per day (connects, messages) side by side rather than
// one stacked/overlaid bar: unlike Calls' total/answered (answered is
// always a subset of total), a connect and a message here are two
// unrelated action types that can each be zero or nonzero independently,
// so an overlay would misleadingly imply one contains the other.
const WIDTH = 600;
const HEIGHT = 160;
const AXIS_HEIGHT = 18;
const PLOT_HEIGHT = HEIGHT - AXIS_HEIGHT;

function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

export function LinkedInActivityChart({ data }: { data: LinkedInDailyActivity[] }) {
  const max = Math.max(1, ...data.map((d) => Math.max(d.connectsSent, d.messagesSent)));
  const slot = WIDTH / Math.max(1, data.length);
  const barWidth = Math.min(slot * 0.32, 12);
  const gap = Math.min(slot * 0.08, 3);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className="linkedin-activity-chart"
      role="img"
      aria-label="LinkedIn veikla per dieną"
    >
      <line x1={0} y1={PLOT_HEIGHT} x2={WIDTH} y2={PLOT_HEIGHT} className="linkedin-activity-chart-baseline" />
      {data.map((d, i) => {
        const slotStart = i * slot;
        const pairWidth = barWidth * 2 + gap;
        const pairStart = slotStart + (slot - pairWidth) / 2;
        const connectH = (d.connectsSent / max) * (PLOT_HEIGHT - 4);
        const messageH = (d.messagesSent / max) * (PLOT_HEIGHT - 4);
        const showLabel = data.length <= 10 || i === 0 || i === data.length - 1 || i % 5 === 0;
        const title = `${d.date}: ${d.connectsSent} connect, ${d.messagesSent} žinučių${d.errors > 0 ? `, ${d.errors} klaidų` : ''}`;
        return (
          <g key={d.date}>
            <title>{title}</title>
            <rect
              x={pairStart}
              y={PLOT_HEIGHT - connectH}
              width={barWidth}
              height={connectH}
              rx={1.5}
              className="linkedin-activity-bar-connect"
            />
            <rect
              x={pairStart + barWidth + gap}
              y={PLOT_HEIGHT - messageH}
              width={barWidth}
              height={messageH}
              rx={1.5}
              className="linkedin-activity-bar-message"
            />
            {showLabel && (
              <text x={slotStart + slot / 2} y={HEIGHT - 4} textAnchor="middle" className="linkedin-activity-chart-label">
                {shortDate(d.date)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
