import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTableStore } from './store/useTableStore';
import { useWorkspaceStore } from './store/useWorkspaceStore';
import { useAuthStore } from './store/useAuthStore';
import { TableView } from './components/Table/TableView';
import { CalendarView } from './components/Calendar/CalendarView';
import { WorkspaceView } from './components/Workspace/WorkspaceView';
import { CallsView } from './components/Calls/CallsView';
import { Toast } from './components/Toast';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Softphone } from './components/Softphone';
import { SheetTabs } from './components/SheetTabs';
import { LoginScreen } from './components/LoginScreen';
import { BrandLogo } from './components/BrandLogo';
import { getNextActionColumn } from './utils/row';
import { isOverdue, isDueToday } from './utils/date';
import './App.css';

type Tab = 'table' | 'calendar' | 'calls';

function App() {
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);
  const loggedInViaRecovery = useAuthStore((s) => s.loggedInViaRecovery);
  const dismissRecoveryNotice = useAuthStore((s) => s.dismissRecoveryNotice);

  const workspaceReady = useWorkspaceStore((s) => s.ready);
  const initWorkspace = useWorkspaceStore((s) => s.init);
  const tables = useWorkspaceStore((s) => s.tables);
  const activeTableId = useWorkspaceStore((s) => s.activeTableId);
  const setActiveTable = useWorkspaceStore((s) => s.setActiveTable);
  const renameTable = useWorkspaceStore((s) => s.renameTable);

  const tableReady = useTableStore((s) => s.ready);
  const loadTable = useTableStore((s) => s.loadTable);
  const unload = useTableStore((s) => s.unload);
  const columns = useTableStore((s) => s.columns);
  const rows = useTableStore((s) => s.rows);

  const [tab, setTab] = useState<Tab>('table');
  const [focusRowId, setFocusRowId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  useEffect(() => {
    void initWorkspace();
  }, [initWorkspace]);

  // Only the id drives loading — the table's name/columns are always fetched
  // fresh from IndexedDB inside loadTable(), never trusted from this cached
  // `tables` list, so edits made in useTableStore can never appear to "revert"
  // when leaving and re-entering a table.
  useEffect(() => {
    if (activeTableId) {
      void loadTable(activeTableId);
      setTab('table');
    } else {
      unload();
    }
  }, [activeTableId, loadTable, unload]);

  const activeTable = useMemo(() => tables.find((t) => t.id === activeTableId) ?? null, [tables, activeTableId]);

  const dueBadge = useMemo(() => {
    const dateColumn = getNextActionColumn(columns);
    if (!dateColumn) return { overdue: 0, today: 0 };
    let overdue = 0;
    let today = 0;
    for (const row of rows) {
      const date = row.cells[dateColumn.id];
      if (!date) continue;
      if (isOverdue(date)) overdue++;
      else if (isDueToday(date)) today++;
    }
    return { overdue, today };
  }, [columns, rows]);

  const handleJumpToRow = useCallback((rowId: string) => {
    setTab('table');
    setFocusRowId(rowId);
  }, []);

  // Gated before workspace loading even starts — nothing in this app is
  // meant to be reachable without logging in first, and checking here
  // (rather than after workspaceReady) avoids a flash of "Loading…" before
  // the login form appears on a fresh visit. import.meta.env.DEV is
  // statically false in any production build (vite build), so this can't
  // be flipped by a Render env var or anything else at the deployed
  // app.serteo.lt — the skip only exists in the actual `vite dev` process.
  // requireAuth's own AUTH_DISABLED bypass (server/src/auth.ts) is the
  // matching local-only relaxation for the backend side of the gate.
  if (!token && !import.meta.env.DEV) {
    return <LoginScreen />;
  }

  if (!workspaceReady) {
    return (
      <div className="app-loading">
        <span>Loading…</span>
      </div>
    );
  }

  return (
    <>
      {/* Rendered once, at this fixed position, regardless of which branch
          below is active — React keeps the same Softphone instance alive
          across Workspace ↔ Table navigation this way (same component type
          at the same tree position isn't remounted), instead of tearing
          down and reconnecting the widget (burning a fresh 72h key) every
          time you go back to the workspace list and open a table again. */}
      <Softphone />
      <ConfirmDialog />
      {loggedInViaRecovery && (
        <div className="recovery-banner">
          Logged in with your recovery password — update your main password in Render's dashboard (AUTH_PASSWORD) when
          you get a chance.
          <button type="button" onClick={dismissRecoveryNotice}>
            Dismiss
          </button>
        </div>
      )}
      {!activeTable ? (
        <div className="app">
          <WorkspaceView onOpenTable={setActiveTable} />
          <Toast />
        </div>
      ) : (
        <div className="app">
          <header className="app-header">
            <div className="brand">
              <BrandLogo />
            </div>
            <button type="button" className="back-to-workspace" onClick={() => setActiveTable(null)}>
              ← Workspace
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
            <nav className="app-tabs">
              <button type="button" className={tab === 'table' ? 'active' : ''} onClick={() => setTab('table')}>
                Table
              </button>
              <button
                type="button"
                className={tab === 'calendar' ? 'active' : ''}
                onClick={() => setTab('calendar')}
              >
                Calendar
                {(dueBadge.overdue > 0 || dueBadge.today > 0) && (
                  <span className={`tab-badge ${dueBadge.overdue > 0 ? 'tab-badge-overdue' : ''}`}>
                    {dueBadge.overdue + dueBadge.today}
                  </span>
                )}
              </button>
              <button type="button" className={tab === 'calls' ? 'active' : ''} onClick={() => setTab('calls')}>
                Calls
              </button>
            </nav>
            <button type="button" className="logout-btn" onClick={logout}>
              Log out
            </button>
          </header>

          <main className="app-main">
            {tab === 'calls' ? (
              <CallsView onJumpToRow={handleJumpToRow} />
            ) : !tableReady ? (
              <div className="app-loading">
                <span>Loading…</span>
              </div>
            ) : tab === 'table' ? (
              <TableView focusRowId={focusRowId} onFocusHandled={() => setFocusRowId(null)} />
            ) : (
              <CalendarView onJumpToRow={handleJumpToRow} />
            )}
          </main>

          <SheetTabs />
          <Toast />
        </div>
      )}
    </>
  );
}

export default App;
