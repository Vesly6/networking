import { useEffect, useState } from 'react';
import { useInstantlyCampaignsStore } from '../../store/useInstantlyCampaignsStore';
import { useToastStore } from '../../store/useToastStore';
import { CAMPAIGN_STATUS_LABELS, type InstantlyCampaign } from '../../utils/instantlyApi';
import { CampaignSequenceModal } from './CampaignSequenceModal';
import { Eye } from 'lucide-react';

function statusPillStyle(status: number): { background: string; color: string } {
  if (status === 1) return { background: '#e5f0e3', color: '#1b7a3d' };
  if (status < 0) return { background: 'var(--danger-bg)', color: 'var(--danger)' };
  return { background: 'var(--bg-alt)', color: 'var(--text-muted)' };
}

/** Re-added on explicit request — a plain, read-first list of every
 * campaign in the account, with a way to open one and see (and edit) the
 * actual email text it sends. This is deliberately NOT the old
 * Campaigns/Leads browser that was removed earlier (see
 * InstantlyView.tsx's own doc comment) — no lead management here, just
 * "which campaigns exist" and "what do they say," reusing the same
 * `campaigns` list state AnalyticsPanel's own filter/table already
 * shares (useInstantlyCampaignsStore), so opening this tab doesn't
 * re-fetch anything that's already loaded. */
export function CampaignsPanel() {
  const campaigns = useInstantlyCampaignsStore((s) => s.campaigns);
  const ready = useInstantlyCampaignsStore((s) => s.ready);
  const error = useInstantlyCampaignsStore((s) => s.error);
  const refresh = useInstantlyCampaignsStore((s) => s.refresh);
  const showToast = useToastStore((s) => s.show);
  const [openCampaignId, setOpenCampaignId] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);

  const renderRow = (campaign: InstantlyCampaign) => {
    const pill = statusPillStyle(campaign.status);
    return (
      <div className="instantly-row" key={campaign.id}>
        <div className="instantly-row-main">
          <span className="instantly-row-title">{campaign.name}</span>
          {campaign.daily_limit !== undefined && (
            <span className="instantly-row-subtitle">Dienos limitas: {campaign.daily_limit}</span>
          )}
        </div>
        <span className="instantly-pill" style={pill}>
          {CAMPAIGN_STATUS_LABELS[campaign.status] ?? campaign.status}
        </span>
        <div className="instantly-row-actions">
          <button type="button" onClick={() => setOpenCampaignId(campaign.id)}>
            <Eye className="icon" size={14} /> Peržiūrėti tekstą
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="instantly-panel">
      {ready && campaigns.length === 0 && <p className="instantly-hint">Kol kas nėra kampanijų.</p>}
      <div className="instantly-list">{campaigns.map(renderRow)}</div>
      {openCampaignId && <CampaignSequenceModal campaignId={openCampaignId} onClose={() => setOpenCampaignId(null)} />}
    </div>
  );
}
