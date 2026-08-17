import { useEffect, useState } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
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
                    if (window.confirm(`Delete table "${t.name}" and all of its rows?`)) {
                      deleteTable(t.id);
                    }
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
