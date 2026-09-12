import { useToastStore } from '../store/useToastStore';

// The other 7 real production tabs, each dimmed and toast-only here —
// none of them can exist in a credential-free demo (Calendar reads a
// column flag this demo's grid doesn't expose yet; Calls/Search/
// LinkedIn/Paštas/DI each need a real third-party key or a logged-in
// browser session). Shown anyway, matching production's own real
// behavior for an *unconfigured* integration on a live company (a
// dimmed tab + toast, never navigating) — see the parity audit's
// finding on this exact interaction. This is what makes the demo's nav
// bar read as the real product's full shape at a glance, rather than a
// single-purpose spreadsheet with no other tabs at all.
const UNCONFIGURED_TABS = ['Calendar', 'Calls', 'Search', 'LinkedIn', 'Inbox', 'AI Writer'];

/** The in-table nav bar — copied from production's own .app-tabs
 * structure. "Table" is the only real, navigable tab in this demo. */
export function DemoAppTabs() {
  const showToast = useToastStore((s) => s.show);

  return (
    <nav className="app-tabs">
      <button type="button" className="active">
        Table
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
