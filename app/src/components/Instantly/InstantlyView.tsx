import { useEffect, useState } from 'react';
import { useInstantlyInboxStore } from '../../store/useInstantlyInboxStore';
import { AccountsPanel } from './AccountsPanel';
import { UniboxPanel } from './UniboxPanel';
import { AnalyticsPanel } from './AnalyticsPanel';

type SubTab = 'inbox' | 'accounts' | 'analytics';

interface InstantlyViewProps {
  /** Whether App.tsx's own top-level nav currently has this tab active —
   * this component stays mounted (CSS-hidden, not unmounted) whenever
   * some *other* top-level tab is showing, same convention as Table/
   * Calendar/Calls elsewhere in this app, so its own subTab state
   * otherwise just sits wherever it was left. Used only to reset back to
   * "Unibox" every time the user navigates *into* this tab (on explicit
   * request) — without watching this, switching to e.g. Analitika, then
   * away to another top-level tab and back, would silently reopen on
   * Analitika instead of defaulting back to Unibox. */
  active: boolean;
}

/** The Instantly tab's shell — cold-email mailboxes/Unibox/analytics,
 * proxied server-side through server/src/instantly.ts (the API key never
 * reaches the browser, same convention as every other external
 * integration in this app). Campaigns/Leads sub-tabs were removed on
 * request (Unibox already surfaces a campaign filter + editable lead
 * status inline, so a separate browse-everything view wasn't needed day
 * to day) — server/src/instantly.ts's own campaign wrappers stay in
 * place since Unibox's campaign filter and the interest-status pill
 * still call through them. */
export function InstantlyView({ active }: InstantlyViewProps) {
  const [subTab, setSubTab] = useState<SubTab>('inbox');
  const unreadCount = useInstantlyInboxStore((s) => s.unreadCount);
  const refreshUnreadCount = useInstantlyInboxStore((s) => s.refreshUnreadCount);

  useEffect(() => {
    void refreshUnreadCount();
  }, [refreshUnreadCount]);

  useEffect(() => {
    if (active) setSubTab('inbox');
  }, [active]);

  return (
    <div className="instantly-view">
      <div className="instantly-header">
        <h2>Paštas</h2>
      </div>

      <nav className="instantly-subnav">
        <button type="button" className={subTab === 'inbox' ? 'active' : ''} onClick={() => setSubTab('inbox')}>
          Unibox
          {unreadCount > 0 && <span className="instantly-subnav-badge">{unreadCount}</span>}
        </button>
        <button type="button" className={subTab === 'analytics' ? 'active' : ''} onClick={() => setSubTab('analytics')}>
          Analitika
        </button>
        <button type="button" className={subTab === 'accounts' ? 'active' : ''} onClick={() => setSubTab('accounts')}>
          Pašto dėžutės
        </button>
      </nav>

      {subTab === 'inbox' && <UniboxPanel />}
      {subTab === 'analytics' && <AnalyticsPanel />}
      {subTab === 'accounts' && <AccountsPanel />}
    </div>
  );
}
