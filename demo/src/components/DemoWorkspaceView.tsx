import { useState } from 'react';
import { useDemoTableStore } from '../store/useDemoTableStore';
import { confirmDialog } from '../store/useConfirmStore';
import { useToastStore } from '../store/useToastStore';
import { DemoLogo } from './DemoLogo';
import { ThemeToggle } from './ThemeToggle';
import { BrandIcon } from './BrandIcon';

/** A right-sized port of production's WorkspaceView.tsx — the home
 * screen a visitor lands on before opening any table. Ported structure:
 * header (brand + wordmark + theme toggle + "+ Nauja lentelė"), a grid
 * of table cards (name, row count, Pervadinti/Ištrinti), empty state.
 *
 * Deliberately omitted, all for the same reason — each depends on a real
 * backend/multi-user model this stateless, credential-free demo
 * structurally cannot have (see the parity audit's "correctly-excluded"
 * list): Darbuotojai (worker accounts), Naujienos (needs a real search
 * API key), Duomenys (cross-device backups), Importų istorija (a log of
 * past server-side imports), Atsijungti (there is no login to log out
 * of). Their absence here is a deliberate, documented decision, not the
 * "silently missing because nobody ported it" failure mode the parity
 * audit's root-cause section describes for the rest of this app. */
export function DemoWorkspaceView({ onOpenTable }: { onOpenTable: (id: string) => void }) {
  const tables = useDemoTableStore((s) => s.tables);
  const rowsByTable = useDemoTableStore((s) => s.rowsByTable);
  const createTable = useDemoTableStore((s) => s.createTable);
  const renameTable = useDemoTableStore((s) => s.renameTable);
  const deleteTable = useDemoTableStore((s) => s.deleteTable);
  const showToast = useToastStore((s) => s.show);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const handleCreate = () => {
    const id = createTable(`Table ${tables.length + 1}`);
    onOpenTable(id);
    showToast('Table created');
  };

  const handleDelete = async (id: string, name: string) => {
    const ok = await confirmDialog({
      message: `Delete "${name}"? This can't be undone.`,
      danger: true,
    });
    if (!ok) return;
    deleteTable(id);
    showToast('Table deleted');
  };

  return (
    <div className="workspace-view">
      <div className="workspace-header">
        <div className="brand">
          <BrandIcon />
          <DemoLogo />
        </div>
        <div className="workspace-header-actions">
          <ThemeToggle />
          <button type="button" className="primary" onClick={handleCreate}>
            + New table
          </button>
        </div>
      </div>

      {tables.length === 0 ? (
        <div className="empty-state">No tables yet — create the first one.</div>
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
              <div className="table-card-meta">Rows: {rowsByTable[t.id]?.length ?? 0}</div>
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
                    void handleDelete(t.id, t.name);
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
