import { useDemoTableStore } from './store/useDemoTableStore';
import { DemoTableView } from './components/DemoTableView';
import './App.css';

/** The demo's entire shell — no login screen, no route guard, no
 * workspace-load spinner: useDemoTableStore's seed data is already
 * synchronously available the instant this module runs (see that
 * store's own doc comment), so there is nothing to wait for. A visitor
 * gets a fully interactive table the moment the page paints. */
export default function App() {
  const tables = useDemoTableStore((s) => s.tables);
  const activeTableId = useDemoTableStore((s) => s.activeTableId);
  const setActiveTable = useDemoTableStore((s) => s.setActiveTable);
  const activeTable = tables.find((t) => t.id === activeTableId) ?? tables[0];

  return (
    <div className="demo-app">
      <header className="demo-header">
        <span className="demo-header-title">IRMS</span>
        <span className="demo-header-badge">Live Demo</span>
        <nav className="demo-tabs">
          {tables.map((t) => (
            <button
              key={t.id}
              type="button"
              className={t.id === activeTableId ? 'active' : ''}
              onClick={() => setActiveTable(t.id)}
            >
              {t.name}
            </button>
          ))}
        </nav>
      </header>
      <main className="demo-main">{activeTable && <DemoTableView key={activeTable.id} table={activeTable} />}</main>
    </div>
  );
}
