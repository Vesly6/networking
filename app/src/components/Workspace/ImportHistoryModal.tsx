import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, RotateCcw } from 'lucide-react';
import { listImportRecords, confirmImportRollback, type ImportOperationRecord, type ImportOperationType } from '../../utils/importHistory';
import { applyImportRollback } from '../../utils/applyImportRollback';
import { confirmDialog } from '../../store/useConfirmStore';
import { useToastStore } from '../../store/useToastStore';

const TYPE_LABELS: Record<ImportOperationType, string> = {
  contacts_merge: 'Kontaktų sujungimas',
  reply_push: 'Atsakymų perkėlimas',
  mark_sent: 'Pažymėta išsiųsta',
};

function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString('lt-LT', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

interface ImportHistoryModalProps {
  onClose: () => void;
}

/** "Importų istorija" — Workspace screen's window onto every logged
 * import operation (see importHistory.ts's own doc comment for exactly
 * which three flows this covers, and why an ordinary CSV-into-a-new-table
 * import isn't one of them: undoing that is just deleting the table it
 * created). Lists newest-first with a per-row "Atšaukti" that reverts
 * precisely that one import's own changes, regardless of what other
 * imports or manual edits happened before or after it — see
 * applyImportRollback.ts for how that precision is actually achieved. */
export function ImportHistoryModal({ onClose }: ImportHistoryModalProps) {
  const [operations, setOperations] = useState<ImportOperationRecord[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  const showToast = useToastStore((s) => s.show);

  const refresh = () => {
    setError(null);
    listImportRecords()
      .then((r) => {
        setOperations(r.operations);
        setReady(true);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Nepavyko įkelti importų istorijos');
        setReady(true);
      });
  };

  useEffect(() => {
    refresh();
    // Load once on mount only.
  }, []);

  const handleRollback = async (op: ImportOperationRecord) => {
    const ok = await confirmDialog({
      message: `Atšaukti „${op.label}“? Bus panaikinti tik šio importo pakeitimai — kiti importai ir po jo padaryti pakeitimai nebus paveikti.`,
      danger: true,
    });
    if (!ok) return;
    setRollingBackId(op.id);
    try {
      const result = await applyImportRollback(op.changes);
      await confirmImportRollback(op.id);
      const parts = [`Atšaukta eilučių: ${result.rowsReverted}`];
      if (result.rowsSkipped > 0) parts.push(`praleista (eilutė ištrinta): ${result.rowsSkipped}`);
      if (result.tablesSkipped > 0) parts.push(`praleista (lentelė ištrinta): ${result.tablesSkipped}`);
      showToast(parts.join(' · '));
      refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko atšaukti importo');
    } finally {
      setRollingBackId(null);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal import-history-modal" onClick={(e) => e.stopPropagation()}>
        <div className="apollo-search-modal-header">
          <h2>Importų istorija</h2>
          <button type="button" className="apollo-search-modal-close" onClick={onClose}>
            <X className="icon" size={16} />
          </button>
        </div>
        {!ready && <p>Kraunama…</p>}
        {error && <p className="search-result-detail-error">{error}</p>}
        {ready && !error && operations.length === 0 && <p className="csv-import-mapping-hint">Importų dar nebuvo.</p>}
        {ready && operations.length > 0 && (
          <div className="import-history-list">
            {operations.map((op) => (
              <div key={op.id} className="import-history-row">
                <div className="import-history-row-info">
                  <span className="import-history-row-type">{TYPE_LABELS[op.type]}</span>
                  <span className="import-history-row-label">{op.label}</span>
                  <span className="import-history-row-meta">
                    {formatDateTime(op.createdAt)} · {op.recordCount}{' '}
                    {op.status === 'rolled_back' && <span className="import-history-row-status">· atšaukta</span>}
                  </span>
                </div>
                {op.status === 'active' ? (
                  <button type="button" disabled={rollingBackId === op.id} onClick={() => void handleRollback(op)}>
                    <RotateCcw className="icon" size={14} /> {rollingBackId === op.id ? 'Atšaukiama…' : 'Atšaukti'}
                  </button>
                ) : (
                  <span className="import-history-row-done">Atšaukta</span>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="popover-footer">
          <button type="button" onClick={onClose}>
            Uždaryti
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
