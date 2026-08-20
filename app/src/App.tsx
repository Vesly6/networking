import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTableStore } from './store/useTableStore';
import { useWorkspaceStore } from './store/useWorkspaceStore';
import { useAuthStore } from './store/useAuthStore';
import { TableView } from './components/Table/TableView';
import { CalendarView } from './components/Calendar/CalendarView';
import { WorkspaceView } from './components/Workspace/WorkspaceView';
import { CallsView } from './components/Calls/CallsView';
import { SearchView } from './components/Search/SearchView';
import { LinkedInView } from './components/LinkedIn/LinkedInView';
import { Toast } from './components/Toast';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Softphone } from './components/Softphone';
import { SheetTabs } from './components/SheetTabs';
import { LoginScreen } from './components/LoginScreen';
import { BrandLogo } from './components/BrandLogo';
import { getNextActionColumn } from './utils/row';
import { isOverdue, isDueToday } from './utils/date';
import './App.css';

type Tab = 'table' | 'calendar' | 'calls' | 'search' | 'linkedin';

function App() {
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);
  const loggedInViaRecovery = useAuthStore((s) => s.loggedInViaRecovery);
  const dismissRecoveryNotice = useAuthStore((s) => s.dismissRecoveryNotice);

  const workspaceReady = useWorkspaceStore((s) => s.ready);
  const workspaceInitError = useWorkspaceStore((s) => s.initError);
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
  const [focusContact, setFocusContact] = useState<{ rowId: string; columnId: string; contactId: string } | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');

  // Guards against React StrictMode's dev-only mount→cleanup→mount
  // double-invoke — without it, two overlapping initWorkspace() calls
  // could both see zero tables (the first call's saveTable() for the
  // auto-created "Table 1" hadn't landed yet when the second one checked)
  // and each create their own "Table 1", leaving two duplicate tables
  // after the very first load in dev. Reproduced directly: a real page
  // reload against the Vite dev server left two "Table 1" sheet tabs;
  // the same reload against a production build (no double-invoke) never
  // did. Same fix CallsView already uses for its own StrictMode-only
  // double-fire (hasAutoLoadedRef) — a ref survives the simulated
  // unmount, so it only suppresses the fake double-call, not a genuine
  // remount later.
  const hasInitedWorkspaceRef = useRef(false);
  useEffect(() => {
    if (hasInitedWorkspaceRef.current) return;
    hasInitedWorkspaceRef.current = true;
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

  const handleJumpToContact = useCallback((rowId: string, columnId: string, contactId: string) => {
    setTab('table');
    setFocusContact({ rowId, columnId, contactId });
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

  // Table/row data moved from client-only IndexedDB to a server-backed
  // store (see CLAUDE.md's Persistence section) — that made server/
  // load-bearing for the entire app, not just the Calls tab as before, so
  // a server-down/unreachable scenario needs its own explicit, actionable
  // error here rather than leaving the user on an infinite "Kraunama…"
  // spinner with no explanation (which is what happened before this
  // branch existed — initWorkspace() throwing left workspaceReady stuck
  // at false forever with zero user-facing signal).
  if (workspaceInitError) {
    return (
      <div className="app-loading app-loading-error">
        <span>{workspaceInitError}</span>
        <button type="button" onClick={() => void initWorkspace()}>
          Bandyti dar kartą
        </button>
      </div>
    );
  }

  if (!workspaceReady) {
    return (
      <div className="app-loading">
        <span>Kraunama…</span>
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
          Prisijungėte naudodami atkūrimo slaptažodį — kai turėsite laiko, atnaujinkite pagrindinį slaptažodį Render
          valdymo skyde (AUTH_PASSWORD).
          <button type="button" onClick={dismissRecoveryNotice}>
            Atmesti
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
              ← Darbo sritis
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
                title="Spustelėkite, kad pervadintumėte"
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
                Lentelė
              </button>
              <button
                type="button"
                className={tab === 'calendar' ? 'active' : ''}
                onClick={() => setTab('calendar')}
              >
                Kalendorius
                {(dueBadge.overdue > 0 || dueBadge.today > 0) && (
                  <span className={`tab-badge ${dueBadge.overdue > 0 ? 'tab-badge-overdue' : ''}`}>
                    {dueBadge.overdue + dueBadge.today}
                  </span>
                )}
              </button>
              <button type="button" className={tab === 'calls' ? 'active' : ''} onClick={() => setTab('calls')}>
                Skambučiai
              </button>
              <button type="button" className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>
                Paieška
              </button>
              <button type="button" className={tab === 'linkedin' ? 'active' : ''} onClick={() => setTab('linkedin')}>
                LinkedIn
              </button>
            </nav>
            <button type="button" className="logout-btn" onClick={logout}>
              Atsijungti
            </button>
          </header>

          <main className="app-main tab-panel-container">
            {/* Table/Calendar/Calls all stay mounted across tab switches —
                hidden via `visibility` (not display:none, and not
                unmounting) — so search/sort/scroll position/selection
                survive a trip to another tab and back. This used to fully
                reset on every switch, since the old ternary here unmounted
                whichever view wasn't active.

                `display: none` was tried first and rejected: it makes the
                hidden panel report zero size, and TableView's virtualizer
                (@tanstack/react-virtual) watches the scroll container's
                size via ResizeObserver — the zero-size blip resets its
                internal scroll-offset tracking, so the table silently
                snapped back to the top on every return trip even though
                the DOM's own scrollTop would have restored correctly on
                its own. Absolute-positioning every panel to fill this
                container, toggling only `visibility`, keeps each panel's
                real layout size intact the entire time, so the
                virtualizer never sees that zero-size event in the first
                place.

                `key={activeTableId}` still forces a clean remount of
                Table/Calendar when the *table* itself changes (switching
                tables already resets the tab to 'table' — see the
                activeTableId effect above — and a search/filter left over
                from a different table would otherwise silently hide rows
                in the new one, which is worse than not persisting at
                all). Calls has no such key: it isn't scoped to a table. */}
            <div className={`tab-panel ${tab === 'calls' ? 'tab-panel-active' : ''}`}>
              <CallsView onJumpToRow={handleJumpToRow} onJumpToContact={handleJumpToContact} />
            </div>
            {/* Not gated on tableReady/keyed by activeTableId like Table/
                Calendar — SearchView's own state (useSearchStore) has
                nothing to do with which table is active; it only reads
                useTableStore live, at the moment "Add to table" is
                actually clicked (see utils/addApolloToTable.ts), so
                switching tables while search results are on screen just
                means the next "Add to table" click lands in the newly
                active table — no stale-state risk to guard against. */}
            <div className={`tab-panel ${tab === 'search' ? 'tab-panel-active' : ''}`}>
              <SearchView />
            </div>
            {/* Same reasoning as Search above — account-level, not scoped to
                the active table, so no tableReady gate or activeTableId
                key. */}
            <div className={`tab-panel ${tab === 'linkedin' ? 'tab-panel-active' : ''}`}>
              <LinkedInView />
            </div>
            <div className={`tab-panel ${tab === 'table' ? 'tab-panel-active' : ''}`}>
              {tableReady ? (
                <TableView
                  key={activeTableId}
                  focusRowId={focusRowId}
                  onFocusHandled={() => setFocusRowId(null)}
                  focusContact={focusContact}
                  onContactFocusHandled={() => setFocusContact(null)}
                />
              ) : (
                <div className="app-loading">
                  <span>Kraunama…</span>
                </div>
              )}
            </div>
            <div className={`tab-panel ${tab === 'calendar' ? 'tab-panel-active' : ''}`}>
              {tableReady ? (
                <CalendarView key={activeTableId} onJumpToRow={handleJumpToRow} />
              ) : (
                <div className="app-loading">
                  <span>Kraunama…</span>
                </div>
              )}
            </div>
          </main>

          <SheetTabs />
          <Toast />
        </div>
      )}
    </>
  );
}

export default App;
