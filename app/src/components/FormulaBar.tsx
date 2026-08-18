import { useEffect, useState } from 'react';
import type { Column, Row } from '../types';
import { useTableStore } from '../store/useTableStore';
import { useToastStore } from '../store/useToastStore';
import { getPrimaryLabel } from '../utils/row';
import { EXCEL_CELL_LIMIT } from '../constants';

interface FormulaBarProps {
  selection: { rowId: string; columnId: string } | null;
  columns: Column[];
  rows: Row[];
}

export function FormulaBar({ selection, columns, rows }: FormulaBarProps) {
  const updateCell = useTableStore((s) => s.updateCell);
  const showToast = useToastStore((s) => s.show);

  const row = selection ? rows.find((r) => r.id === selection.rowId) : undefined;
  const column = selection ? columns.find((c) => c.id === selection.columnId) : undefined;
  const storedValue = row && column ? row.cells[column.id] ?? '' : '';

  const [draft, setDraft] = useState(storedValue);

  useEffect(() => {
    setDraft(storedValue);
  }, [selection?.rowId, selection?.columnId, storedValue]);

  if (!selection || !row || !column) {
    return (
      <div className="formula-bar formula-bar-empty">
        <span className="formula-bar-label">—</span>
        <span className="formula-bar-hint">Pasirinkite langelį, kad matytumėte visą jo turinį</span>
      </div>
    );
  }

  const commit = () => {
    if (draft === storedValue) return;
    const truncated = updateCell(row.id, column.id, draft);
    if (truncated) {
      showToast(`Tekstas apkarpytas iki Excel langelio ribos — ${EXCEL_CELL_LIMIT.toLocaleString('lt-LT')} simbolių`);
      setDraft(row.cells[column.id] ?? '');
    }
  };

  return (
    <div className="formula-bar">
      <span className="formula-bar-label">
        {column.name} <span className="formula-bar-row">· {getPrimaryLabel(row, columns)}</span>
      </span>
      {column.type === 'dropdown' ? (
        <span className="formula-bar-value">{draft || '—'}</span>
      ) : (
        <textarea
          className="formula-bar-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          rows={3}
        />
      )}
    </div>
  );
}
