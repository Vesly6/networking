import { useState } from 'react';
import { useWorkspaceStore } from '../store/useWorkspaceStore';

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
  const renameTable = useWorkspaceStore((s) => s.renameTable);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const commitRename = () => {
    if (editingId) renameTable(editingId, editingName);
    setEditingId(null);
  };

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
            onDoubleClick={() => {
              setEditingId(t.id);
              setEditingName(t.name);
            }}
            title="Click to switch tables, double-click to rename"
          >
            {t.name}
          </button>
        ),
      )}
      <button
        type="button"
        className="sheet-tab-add"
        title="New table"
        onClick={() => setActiveTable(createTable(`Table ${tables.length + 1}`))}
      >
        +
      </button>
    </div>
  );
}
