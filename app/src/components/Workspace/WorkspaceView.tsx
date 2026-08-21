import { useEffect, useState } from 'react';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useAuthStore } from '../../store/useAuthStore';
import { confirmDeleteTable } from '../../utils/confirmDeleteTable';
import { countRowsForTable } from '../../db/db';
import { migrateLocalDataToServer } from '../../utils/migrateTableData';
import { confirmDialog } from '../../store/useConfirmStore';
import { useToastStore } from '../../store/useToastStore';
import { BrandLogo } from '../BrandLogo';
import { ThemeToggle } from '../ThemeToggle';

interface WorkspaceViewProps {
  onOpenTable: (id: string) => void;
}

export function WorkspaceView({ onOpenTable }: WorkspaceViewProps) {
  const tables = useWorkspaceStore((s) => s.tables);
  const createTable = useWorkspaceStore((s) => s.createTable);
  const renameTable = useWorkspaceStore((s) => s.renameTable);
  const deleteTable = useWorkspaceStore((s) => s.deleteTable);
  const logout = useAuthStore((s) => s.logout);
  const initWorkspace = useWorkspaceStore((s) => s.init);
  const showToast = useToastStore((s) => s.show);

  const [rowCounts, setRowCounts] = useState<Record<string, number>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [migrating, setMigrating] = useState(false);

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
    const id = createTable(`Lentelė ${tables.length + 1}`);
    onOpenTable(id);
  };

  const handleDeleteTable = async (id: string, name: string) => {
    if (await confirmDeleteTable(name, rowCounts[id] ?? 0)) deleteTable(id);
  };

  // One-time move of this browser's own local IndexedDB tables/rows up to
  // the server — see utils/migrateTableData.ts's own doc comment. Always
  // visible (not hidden once run once) since it's a safe, idempotent
  // upsert — re-running it after adding more local data, or on a second
  // device that also has old local data, is fine.
  const handleMigrate = async () => {
    const ok = await confirmDialog(
      'Perkelti visus šio naršyklės lokalius duomenis (lenteles ir eilutes) į serverį? Vietiniai duomenys liks nepaliesti — tai tik nusiunčia kopiją.',
    );
    if (!ok) return;
    setMigrating(true);
    try {
      const result = await migrateLocalDataToServer();
      showToast(`Perkelta: ${result.tablesMigrated} lentelių, ${result.rowsMigrated} eilučių`);
      await initWorkspace();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko perkelti duomenų');
    } finally {
      setMigrating(false);
    }
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
          <button type="button" className="primary" onClick={handleCreate}>
            + Nauja lentelė
          </button>
          <button
            type="button"
            disabled={migrating}
            title="Vienkartinis veiksmas — nusiunčia šios naršyklės lenteles/eilutes į serverį, kad jos būtų matomos ir kituose įrenginiuose (pvz. telefone)."
            onClick={() => void handleMigrate()}
          >
            {migrating ? 'Perkeliama…' : '⬆ Perkelti į serverį'}
          </button>
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
