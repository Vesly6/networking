import { useEffect, useState } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { countRowsForTable } from '../../db/db';

interface WorkspaceViewProps {
  onOpenTable: (id: string) => void;
}

export function WorkspaceView({ onOpenTable }: WorkspaceViewProps) {
  const tables = useWorkspaceStore((s) => s.tables);
  const createTable = useWorkspaceStore((s) => s.createTable);
  const renameTable = useWorkspaceStore((s) => s.renameTable);
  const deleteTable = useWorkspaceStore((s) => s.deleteTable);

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

  const handleCreate = () => {
    const id = createTable(`Table ${tables.length + 1}`);
    onOpenTable(id);
  };

  // Deleting a whole table is the single most destructive action in the
  // app (every row, gone, with no undo — undo/redo history is per-table
  // and reset on load, so there's nothing to recover through even the
  // usual Ctrl+Z path) — on explicit request, this gets one extra
  // confirmation step beyond the standard confirmDialog every other
  // delete in the app uses, not just a reworded single dialog.
  const handleDeleteTable = async (id: string, name: string) => {
    const rows = rowCounts[id] ?? 0;
    const first = await confirmDialog({ message: `Delete table "${name}" and all of its rows?`, danger: true });
    if (!first) return;
    const second = await confirmDialog({
      title: 'Are you sure?',
      message: `This will permanently delete "${name}"${rows > 0 ? ` and all ${rows} of its rows` : ''}. This cannot be undone.`,
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (second) deleteTable(id);
  };

  return (
    <div className="workspace-view">
      <div className="workspace-header">
        <h2>Workspace</h2>
        <button type="button" className="primary" onClick={handleCreate}>
          + New table
        </button>
      </div>

      {tables.length === 0 ? (
        <div className="empty-state">No tables yet — create your first one.</div>
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
              <div className="table-card-meta">{rowCounts[t.id] ?? '…'} rows</div>
              <div className="table-card-actions">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingId(t.id);
                    setEditingName(t.name);
                  }}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleDeleteTable(t.id, t.name);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
