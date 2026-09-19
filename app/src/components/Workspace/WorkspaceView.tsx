import { useEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useTableStore } from '../../store/useTableStore';
import { useAuthStore } from '../../store/useAuthStore';
import { useWorkersStore } from '../../store/useWorkersStore';
import { confirmDeleteTable } from '../../utils/confirmDeleteTable';
import { countRowsForTable } from '../../db/db';
import { BrandLogo } from '../BrandLogo';
import { IrmsLogo } from '../IrmsLogo';
import { ThemeToggle } from '../ThemeToggle';
import { ImportHistoryModal } from './ImportHistoryModal';
import { Popover } from '../Popover';
import { Package, Users } from 'lucide-react';
import { ActivityDashboard } from '../Dashboard/ActivityDashboard';
import { can } from '../../utils/permissions';

interface WorkspaceViewProps {
  onOpenTable: (id: string) => void;
  /** Threaded from App.tsx — "Darbuotojai" is only reachable from this
   * screen (moved out of the in-table nav — see AppScreen's own doc
   * comment in App.tsx for the layout bug that motivated this: the screen
   * used to render underneath SheetTabs' fixed bottom bar, which visually
   * overlapped its own scrolled content). Omitted entirely for workers
   * (see canManageTables below — same role gate) and whenever the
   * super-admin has hidden the 'workers' feature for this company. There
   * is no self-service "API raktai" entry point anymore at all — every
   * company's keys are managed exclusively through the independent
   * /supersuperadmin dashboard now. */
  onOpenWorkers?: () => void;
  /** "Naujienos" — unlike Workers this isn't an admin-only
   * screen (no secrets, nothing to manage that affects other users), so
   * it's shown to every user including workers whenever the company has
   * it configured (App.tsx gates the prop itself on
   * enabledFeatures.includes('news'), not on role). Lives on this screen
   * rather than as an in-table tab per explicit request — it's not scoped
   * to any particular table. */
  onOpenNews?: () => void;
  /** "Pamokos" — unlike News this one still also lives as its own in-table
   * tab (App.tsx's `allowedTabs.has('lessons')`, unchanged); this is a
   * second, additional entry point on the Workspace screen itself, added
   * per explicit request so it's reachable without first opening a table.
   * Gated by the exact same `allowedTabs.has('lessons')` check as the
   * in-table tab (not the broader "every role" rule News uses), so a
   * worker whose visibleTabs excludes lessons doesn't gain access to it
   * just because this second entry point exists. */
  onOpenLessons?: () => void;
  /** A company's own view of their flagged tables' daily backups
   * (OwnBackupsView) — same role gate as onOpenWorkers (canManageTables:
   * not a worker), since deciding what gets backed up/restored is
   * workspace-level management, not a per-table content edit. */
  onOpenBackups?: () => void;
  /** A company's own view of "Integracijos" (company-wide API keys,
   * Shared/Individual mode, per-worker key assignment) — same role gate as
   * onOpenWorkers/onOpenBackups (canManageTables: not a worker), plus
   * App.tsx additionally requires the api_keys.view registry permission
   * and the platform-admin-toggleable 'integrations' Funkcijos flag,
   * mirroring exactly how onOpenWorkers/onOpenBackups are gated. */
  onOpenIntegrations?: () => void;
}

