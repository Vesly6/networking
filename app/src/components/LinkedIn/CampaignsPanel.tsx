import { useEffect, useState } from 'react';
import { useLinkedInCampaignsStore } from '../../store/useLinkedInCampaignsStore';
import { CampaignDetail } from './CampaignDetail';

const STATUS_LABEL: Record<string, string> = {
  draft: 'Juodraštis',
  active: 'Aktyvi',
  paused: 'Pristabdyta',
  completed: 'Baigta',
};

/** Campaign list + create + detail (leads/CSV import/sequence steps).
 * Inbox, analytics, and stale-invite cleanup are their own sibling
 * subtabs (see LinkedInView.tsx). */
export function CampaignsPanel() {
  const campaigns = useLinkedInCampaignsStore((s) => s.campaigns);
  const campaignsReady = useLinkedInCampaignsStore((s) => s.campaignsReady);
  const refreshCampaigns = useLinkedInCampaignsStore((s) => s.refreshCampaigns);
  const creating = useLinkedInCampaignsStore((s) => s.creating);
  const createCampaign = useLinkedInCampaignsStore((s) => s.createCampaign);
  const openCampaignId = useLinkedInCampaignsStore((s) => s.openCampaignId);
  const setOpenCampaignId = useLinkedInCampaignsStore((s) => s.setOpenCampaignId);

  const [newName, setNewName] = useState('');

  useEffect(() => {
    void refreshCampaigns();
  }, [refreshCampaigns]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    const campaign = await createCampaign(name);
    if (campaign) {
      setNewName('');
      setOpenCampaignId(campaign.id);
    }
  };

  const openCampaign = campaigns.find((c) => c.id === openCampaignId);
  if (openCampaign) {
    return <CampaignDetail campaign={openCampaign} onBack={() => setOpenCampaignId(null)} />;
  }

  return (
    <div className="linkedin-campaigns-panel">
      <form
        className="linkedin-new-campaign"
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
      >
        <input
          type="text"
          placeholder="Naujos kampanijos pavadinimas…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button type="submit" className="primary" disabled={creating || !newName.trim()}>
          {creating ? 'Kuriama…' : '+ Nauja kampanija'}
        </button>
      </form>

      {campaignsReady && campaigns.length === 0 && <p className="linkedin-hint">Kol kas nėra kampanijų.</p>}

      {campaigns.length > 0 && (
        <div className="linkedin-campaigns-list">
          {campaigns.map((c) => (
            <button
              type="button"
              key={c.id}
              className="linkedin-campaign-row"
              onClick={() => setOpenCampaignId(c.id)}
            >
              <span className="linkedin-campaign-name">{c.name}</span>
              <span className={`linkedin-campaign-status linkedin-campaign-status-${c.status}`}>
                {STATUS_LABEL[c.status] ?? c.status}
              </span>
              <span className="linkedin-hint">{c.leadCount} lyderių</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
