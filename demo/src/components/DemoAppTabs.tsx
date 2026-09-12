import { useToastStore } from '../store/useToastStore';

export type DemoTab = 'table' | 'calendar';

// The remaining real production tabs, each dimmed and toast-only here —
// none of them can exist in a credential-free demo (Calls/Search/
// LinkedIn/Paštas/DI each need a real third-party key or a logged-in
// browser session). Shown anyway, matching production's own real
// behavior for an *unconfigured* integration on a live company (a
// dimmed tab + toast, never navigating) — see the parity audit's
// finding on this exact interaction. This is what makes the demo's nav
// bar read as the real product's full shape at a glance, rather than a
// single-purpose spreadsheet with no other tabs at all.
const UNCONFIGURED_TABS = ['Calls', 'Search', 'LinkedIn', 'Inbox', 'AI Writer'];

interface DemoAppTabsProps {
  tab: DemoTab;
  onSelectTab: (tab: DemoTab) => void;
}

/** The in-table nav bar — copied from production's own .app-tabs
 * structure. "Table" and "Calendar" are the two real, navigable tabs in
 * this demo. */
export function DemoAppTabs({ tab, onSelectTab }: DemoAppTabsProps) {
  const showToast = useToastStore((s) => s.show);

  return (
    <nav className="app-tabs">
      <button type="button" className={tab === 'table' ? 'active' : ''} onClick={() => onSelectTab('table')}>
        Table
      </button>
      <button type="button" className={tab === 'calendar' ? 'active' : ''} onClick={() => onSelectTab('calendar')}>
        Calendar
      </button>
      {UNCONFIGURED_TABS.map((label) => (
        <button
          key={label}
          type="button"
          className="nav-tab-unconfigured"
          title="Not configured for this demo"
          onClick={() => showToast('This integration isn’t configured — available in the full product')}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
