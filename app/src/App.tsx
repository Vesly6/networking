import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTableStore } from './store/useTableStore';
import { useWorkspaceStore } from './store/useWorkspaceStore';
import { useAuthStore } from './store/useAuthStore';
import { usePendingPhoneSearchStore } from './store/usePendingPhoneSearchStore';
import { TableView } from './components/Table/TableView';
import { CalendarView } from './components/Calendar/CalendarView';
import { WorkspaceView } from './components/Workspace/WorkspaceView';
import { CallsView } from './components/Calls/CallsView';
import { SearchView } from './components/Search/SearchView';
import { LinkedInView } from './components/LinkedIn/LinkedInView';
import { InstantlyView } from './components/Instantly/InstantlyView';
import { EmailGeneratorView } from './components/Email/EmailGeneratorView';
import { LessonsView } from './components/Lessons/LessonsView';
import { IncomingCallBanner } from './components/IncomingCallBanner';
import { Toast } from './components/Toast';
import { ConfirmDialog } from './components/ConfirmDialog';
import { Softphone } from './components/Softphone';
import { ThemeToggle } from './components/ThemeToggle';
import { SheetTabs } from './components/SheetTabs';
import { LoginScreen } from './components/LoginScreen';
import { BrandLogo } from './components/BrandLogo';
import { getNextActionColumn } from './utils/row';
import { isOverdue, isDueToday } from './utils/date';
import './App.css';

type Tab = 'table' | 'calendar' | 'calls' | 'search' | 'linkedin' | 'instantly' | 'email' | 'lessons';

