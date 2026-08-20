import { useEffect, useMemo, useState } from 'react';
import { useLinkedInCampaignsStore } from '../../store/useLinkedInCampaignsStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { useToastStore } from '../../store/useToastStore';
import { exportLeadsToCsv, type LinkedInCampaign, type LinkedInLead, type LinkedInStepType } from '../../utils/linkedinCampaignsApi';
import { LeadCsvImport } from './LeadCsvImport';
import { LeadSearchImport } from './LeadSearchImport';

// UTC-anchored day key, same convention as utils/callStats.ts/analytics.ts's
// own dayKeyUtc — deliberate, not incidental: local-time bucketing here
// would risk the exact "advances by a day but lands on the same calendar
// date" class of bug already documented elsewhere in this codebase for
// date arithmetic that mixes local construction with UTC extraction (or
// vice versa). A plain day-of-month display, not arithmetic, so the risk
// is lower here regardless — but matching the established convention costs
// nothing and avoids having two different day-bucketing rules in one app.
function dayKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('lt-LT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

type LeadPanel = 'sent' | 'connected' | 'messaged' | 'all';

const PANEL_TIMESTAMP_FIELD: Record<Exclude<LeadPanel, 'all'>, keyof Pick<LinkedInLead, 'connectSentAt' | 'connectedAt' | 'messageSentAt'>> = {
  sent: 'connectSentAt',
  connected: 'connectedAt',
  messaged: 'messageSentAt',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Juodraštis',
  active: 'Aktyvi',
  paused: 'Pristabdyta',
  completed: 'Baigta',
};

const LEAD_STATUS_LABEL: Record<string, string> = {
  new: 'Nauja',
  connected: 'Prisijungta',
  pending: 'Laukiama',
  replied: 'Atsakė',
  skipped: 'Praleista',
  withdrawn: 'Atšaukta',
};

const STEP_TYPE_LABEL: Record<string, string> = {
  connect: '🤝 Connection request',
  message: '✉️ Žinutė',
};

interface CampaignDetailProps {
  campaign: LinkedInCampaign;
  onBack: () => void;
}

/** One campaign's lead list + CSV import. No sequence_steps/Scheduler yet
 * (see the saved plan) — this is the data layer (leads in, ready for a
 * sequence to run against once the Scheduler exists), not execution. */
export function CampaignDetail({ campaign, onBack }: CampaignDetailProps) {
  const leads = useLinkedInCampaignsStore((s) => s.leads);
  const leadsReady = useLinkedInCampaignsStore((s) => s.leadsReady);
  const refreshLeads = useLinkedInCampaignsStore((s) => s.refreshLeads);
  const importLeads = useLinkedInCampaignsStore((s) => s.importLeads);
  const importing = useLinkedInCampaignsStore((s) => s.importing);
  const removeLead = useLinkedInCampaignsStore((s) => s.removeLead);
  const updateCampaignStatus = useLinkedInCampaignsStore((s) => s.updateCampaignStatus);
  const deleteCampaign = useLinkedInCampaignsStore((s) => s.deleteCampaign);
  const steps = useLinkedInCampaignsStore((s) => s.steps);
  const refreshSteps = useLinkedInCampaignsStore((s) => s.refreshSteps);
  const addingStep = useLinkedInCampaignsStore((s) => s.addingStep);
  const addStep = useLinkedInCampaignsStore((s) => s.addStep);
  const removeStep = useLinkedInCampaignsStore((s) => s.removeStep);
  const showToast = useToastStore((s) => s.show);

  const [importOpen, setImportOpen] = useState(false);
  const [searchImportOpen, setSearchImportOpen] = useState(false);
  const [newStepType, setNewStepType] = useState<LinkedInStepType>('connect');
  const [newStepDelay, setNewStepDelay] = useState('0');
  const [newStepMessage, setNewStepMessage] = useState('');
  const [leadPanel, setLeadPanel] = useState<LeadPanel>('sent');
  const [dateFilter, setDateFilter] = useState<string>('all');

  // Every lead that has a timestamp for the current panel's event
  // (connect sent / accepted / messaged), newest first — 'all' keeps the
  // original full list untouched. Reset separately below whenever the
  // panel changes, since a date picked in one panel ("today" under Sent)
  // has no guaranteed meaning in another (a lead sent today might connect
  // days later).
  const panelLeads = useMemo(() => {
    if (leadPanel === 'all') return leads;
    const field = PANEL_TIMESTAMP_FIELD[leadPanel];
    return leads.filter((l) => l[field] !== null).sort((a, b) => (b[field] ?? 0) - (a[field] ?? 0));
  }, [leads, leadPanel]);

  const availableDates = useMemo(() => {
    if (leadPanel === 'all') return [];
    const field = PANEL_TIMESTAMP_FIELD[leadPanel];
    const days = new Set<string>();
    for (const l of panelLeads) {
      const ts = l[field];
      if (ts !== null) days.add(dayKeyUtc(ts));
    }
    return Array.from(days).sort((a, b) => (a < b ? 1 : -1));
  }, [panelLeads, leadPanel]);

  const visibleLeads = useMemo(() => {
    if (leadPanel === 'all' || dateFilter === 'all') return panelLeads;
    const field = PANEL_TIMESTAMP_FIELD[leadPanel];
    return panelLeads.filter((l) => {
      const ts = l[field];
      return ts !== null && dayKeyUtc(ts) === dateFilter;
    });
  }, [panelLeads, leadPanel, dateFilter]);

  const handlePanelChange = (panel: LeadPanel) => {
    setLeadPanel(panel);
    setDateFilter('all');
  };

  useEffect(() => {
    void refreshLeads(campaign.id);
    void refreshSteps(campaign.id);
  }, [campaign.id, refreshLeads, refreshSteps]);

  const handleAddStep = async () => {
    if (newStepType === 'message' && !newStepMessage.trim()) {
      showToast('Žinutės žingsniui reikia teksto');
      return;
    }
    await addStep(campaign.id, newStepType, Number(newStepDelay) || 0, newStepMessage.trim() || undefined);
    setNewStepMessage('');
    setNewStepDelay('0');
  };

  const handleRemoveStep = async (id: string) => {
    if (!(await confirmDialog({ message: 'Pašalinti šį sekos žingsnį?', danger: true }))) return;
    await removeStep(id);
  };

  const handleImportConfirm = async (newLeads: Parameters<typeof importLeads>[1]) => {
    setImportOpen(false);
    setSearchImportOpen(false);
    const inserted = await importLeads(campaign.id, newLeads);
    if (inserted !== null) showToast(`Importuota lyderių: ${inserted} iš ${newLeads.length}`);
  };

  const handleRemoveLead = async (id: string) => {
    if (!(await confirmDialog({ message: 'Pašalinti šį lyderį iš kampanijos?', danger: true }))) return;
    await removeLead(id);
  };

  const handleDeleteCampaign = async () => {
    const ok = await confirmDialog({
      message: `Ištrinti kampaniją "${campaign.name}" ir visus jos ${campaign.leadCount} lyderius? Tai neatšaukiama (bet niekas realiame LinkedIn nepasikeis — tik vietiniai duomenys).`,
      danger: true,
      confirmLabel: 'Ištrinti',
    });
    if (!ok) return;
    await deleteCampaign(campaign.id);
    showToast('Kampanija ištrinta');
    onBack();
  };

  return (
    <div className="linkedin-campaign-detail">
      <div className="linkedin-campaign-detail-header">
        <button type="button" onClick={onBack}>
          ← Kampanijos
        </button>
        <h3>{campaign.name}</h3>
        <select
          value={campaign.status}
          onChange={(e) => void updateCampaignStatus(campaign.id, e.target.value as LinkedInCampaign['status'])}
        >
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button type="button" className="linkedin-delete-campaign" onClick={() => void handleDeleteCampaign()}>
          🗑 Ištrinti kampaniją
        </button>
      </div>

      <div className="linkedin-sequence">
        <h4>Seka</h4>
        <p className="linkedin-hint">
          Kiekvienas žingsnis vyksta praėjus nurodytam dienų skaičiui nuo ankstesnio žingsnio (0 = iš karto, kai lyderis
          pasiekia šį žingsnį). Žinutės žingsnis suveikia tik jau prisijungusiems lyderiams.
        </p>
        {steps.length > 0 && (
          <ol className="linkedin-sequence-list">
            {steps.map((step) => (
              <li key={step.id} className="linkedin-sequence-step">
                <span className="linkedin-sequence-step-type">{STEP_TYPE_LABEL[step.type] ?? step.type}</span>
                <span className="linkedin-hint">
                  {step.delayDays > 0 ? `po ${step.delayDays} d.` : 'iš karto'}
                </span>
                {step.messageTemplate && <span className="linkedin-sequence-step-message">"{step.messageTemplate}"</span>}
                <button type="button" className="linkedin-lead-remove" onClick={() => void handleRemoveStep(step.id)}>
                  ×
                </button>
              </li>
            ))}
          </ol>
        )}
        <div className="linkedin-add-step">
          <select value={newStepType} onChange={(e) => setNewStepType(e.target.value as LinkedInStepType)}>
            <option value="connect">🤝 Connection request</option>
            <option value="message">✉️ Žinutė</option>
          </select>
          <label>
            Vėlinimas (d.)
            <input
              type="number"
              min={0}
              value={newStepDelay}
              onChange={(e) => setNewStepDelay(e.target.value)}
            />
          </label>
          {newStepType === 'message' && (
            <input
              type="text"
              placeholder="Žinutės tekstas…"
              value={newStepMessage}
              onChange={(e) => setNewStepMessage(e.target.value)}
            />
          )}
          <button type="button" disabled={addingStep} onClick={() => void handleAddStep()}>
            {addingStep ? 'Pridedama…' : '+ Pridėti žingsnį'}
          </button>
        </div>
      </div>

      <div className="linkedin-leads-toolbar">
        <span className="linkedin-hint">{leads.length} lyderių</span>
        <button type="button" onClick={() => setImportOpen(true)} disabled={importing}>
          {importing ? 'Importuojama…' : '📥 Importuoti iš CSV'}
        </button>
        <button type="button" onClick={() => setSearchImportOpen(true)} disabled={importing}>
          🔍 Ieškoti LinkedIn
        </button>
        <button type="button" disabled={leads.length === 0} onClick={() => exportLeadsToCsv(campaign.name, leads)}>
          ⬇ Eksportuoti CSV
        </button>
      </div>

      {leadsReady && leads.length === 0 && (
        <p className="linkedin-hint">Kol kas nėra lyderių — importuokite CSV arba ieškokite LinkedIn.</p>
      )}

      {leads.length > 0 && (
        <>
          <nav className="linkedin-lead-panel-nav">
            <button type="button" className={leadPanel === 'sent' ? 'active' : ''} onClick={() => handlePanelChange('sent')}>
              📤 Išsiųsti ({leads.filter((l) => l.connectSentAt !== null).length})
            </button>
            <button type="button" className={leadPanel === 'connected' ? 'active' : ''} onClick={() => handlePanelChange('connected')}>
              ✅ Prisijungę ({leads.filter((l) => l.connectedAt !== null).length})
            </button>
            <button type="button" className={leadPanel === 'messaged' ? 'active' : ''} onClick={() => handlePanelChange('messaged')}>
              ✉️ Žinutės ({leads.filter((l) => l.messageSentAt !== null).length})
            </button>
            <button type="button" className={leadPanel === 'all' ? 'active' : ''} onClick={() => handlePanelChange('all')}>
              Visi lyderiai ({leads.length})
            </button>
          </nav>

          {leadPanel !== 'all' && availableDates.length > 0 && (
            <div className="linkedin-lead-date-filter">
              <label>
                Diena
                <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)}>
                  <option value="all">Visos dienos</option>
                  {availableDates.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {leadPanel !== 'all' && visibleLeads.length === 0 && (
            <p className="linkedin-hint">
              {leadPanel === 'sent' && 'Kol kas niekam neišsiųsta connection request.'}
              {leadPanel === 'connected' && 'Kol kas niekas nepriėmė kvietimo.'}
              {leadPanel === 'messaged' && 'Kol kas niekam neišsiųsta žinutė.'}
            </p>
          )}

          {leadPanel === 'all' ? (
            <table className="linkedin-leads-table">
              <thead>
                <tr>
                  <th>Vardas</th>
                  <th>Pareigos</th>
                  <th>Įmonė</th>
                  <th>LinkedIn</th>
                  <th>Būsena</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {leads.map((lead) => (
                  <tr key={lead.id}>
                    <td>{lead.name || '—'}</td>
                    <td>{lead.title || '—'}</td>
                    <td>{lead.company || '—'}</td>
                    <td>
                      <a href={lead.linkedinUrl} target="_blank" rel="noopener noreferrer">
                        profilis ↗
                      </a>
                    </td>
                    <td>{LEAD_STATUS_LABEL[lead.status] ?? lead.status}</td>
                    <td>
                      <button type="button" className="linkedin-lead-remove" onClick={() => void handleRemoveLead(lead.id)}>
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            visibleLeads.length > 0 && (
              <table className="linkedin-leads-table">
                <thead>
                  <tr>
                    <th>Vardas</th>
                    <th>Įmonė</th>
                    <th>LinkedIn</th>
                    <th>{leadPanel === 'sent' && 'Išsiųsta'}{leadPanel === 'connected' && 'Prisijungė'}{leadPanel === 'messaged' && 'Žinutė išsiųsta'}</th>
                    <th>Būsena</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLeads.map((lead) => {
                    const ts = lead[PANEL_TIMESTAMP_FIELD[leadPanel]];
                    return (
                      <tr key={lead.id}>
                        <td>{lead.name || '—'}</td>
                        <td>{lead.company || '—'}</td>
                        <td>
                          <a href={lead.linkedinUrl} target="_blank" rel="noopener noreferrer">
                            profilis ↗
                          </a>
                        </td>
                        <td>{ts !== null ? formatDateTime(ts) : '—'}</td>
                        <td>{LEAD_STATUS_LABEL[lead.status] ?? lead.status}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          )}
        </>
      )}

      {importOpen && (
        <LeadCsvImport onConfirm={(newLeads) => void handleImportConfirm(newLeads)} onCancel={() => setImportOpen(false)} />
      )}
      {searchImportOpen && (
        <LeadSearchImport
          onConfirm={(newLeads) => void handleImportConfirm(newLeads)}
          onCancel={() => setSearchImportOpen(false)}
        />
      )}
    </div>
  );
}
