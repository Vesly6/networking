import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useAuthStore } from '../store/useAuthStore';
import { confirmDeleteTable } from '../utils/confirmDeleteTable';
import { countRowsForTable } from '../db/db';
import { ContextMenu } from './ContextMenu';

/** Excel-style sheet tabs along the bottom of the window — lets you switch
 * between the workspace's other tables without leaving the current one to
 * go back to the Workspace screen. No new data relationship between tables
 * is introduced here; this is purely a faster way to reach
 * useWorkspaceStore's existing table list/setActiveTable, which the
 * Workspace screen already exposes as cards. */
export function SheetTabs() {
  const tables = useWorkspaceStore((s) => s.tables);
  const activeTableId = useWorkspaceStore((s) => s.activeTableId);
  const setActiveTable = useWorkspaceStore((s) => s.setActiveTable);
  const createTable = useWorkspaceStore((s) => s.createTable);
  const duplicateTable = useWorkspaceStore((s) => s.duplicateTable);
  const renameTable = useWorkspaceStore((s) => s.renameTable);
  const deleteTable = useWorkspaceStore((s) => s.deleteTable);
  const currentUser = useAuthStore((s) => s.user);
  // Same hard block as WorkspaceView.tsx's own table cards, and for the
  // identical reason — this is a second, faster entry point to the exact
  // same four actions (rename/new/duplicate/delete), so it needs the same
  // gate or a worker could just use this row instead. See WorkspaceView's
  // own doc comment for the full reasoning; server/src/index.ts's
  // requireNotWorker on all four routes is what actually enforces it.
  const canManageTables = currentUser?.role !== 'worker';

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; name: string } | null>(null);

  const commitRename = () => {
    if (editingId) renameTable(editingId, editingName);
    setEditingId(null);
  };

  const startRename = (id: string, name: string) => {
    setEditingId(id);
    setEditingName(name);
  };

  const handleNewTable = async () => {
    const id = await createTable(`Lentelė ${tables.length + 1}`);
    // On failure, stay on the current table (whose error toast App.tsx
    // already shows) rather than getting bounced out to the Workspace
    // screen — createTable() itself returns null instead of throwing on
    // failure specifically so callers can make this call, see
    // useWorkspaceStore's own actionError doc comment.
    if (id) setActiveTable(id);
  };

  const handleContextMenu = (e: ReactMouseEvent, id: string, name: string) => {
    e.preventDefault();
    if (!canManageTables) return;
    setMenu({ x: e.clientX, y: e.clientY, id, name });
  };

  // ContextMenu itself only stops its own click from bubbling (so clicking
  // an item inside it doesn't also trigger this) — closing on a click
  // anywhere else is the caller's job, same as every other context menu
  // in the app (TableView's closePopovers does this for the column/row
  // header menus).
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menu]);

  return (
    <div className="sheet-tabs">
      {tables.map((t) =>
        editingId === t.id ? (
          <input
            key={t.id}
            autoFocus
            className="sheet-tab-input"
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditingId(null);
            }}
          />
        ) : (
          <button
            key={t.id}
            type="button"
            className={`sheet-tab ${t.id === activeTableId ? 'sheet-tab-active' : ''}`}
            onClick={() => setActiveTable(t.id)}
            onContextMenu={(e) => handleContextMenu(e, t.id, t.name)}
            title={
              canManageTables
                ? 'Spustelėkite, kad perjungtumėte lenteles — dešiniuoju paspaudimu pervadinkite, pridėkite, dubliuokite ar ištrinkite'
                : 'Spustelėkite, kad perjungtumėte lenteles'
            }
          >
            {t.name}
          </button>
        ),
      )}
      {canManageTables && (
        <button type="button" className="sheet-tab-add" title="Nauja lentelė" onClick={handleNewTable}>
          +
        </button>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y}>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              startRename(menu.id, menu.name);
              setMenu(null);
            }}
          >
            Pervadinti
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              setMenu(null);
              void handleNewTable();
            }}
          >
            Nauja lentelė
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={async () => {
              const newId = await duplicateTable(menu.id);
              setMenu(null);
              if (newId) setActiveTable(newId);
            }}
          >
            Dubliuoti lentelę
          </button>
          <button
            type="button"
            className="context-menu-item context-menu-danger"
            onClick={async () => {
              const id = menu.id;
              const name = menu.name;
              setMenu(null);
              const rows = await countRowsForTable(id);
              if (await confirmDeleteTable(name, rows)) deleteTable(id);
            }}
          >
            Ištrinti lentelę
          </button>
        </ContextMenu>
      )}
    </div>
  );
}