function App() {
  const token = useAuthStore((s) => s.token);
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
  // Mobile only (see .app-tabs's collapsed state in App.css) — the tab
  // list + logout button used to just overflow the header sideways on a
  // phone-width screen (5 tabs + brand + title + logout all in one
  // unwrapping flex row). Below the mobile breakpoint they move into a
  // dropdown behind a ☰ toggle instead; above it this state is simply
  // never read (the CSS shows .app-tabs unconditionally on desktop).
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

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
  //
  // Keyed on `token`, not just "ran once ever" — a real, live-reproduced
  // bug found once the login gate started actually being enforced
  // locally too (see useWorkspaceStore's initError work): this effect's
  // hooks all run on the very first render, before the `if (!token)
  // return <LoginScreen />` branch below even exists yet — so the very
  // first initWorkspace() call always fired pre-login, with no token,
  // got a 401, and (thanks to the initError handling) surfaced "Nepavyko
  // pasiekti serverio" instead of hanging — but a plain "ran once" guard
  // then never retried after a *successful* login, leaving the user
  // stuck on that error screen with no path forward but a manual retry
  // click. Tracking the token value each init actually ran for — and
  // re-running when it changes — fixes this while still collapsing
  // StrictMode's duplicate call at the *same* token value.
  const initedForTokenRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (initedForTokenRef.current === token) return;
    initedForTokenRef.current = token;
    void initWorkspace();
  }, [token, initWorkspace]);

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
  const pendingPhoneCount = usePendingPhoneSearchStore((s) => s.count);

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
  // the login form appears on a fresh visit.
  //
  // Local dev used to skip this entirely (`&& !import.meta.env.DEV`) for
  // convenience — removed on request: the local server is reachable from
  // the whole wifi network (HOST=0.0.0.0, needed for phone access), so
  // "no password on localhost" really meant "no password for anyone on
  // the same wifi," not just this one Mac. requireAuth's matching
  // AUTH_DISABLED bypass (server/src/auth.ts) was turned off the same way
  // — see server/.env's own comment on it. Both need to change together;
  // re-enabling just one half leaves either a login screen that can't
  // actually reach the API, or an API that's reachable without ever
  // logging in.
  if (!token) {
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
      <IncomingCallBanner onJumpToRow={handleJumpToRow} onJumpToContact={handleJumpToContact} />
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
            {pendingPhoneCount > 0 && (
              <span
                className="pending-phone-search-badge"
                title={`Fone ieškoma ${pendingPhoneCount} telefono ${pendingPhoneCount === 1 ? 'numerio' : 'numerių'} (Apollo) — galite tęsti darbą, jums pranešime, kai bus rasta`}
              >
                🕐 {pendingPhoneCount}
              </span>
            )}
            <ThemeToggle />
            <button
              type="button"
              className="mobile-nav-toggle"
              aria-label="Meniu"
              onClick={() => setMobileNavOpen((v) => !v)}
            >
              ☰
              {(dueBadge.overdue > 0 || dueBadge.today > 0) && (
                <span className={`tab-badge ${dueBadge.overdue > 0 ? 'tab-badge-overdue' : ''}`}>
                  {dueBadge.overdue + dueBadge.today}
                </span>
              )}
            </button>
            <nav className={`app-tabs ${mobileNavOpen ? 'app-tabs-open' : ''}`}>
              <button
                type="button"
                className={tab === 'table' ? 'active' : ''}
                onClick={() => {
                  setTab('table');
                  setMobileNavOpen(false);
                }}
              >
                Lentelė
              </button>
              <button
                type="button"
                className={tab === 'calendar' ? 'active' : ''}
                onClick={() => {
                  setTab('calendar');
                  setMobileNavOpen(false);
                }}
              >
                Kalendorius
                {(dueBadge.overdue > 0 || dueBadge.today > 0) && (
                  <span className={`tab-badge ${dueBadge.overdue > 0 ? 'tab-badge-overdue' : ''}`}>
                    {dueBadge.overdue + dueBadge.today}
                  </span>
                )}
              </button>
              <button
                type="button"
                className={tab === 'calls' ? 'active' : ''}
                onClick={() => {
                  setTab('calls');
                  setMobileNavOpen(false);
                }}
              >
                Skambučiai
              </button>
              <button
                type="button"
                className={tab === 'search' ? 'active' : ''}
                onClick={() => {
                  setTab('search');
                  setMobileNavOpen(false);
                }}
              >
                Paieška
              </button>
              <button
                type="button"
                className={tab === 'linkedin' ? 'active' : ''}
                onClick={() => {
                  setTab('linkedin');
                  setMobileNavOpen(false);
                }}
              >
                LinkedIn
              </button>
              <button
                type="button"
                className={tab === 'instantly' ? 'active' : ''}
                onClick={() => {
                  setTab('instantly');
                  setMobileNavOpen(false);
                }}
              >
                Paštas
              </button>
              <button
                type="button"
                className={tab === 'email' ? 'active' : ''}
                onClick={() => {
                  setTab('email');
                  setMobileNavOpen(false);
                }}
              >
                DI
              </button>
              <button
                type="button"
                className={tab === 'lessons' ? 'active' : ''}
                onClick={() => {
                  setTab('lessons');
                  setMobileNavOpen(false);
                }}
              >
                Pamokos
              </button>
            </nav>
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
            {/* Same reasoning as Search/LinkedIn above — not scoped to the
                active table, so no tableReady gate or activeTableId key. */}
            <div className={`tab-panel ${tab === 'instantly' ? 'tab-panel-active' : ''}`}>
              <InstantlyView active={tab === 'instantly'} />
            </div>
            {/* Same reasoning as Search/LinkedIn above — not scoped to the
                active table, so no tableReady gate or activeTableId key. */}
            <div className={`tab-panel ${tab === 'email' ? 'tab-panel-active' : ''}`}>
              <EmailGeneratorView />
            </div>
            {/* Same reasoning as Search/LinkedIn/Instantly above — static
                reference content, not scoped to the active table. */}
            <div className={`tab-panel ${tab === 'lessons' ? 'tab-panel-active' : ''}`}>
              <LessonsView />
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