export function WorkspaceView({
  onOpenTable,
  onOpenWorkers,
  onOpenNews,
  onOpenLessons,
  onOpenBackups,
  onOpenIntegrations,
}: WorkspaceViewProps) {
  const tables = useWorkspaceStore((s) => s.tables);
  const preloadTable = useTableStore((s) => s.preloadTable);
  const createTable = useWorkspaceStore((s) => s.createTable);
  const renameTable = useWorkspaceStore((s) => s.renameTable);
  const deleteTable = useWorkspaceStore((s) => s.deleteTable);
  const setTableBackupFlag = useWorkspaceStore((s) => s.setTableBackupFlag);
  const setTableOwners = useWorkspaceStore((s) => s.setTableOwners);
  const logout = useAuthStore((s) => s.logout);
  const currentUser = useAuthStore((s) => s.user);
  // A real, reported gap: this screen never checked role/permissions at
  // all, so a worker saw and could use every table's own +Nauja lentelė/
  // Pervadinti/Ištrinti controls — including tables that have nothing to
  // do with whatever they're actually scoped to via visibleTabs (that
  // setting only restricts which sub-tabs are visible *inside* a table
  // already open, never which tables appear in this list, or whether new
  // ones can be created, at all). Workspace/company-level table management
  // — create, rename, duplicate (SheetTabs.tsx has that third one), delete
  // — is a hard block for every worker on explicit request, not a
  // togglable permission (same requireNotWorker gate server/src/index.ts
  // now uses on all four routes) — a worker having can_delete_rows for
  // ordinary row cleanup inside a table they're scoped to shouldn't also
  // mean they can make the whole table disappear.
  const canManageTables = currentUser?.role !== 'worker';

  // Needed for the per-table owner picker below (admin-only) — a worker
  // never sees this screen's management controls at all, so there's
  // nothing to load in that case.
  const workers = useWorkersStore((s) => s.workers);
  const loadWorkers = useWorkersStore((s) => s.load);
  useEffect(() => {
    if (canManageTables) void loadWorkers();
  }, [canManageTables, loadWorkers]);

  const [rowCounts, setRowCounts] = useState<Record<string, number>>({});
  /** Which table ids already have a known row count — see the effect
   * below for why this exists. */
  const knownRowCountIdsRef = useRef<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [importHistoryOpen, setImportHistoryOpen] = useState(false);
  // Which table's "who can see this" checkbox popover is open — at most
  // one at a time, same pattern as editingId above. The super_admin
  // themself is never a checkbox here: they already see every table
  // regardless of this list (tableAccessibleToRequest's own real-admin
  // bypass), so there's nothing for a checkbox on their own name to do.
  const [ownerPopoverTableId, setOwnerPopoverTableId] = useState<string | null>(null);
  const [ownerPopoverAnchor, setOwnerPopoverAnchor] = useState<HTMLElement | null>(null);

  // A real, measured bug (this session's own performance audit): this
  // used to fire one request PER table, all at once, every time `tables`
  // got a new array reference (any workspace store update at all, not
  // just a table actually being added) — with a real 18-table workspace,
  // that's 18 simultaneous connections competing for the same origin's
  // connection pool as whatever the user clicks next (opening a table),
  // measurably delaying it. Fixed two ways: (1) only ever fetches a given
  // table's count once (knownRowCountIdsRef), not on every unrelated
  // `tables` change — a row count going a little stale after add/delete
  // elsewhere is an acceptable tradeoff for a number that's purely
  // informational on the card; (2) a small fixed-concurrency worker pool
  // (same pattern this app already uses for Apollo/Zadarma batch work)
  // instead of firing everything at once.
  useEffect(() => {
    let cancelled = false;
    const pending = tables.filter((t) => !knownRowCountIdsRef.current.has(t.id));
    if (pending.length === 0) return;
    const ROW_COUNT_CONCURRENCY = 4;
    let index = 0;
    const worker = async () => {
      while (!cancelled && index < pending.length) {
        const table = pending[index++];
        try {
          const count = await countRowsForTable(table.id);
          knownRowCountIdsRef.current.add(table.id);
          if (!cancelled) setRowCounts((prev) => ({ ...prev, [table.id]: count }));
        } catch {
          // Leave it unknown — the card just keeps showing "…" for this
          // one table rather than failing the whole batch.
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(ROW_COUNT_CONCURRENCY, pending.length) }, worker));
    return () => {
      cancelled = true;
    };
  }, [tables]);

  // Closes the owner popover on any click outside it — this screen has no
  // existing shared "click anywhere closes popovers" container the way
  // TableView.tsx does, so this is scoped narrowly by class name (works
  // regardless of the popover's own portaled DOM position — see
  // Popover.tsx's own doc comment on why it portals to document.body).
  useEffect(() => {
    if (!ownerPopoverTableId) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('.table-card-owner-trigger') || target.closest('.table-card-owner-popover-list')) return;
      setOwnerPopoverTableId(null);
      setOwnerPopoverAnchor(null);
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    return () => document.removeEventListener('mousedown', handleDocMouseDown);
  }, [ownerPopoverTableId]);

  const accessSummaryLabel = (count: number): string => {
    if (count === 0) return 'Niekas';
    if (count === 1) return '1 darbuotojas';
    return `${count} darbuotojai`;
  };

  const handleCreate = async () => {
    const id = await createTable(`Lentelė ${tables.length + 1}`);
    if (id) onOpenTable(id);
  };

  const handleDeleteTable = async (id: string, name: string) => {
    if (await confirmDeleteTable(name, rowCounts[id] ?? 0)) deleteTable(id);
  };

  return (
    <div className="workspace-view">
      <div className="workspace-header">
        <div className="brand">
          <BrandLogo />
          <IrmsLogo />
        </div>
        <div className="workspace-header-actions">
          <ThemeToggle />
          {canManageTables && onOpenWorkers && (
            <button type="button" onClick={onOpenWorkers}>
              Darbuotojai
            </button>
          )}
          {onOpenNews && (
            <button type="button" onClick={onOpenNews}>
              Naujienos
            </button>
          )}
          {onOpenLessons && (
            <button type="button" onClick={onOpenLessons}>
              Pamokos
            </button>
          )}
          {onOpenBackups && (
            <button type="button" onClick={onOpenBackups}>
              Duomenys
            </button>
          )}
          {onOpenIntegrations && (
            <button type="button" onClick={onOpenIntegrations}>
              Integracijos
            </button>
          )}
          {canManageTables && (
            <button type="button" onClick={() => setImportHistoryOpen(true)}>
              Importų istorija
            </button>
          )}
          {canManageTables && (
            <button type="button" className="primary" onClick={handleCreate}>
              + Nauja lentelė
            </button>
          )}
          <button type="button" onClick={logout}>
            Atsijungti
          </button>
        </div>
      </div>

      {can(currentUser?.permissionKeys, 'dashboard.view_own') && <ActivityDashboard />}

      {tables.length === 0 ? (
        <div className="empty-state">Kol kas nėra lentelių — sukurkite pirmąją.</div>
      ) : (
        <div className="table-cards">
          {tables.map((t) => (
            <div
              key={t.id}
              className="table-card"
              onClick={() => editingId !== t.id && onOpenTable(t.id)}
              // Hovering a card before clicking it is the normal path to
              // opening a table — by the time the click actually lands,
              // the data is often already on its way (or already
              // cached), which is most of this session's measured
              // 2.5–3s "click → first row visible" cost paid ahead of
              // time instead of at the moment the user is waiting on it.
              onMouseEnter={() => preloadTable(t.id)}
            >
              {editingId === t.id ? (
                <input
                  autoFocus
                  className="table-card-name-input"
                  value={editingName}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={() => {
                    renameTable(t.id, editingName);
                    setEditingId(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setEditingId(null);
                  }}
                />
              ) : (
                <div className="table-card-name">{t.name}</div>
              )}
              <div className="table-card-meta">Eilučių: {rowCounts[t.id] ?? '…'}</div>
              {canManageTables && (
                <div className="table-card-actions">
                  <button
                    type="button"
                    className={`table-card-backup-toggle ${t.dailyBackupEnabled ? 'active' : ''}`}
                    title={t.dailyBackupEnabled ? 'Kasdienė kopija įjungta — spauskite, kad išjungtumėte' : 'Įjungti kasdienę kopiją'}
                    onClick={(e) => {
                      e.stopPropagation();
                      setTableBackupFlag(t.id, !t.dailyBackupEnabled);
                    }}
                  >
                    <Package className="icon" size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingId(t.id);
                      setEditingName(t.name);
                    }}
                  >
                    Pervadinti
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleDeleteTable(t.id, t.name);
                    }}
                  >
                    Ištrinti
                  </button>
                  <button
                    type="button"
                    className="table-card-owner-trigger"
                    title="Kurie darbuotojai gali matyti šią lentelę — jūs matote ją visada"
                    onClick={(e) => {
                      e.stopPropagation();
                      const el = e.currentTarget;
                      if (ownerPopoverTableId === t.id) {
                        setOwnerPopoverTableId(null);
                        setOwnerPopoverAnchor(null);
                      } else {
                        setOwnerPopoverTableId(t.id);
                        setOwnerPopoverAnchor(el);
                      }
                    }}
                  >
                    <Users className="icon" size={14} /> Prieiga: {accessSummaryLabel((t.ownerUserIds ?? []).length)}
                  </button>
                  {ownerPopoverTableId === t.id && ownerPopoverAnchor && (
                    <Popover anchor={ownerPopoverAnchor} width={240}>
                      <div className="table-card-owner-popover-list">
                        {workers.length === 0 && <p className="instantly-hint">Darbuotojų nėra.</p>}
                        {workers.map((w) => {
                          const ids = t.ownerUserIds ?? [];
                          const checked = ids.includes(w.id);
                          return (
                            <label key={w.id} className="table-card-owner-popover-row">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => setTableOwners(t.id, checked ? ids.filter((id) => id !== w.id) : [...ids, w.id])}
                              />
                              {`${w.firstName} ${w.lastName}`.trim()}
                            </label>
                          );
                        })}
                      </div>
                    </Popover>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {importHistoryOpen && <ImportHistoryModal onClose={() => setImportHistoryOpen(false)} />}
    </div>
  );
}
