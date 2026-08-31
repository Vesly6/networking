import { Fragment, useEffect, useState } from 'react';
import {
  fetchAnalytics,
  fetchDailyActivity,
  fetchCampaignStepBreakdown,
  type LinkedInAnalyticsSummary,
  type LinkedInDailyActivity,
  type LinkedInStepBreakdown,
} from '../../utils/linkedinCampaignsApi';
import { LinkedInActivityChart } from './LinkedInActivityChart';
import { nodeTypeIcon, nodeTypeLabel } from '../../utils/linkedinNodeTypes';

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** One campaign's per-step funnel, fetched on demand only when its row is
 * expanded — not prefetched for every campaign up front, since most
 * sessions only ever look closely at one or two. Answers "where exactly
 * are leads dropping off" (a failed step 2 vs. one nobody's reached yet),
 * which the overall sent/accepted/replied numbers above can't distinguish
 * — see server/src/linkedin/analytics.ts's getCampaignStepBreakdown. */
function CampaignStepBreakdown({ campaignId }: { campaignId: string }) {
  const [steps, setSteps] = useState<LinkedInStepBreakdown[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchCampaignStepBreakdown(campaignId).then((res) => {
      if (!cancelled) setSteps(res.steps);
    });
    return () => {
      cancelled = true;
    };
  }, [campaignId]);

  if (!steps) return <p className="linkedin-hint">Kraunama…</p>;
  if (steps.length === 0) return <p className="linkedin-hint">Šioje kampanijoje dar nėra sekos žingsnių.</p>;

  return (
    <table className="linkedin-step-breakdown-table">
      <thead>
        <tr>
          <th>Mazgas</th>
          <th>Laukia</th>
          <th title="Pasiektas ankstesnis mazgas, bet dar neprisijungę — žinutė nebus siunčiama, kol nepriims kvietimo">
            Blokuota
          </th>
          <th>Atlikta</th>
          <th>Nepavyksta</th>
        </tr>
      </thead>
      <tbody>
        {steps.map((s) => {
          const StepIcon = nodeTypeIcon(s.type);
          return (
          <tr key={s.stepId}>
            <td>{StepIcon && <StepIcon className="icon" size={16} />} {nodeTypeLabel(s.type)}</td>
            <td>{s.waiting}</td>
            <td>{s.blocked}</td>
            <td>{s.completed}</td>
            <td>{s.failing > 0 ? <span className="linkedin-step-failing">{s.failing}</span> : s.failing}</td>
          </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** "Basic" per the plan (Phase 1) — a funnel (sent -> accepted -> replied)
 * overall and per campaign, computed live from current lead statuses (see
 * server/src/linkedin/analytics.ts) rather than a separate rollup table.
 * Phase 2 adds two things that funnel alone can't show: a daily activity
 * chart (how much was actually sent, day by day — this app's own
 * permanent record, since LinkedIn's UI doesn't surface this at all), and,
 * per campaign, a click-to-expand step breakdown (where exactly leads are
 * dropping off within a multi-step sequence). Local component state, not
 * a store — mirrors CallsStatsView.tsx's own convention for a simple
 * read-only stats fetch. */
export function AnalyticsPanel() {
  const [summary, setSummary] = useState<LinkedInAnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [daily, setDaily] = useState<LinkedInDailyActivity[] | null>(null);
  const [expandedCampaignId, setExpandedCampaignId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAnalytics()
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    fetchDailyActivity(30).then((res) => {
      if (!cancelled) setDaily(res.days);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <p className="linkedin-hint">Kraunama…</p>;
  if (!summary) return <p className="linkedin-hint">Nepavyko įkelti analitikos.</p>;

  const activityTotals = daily?.reduce(
    (acc, d) => ({ connects: acc.connects + d.connectsSent, messages: acc.messages + d.messagesSent, errors: acc.errors + d.errors }),
    { connects: 0, messages: 0, errors: 0 },
  );

  return (
    <div className="linkedin-analytics">
      <h3>Bendra visų kampanijų statistika</h3>
      <div className="linkedin-stats-cards">
        <div className="linkedin-stats-card">
          <div className="linkedin-stats-card-value">{summary.overall.totalLeads}</div>
          <div className="linkedin-stats-card-label">Lyderių iš viso</div>
        </div>
        <div className="linkedin-stats-card">
          <div className="linkedin-stats-card-value">{summary.overall.sent}</div>
          <div className="linkedin-stats-card-label">Išsiųsta connect</div>
        </div>
        <div className="linkedin-stats-card">
          <div className="linkedin-stats-card-value">{summary.overall.accepted}</div>
          <div className="linkedin-stats-card-label">Priimta ({pct(summary.overall.acceptRate)})</div>
        </div>
        <div className="linkedin-stats-card">
          <div className="linkedin-stats-card-value">{summary.overall.replied}</div>
          <div className="linkedin-stats-card-label">Atsakė ({pct(summary.overall.replyRate)})</div>
        </div>
      </div>

      {daily && daily.length > 0 && (
        <div className="linkedin-activity-section">
          <h4>Veikla per paskutines 30 dienų</h4>
          {activityTotals && (
            <p className="linkedin-hint">
              Iš viso: {activityTotals.connects} connect, {activityTotals.messages} žinučių
              {activityTotals.errors > 0 ? `, ${activityTotals.errors} klaidų` : ''}
            </p>
          )}
          <LinkedInActivityChart data={daily} />
          <div className="linkedin-activity-legend">
            <span className="linkedin-activity-legend-item">
              <span className="linkedin-activity-legend-swatch linkedin-activity-legend-connect" /> Connection request
            </span>
            <span className="linkedin-activity-legend-item">
              <span className="linkedin-activity-legend-swatch linkedin-activity-legend-message" /> Žinutė
            </span>
          </div>
        </div>
      )}

      {summary.campaigns.length === 0 && <p className="linkedin-hint">Kol kas nėra kampanijų.</p>}

      {summary.campaigns.length > 0 && (
        <table className="linkedin-analytics-table">
          <thead>
            <tr>
              <th>Kampanija</th>
              <th>Lyderių</th>
              <th>Išsiųsta</th>
              <th>Priimta</th>
              <th>Atsakė</th>
              <th>Priėmimo %</th>
              <th>Atsakymo %</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {summary.campaigns.map((c) => (
              <Fragment key={c.campaignId}>
                <tr>
                  <td>{c.campaignName}</td>
                  <td>{c.totalLeads}</td>
                  <td>{c.sent}</td>
                  <td>{c.accepted}</td>
                  <td>{c.replied}</td>
                  <td>{pct(c.acceptRate)}</td>
                  <td>{pct(c.replyRate)}</td>
                  <td>
                    <button
                      type="button"
                      className="linkedin-step-breakdown-toggle"
                      onClick={() => setExpandedCampaignId((prev) => (prev === c.campaignId ? null : c.campaignId))}
                    >
                      {expandedCampaignId === c.campaignId ? '▲ Slėpti žingsnius' : '▼ Žingsniai'}
                    </button>
                  </td>
                </tr>
                {expandedCampaignId === c.campaignId && (
                  <tr className="linkedin-step-breakdown-row">
                    <td colSpan={8}>
                      <CampaignStepBreakdown campaignId={c.campaignId} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
