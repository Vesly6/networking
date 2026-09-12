import { useState } from 'react';
import { useDemoTableStore } from './store/useDemoTableStore';
import { DemoTableView } from './components/DemoTableView';
import { DemoCalendarView } from './components/DemoCalendarView';
import { DemoToast } from './components/DemoToast';
import { DemoConfirmDialog } from './components/DemoConfirmDialog';
import { DemoWorkspaceView } from './components/DemoWorkspaceView';
import { DemoAppTabs, type DemoTab } from './components/DemoAppTabs';
import { ThemeToggle } from './components/ThemeToggle';
import { BrandIcon } from './components/BrandIcon';
import { ArrowLeft } from 'lucide-react';
import './App.css';

type Screen = 'workspace' | 'table';

/** The demo's entire shell — no login screen, no route guard, no
 * workspace-load spinner: useDemoTableStore's seed data is already
 * synchronously available the instant this module runs (see that
 * store's own doc comment), so there is nothing to wait for.
 *
 * Two screens, mirroring production's own App.tsx/WorkspaceView.tsx
 * split: a Workspace home screen (table list, create/rename/delete) a
 * visitor lands on first — matching the real "I open the app and see my
 * tables" flow the parity audit flagged as entirely missing — and the
 * table screen itself, reached by opening a card. `screen` starts at
 * 'workspace' rather than dropping straight into a table, for the same
 * reason. */
export default function App() {
  const [screen, setScreen] = useState<Screen>('workspace');
  const tables = useDemoTableStore((s) => s.tables);
  const activeTableId = useDemoTableStore((s) => s.activeTableId);
  const setActiveTable = useDemoTableStore((s) => s.setActiveTable);
  const renameTable = useDemoTableStore((s) => s.renameTable);
  const activeTable = tables.find((t) => t.id === activeTableId);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [tab, setTab] = useState<DemoTab>('table');
  const [focusRowId, setFocusRowId] = useState<string | null>(null);

  const openTable = (id: string) => {
    setActiveTable(id);
    setScreen('table');
    setTab('table');
  };

  const jumpToRow = (rowId: string) => {
    setTab('table');
    setFocusRowId(rowId);
  };

  if (screen === 'workspace' || !activeTable) {
    return (
      <div className="demo-app">
        <DemoWorkspaceView onOpenTable={openTable} />
        <DemoToast />
        <DemoConfirmDialog />
      </div>
    );
  }

  return (
    <div className="demo-app">
      <header className="demo-header">
        <div className="demo-brand">
          <BrandIcon />
        </div>
        <button type="button" className="back-to-workspace" onClick={() => setScreen('workspace')}>
          <ArrowLeft size={16} /> Workspace
        </button>
        {editingTitle ? (
          <input
            autoFocus
            className="table-title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              renameTable(activeTable.id, titleDraft);
              setEditingTitle(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditingTitle(false);
            }}
          />
        ) : (
          <h1
            className="table-title"
            title="Click to rename"
            onClick={() => {
              setTitleDraft(activeTable.name);
              setEditingTitle(true);
            }}
          >
            {activeTable.name}
          </h1>
        )}
        <span className="demo-header-badge">Live Demo</span>
        <ThemeToggle />
        <DemoAppTabs tab={tab} onSelectTab={setTab} />
      </header>
      <main className="demo-main">
        {tab === 'calendar' ? (
          <DemoCalendarView table={activeTable} onJumpToRow={jumpToRow} />
        ) : (
          <DemoTableView key={activeTable.id} table={activeTable} focusRowId={focusRowId} onFocusHandled={() => setFocusRowId(null)} />
        )}
      </main>
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
