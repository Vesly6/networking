import { useEffect, useState } from 'react';
import type { Column, Row } from '../types';
import { useDemoTableStore } from '../store/useDemoTableStore';
import { getPrimaryLabel } from '../utils/row';

interface DemoFormulaBarProps {
  tableId: string;
  selection: { rowId: string; columnId: string } | null;
  columns: Column[];
  rows: Row[];
}

/** Adapted from production's FormulaBar.tsx — same layout/behavior
 * (shows/edits the active cell's full value, defaults to a 3-line
 * textarea), minus the Excel-cell-length-truncation toast (demo has no
 * such limit) and the dropdown-type "read-only value" branch collapsed
 * into the same textarea path, since demo's dropdown editing already
 * happens inline in the grid either way. */
export function DemoFormulaBar({ tableId, selection, columns, rows }: DemoFormulaBarProps) {
  const updateCell = useDemoTableStore((s) => s.updateCell);

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
        <span className="formula-bar-hint">Select a cell to see its full content</span>
      </div>
    );
  }

  const commit = () => {
    if (draft === storedValue) return;
    updateCell(tableId, row.id, column.id, draft);
  };

  return (
    <div className="formula-bar">
      <span className="formula-bar-label">
        {column.name} <span className="formula-bar-row">· {getPrimaryLabel(row, columns)}</span>
      </span>
      {column.type === 'dropdown' ? (
        <span className="formula-bar-value">{draft || '—'}</span>
      ) : (
        <textarea className="formula-bar-input" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} rows={3} />
      )}
    </div>
  );
}
