import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
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

  const handleNewTable = () => setActiveTable(createTable(`Table ${tables.length + 1}`));

  const handleContextMenu = (e: ReactMouseEvent, id: string, name: string) => {
    e.preventDefault();
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
            title="Click to switch tables — right-click to rename, add, duplicate, or delete"
          >
            {t.name}
          </button>
        ),
      )}
      <button type="button" className="sheet-tab-add" title="New table" onClick={handleNewTable}>
        +
      </button>
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
            Rename
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              setMenu(null);
              handleNewTable();
            }}
          >
            New table
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
            Duplicate table
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
            Delete table
          </button>
        </ContextMenu>
      )}
    </div>
  );
}
