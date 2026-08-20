import { useEffect } from 'react';
import { useLinkedInCampaignsStore } from '../../store/useLinkedInCampaignsStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { useToastStore } from '../../store/useToastStore';

/** Phase 3's "auto-withdraw stale invites" (TZ_LinkedIn_Automation.md
 * section 3) — deliberately NOT automatic despite the TZ's own naming:
 * this lists every connection request that's sat 'pending' too long with
 * no response, and withdrawing one is a real, explicit, confirmed click
 * per lead, same shape as the Pending Approval panel and never wired into
 * the background scheduler tick (see scheduler.ts's own doc comment on
 * why). A stale invite isn't urgent the way a due outreach step is, so
 * this reads from a manual "↻" refresh rather than polling on an
 * interval. */
export function StaleInvitesPanel() {
  const staleInvites = useLinkedInCampaignsStore((s) => s.staleInvites);
  const staleInvitesReady = useLinkedInCampaignsStore((s) => s.staleInvitesReady);
  const refreshStaleInvites = useLinkedInCampaignsStore((s) => s.refreshStaleInvites);
  const withdrawingKeys = useLinkedInCampaignsStore((s) => s.withdrawingKeys);
  const withdrawInvite = useLinkedInCampaignsStore((s) => s.withdrawInvite);
  const showToast = useToastStore((s) => s.show);

  useEffect(() => {
    void refreshStaleInvites();
  }, [refreshStaleInvites]);

  const handleWithdraw = async (leadId: string, label: string) => {
    const ok = await confirmDialog({
      message: `Atšaukti šį kvietimą LinkedIn?\n\n${label}\n\nŠio veiksmo atšaukti negalima.`,
      danger: true,
      confirmLabel: 'Atšaukti kvietimą',
    });
    if (!ok) return;
    const success = await withdrawInvite(leadId);
    showToast(success ? 'Kvietimas atšauktas' : 'Nepavyko atšaukti kvietimo');
  };

  return (
    <div className="linkedin-stale-invites">
      <div className="linkedin-pending-approval-header">
        <h4>🕐 Užstrigę kvietimai ({staleInvites.length})</h4>
        <button type="button" onClick={() => void refreshStaleInvites()}>
          ↻
        </button>
      </div>
      <p className="linkedin-hint">
        Connection request išsiųsti prieš 14+ dienų, į kuriuos niekas neatsakė. Atšaukimas — realus veiksmas realiame
        LinkedIn profilyje, patvirtinamas atskirai kiekvienam.
      </p>
      {staleInvitesReady && staleInvites.length === 0 && (
        <p className="linkedin-hint">Kol kas nėra užstrigusių kvietimų.</p>
      )}
      {staleInvites.map((s) => {
        const label = `${s.leadName ?? s.leadUrl} (${s.campaignName}) — išsiųsta prieš ${s.daysSince} d.`;
        return (
          <div key={s.leadId} className="linkedin-pending-row">
            <span>{s.leadName || s.leadUrl}</span>
            <span className="linkedin-hint">{s.campaignName}</span>
            <span className="linkedin-hint">prieš {s.daysSince} d.</span>
            <button
              type="button"
              disabled={withdrawingKeys.has(s.leadId)}
              onClick={() => void handleWithdraw(s.leadId, label)}
            >
              {withdrawingKeys.has(s.leadId) ? 'Atšaukiama…' : '✕ Atšaukti kvietimą'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
