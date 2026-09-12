import { useDemoTableStore } from './store/useDemoTableStore';
import { DemoTableView } from './components/DemoTableView';
import { DemoToast } from './components/DemoToast';
import { DemoConfirmDialog } from './components/DemoConfirmDialog';
import { DemoLogo } from './components/DemoLogo';
import { ThemeToggle } from './components/ThemeToggle';
import './App.css';

/** The demo's entire shell — no login screen, no route guard, no
 * workspace-load spinner: useDemoTableStore's seed data is already
 * synchronously available the instant this module runs (see that
 * store's own doc comment), so there is nothing to wait for. A visitor
 * gets a fully interactive table the moment the page paints.
 *
 * Layout deliberately mirrors production's own chrome — a header with
 * the real IRMS logo, and an Excel-style tab strip along the *bottom*
 * (production's SheetTabs) rather than a generic top nav — since the
 * whole point of this demo is that it should look like the real product
 * on first glance, not a bespoke mini-app. */
export default function App() {
  const tables = useDemoTableStore((s) => s.tables);
  const activeTableId = useDemoTableStore((s) => s.activeTableId);
  const setActiveTable = useDemoTableStore((s) => s.setActiveTable);
  const activeTable = tables.find((t) => t.id === activeTableId) ?? tables[0];

  return (
    <div className="demo-app">
      <header className="demo-header">
        <div className="demo-brand">
          <DemoLogo />
        </div>
        <ThemeToggle />
        <span className="demo-header-badge">Live Demo</span>
        {activeTable && <h1 className="demo-table-title">{activeTable.name}</h1>}
      </header>
      <main className="demo-main">{activeTable && <DemoTableView key={activeTable.id} table={activeTable} />}</main>
      <div className="demo-sheet-tabs-bar">
        <div className="demo-sheet-tabs">
          {tables.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`demo-sheet-tab ${t.id === activeTableId ? 'demo-sheet-tab-active' : ''}`}
              onClick={() => setActiveTable(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>
      <DemoToast />
      <DemoConfirmDialog />
    </div>
  );
}
