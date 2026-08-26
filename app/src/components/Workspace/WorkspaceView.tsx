import { useEffect, useState } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import { confirmDeleteTable } from '../../utils/confirmDeleteTable';
import { countRowsForTable } from '../../db/db';
import { BrandLogo } from '../BrandLogo';
import { ThemeToggle } from '../ThemeToggle';

interface WorkspaceViewProps {
  onOpenTable: (id: string) => void;
  /** Threaded from App.tsx — "Darbuotojai"/"API raktai" are only reachable
   * from this screen (moved out of the in-table nav — see AppScreen's own
   * doc comment in App.tsx for the layout bug that motivated this: both
   * screens used to render underneath SheetTabs' fixed bottom bar, which
   * visually overlapped their own scrolled content). Omitted entirely for
   * workers (see canManageTables below — same role gate). */
  onOpenWorkers?: () => void;
  onOpenIntegrations?: () => void;
}

export function WorkspaceView({ onOpenTable, onOpenWorkers, onOpenIntegrations }: WorkspaceViewProps) {
  const tables = useWorkspaceStore((s) => s.tables);
  const createTable = useWorkspaceStore((s) => s.createTable);
  const renameTable = useWorkspaceStore((s) => s.renameTable);
  const deleteTable = useWorkspaceStore((s) => s.deleteTable);
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

  const [rowCounts, setRowCounts] = useState<Record<string, number>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all(tables.map(async (t) => [t.id, await countRowsForTable(t.id)] as const)).then((entries) => {
      if (!cancelled) setRowCounts(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [tables]);

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
          <h2>Darbo sritis</h2>
        </div>
        <div className="workspace-header-actions">
          <ThemeToggle />
          {canManageTables && onOpenWorkers && (
            <button type="button" onClick={onOpenWorkers}>
              Darbuotojai
            </button>
          )}
          {canManageTables && onOpenIntegrations && (
            <button type="button" onClick={onOpenIntegrations}>
              API raktai
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

      {tables.length === 0 ? (
        <div className="empty-state">Kol kas nėra lentelių — sukurkite pirmąją.</div>
      ) : (
        <div className="table-cards">
          {tables.map((t) => (
            <div key={t.id} className="table-card" onClick={() => editingId !== t.id && onOpenTable(t.id)}>
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
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
