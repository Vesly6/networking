import type { Column, Row } from '../../types';
import { useTableStore } from '../../store/useTableStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { ContextMenu } from '../ContextMenu';

interface CellContextMenuProps {
  x: number;
  y: number;
  rows: Row[];
  columns: Column[];
  /** The row(s)/column(s) the right-clicked cell (or the active range
   * selection it's part of) spans — resolved by the caller the same way
   * handleRowContextMenu/handleColumnContextMenu already do (right-
   * clicking outside the current selection collapses it to just the
   * clicked cell first, matching Excel). */
  rowTargetIds: string[];
  columnTargetIds: string[];
  /** Same gate row drag-reorder/insert already uses — manual row order
   * and an active sort/search can't both define "row position". */
  rowInsertEnabled: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onClear: () => void;
  onClose: () => void;
}

/** Right-click on any plain data cell — not just the row-number/column-
 * letter gutters — on explicit request ("когда я нажимаю на любую ячейку
 * правой кнопкой мыши... все как в Экселе"). Combines the same row and
 * column actions RowHeaderMenu/ColumnHeaderMenu already offer (insert/
 * delete/hide) into one menu, plus the cell-range actions Excel's own
 * right-click-on-a-cell menu has that neither header menu needs (copy/
 * paste/clear contents) — those two header menus stay as their own
 * separate, unchanged entry points for right-clicking the gutters
 * themselves; this is a third, additive entry point, not a replacement. */
export function CellContextMenu({
  x,
  y,
  rows,
  columns,
  rowTargetIds,
  columnTargetIds,
  rowInsertEnabled,
  onCopy,
  onPaste,
  onClear,
  onClose,
}: CellContextMenuProps) {
  const insertRows = useTableStore((s) => s.insertRows);
  const removeRows = useTableStore((s) => s.removeRows);
  const setRowsHidden = useTableStore((s) => s.setRowsHidden);
  const addRow = useTableStore((s) => s.addRow);
  const insertColumns = useTableStore((s) => s.insertColumns);
  const removeColumns = useTableStore((s) => s.removeColumns);
  const setColumnsHidden = useTableStore((s) => s.setColumnsHidden);

  const rowTargetSet = new Set(rowTargetIds);
  const rowIndices = rows.reduce<number[]>((acc, r, i) => (rowTargetSet.has(r.id) ? [...acc, i] : acc), []);
  const firstRowIndex = Math.min(...rowIndices);
  const lastRowIndex = Math.max(...rowIndices);
  const rowCount = rowTargetIds.length;
  const rowSuffix = rowCount > 1 ? ` (${rowCount})` : '';

  const colTargetSet = new Set(columnTargetIds);
  const colIndices = columns.reduce<number[]>((acc, c, i) => (colTargetSet.has(c.id) ? [...acc, i] : acc), []);
  const firstColIndex = Math.min(...colIndices);
  const lastColIndex = Math.max(...colIndices);
  const colCount = columnTargetIds.length;
  const colSuffix = colCount > 1 ? ` (${colCount})` : '';

  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <ContextMenu x={x} y={y}>
      <button type="button" className="context-menu-item" onClick={() => run(onCopy)}>
        Kopijuoti
      </button>
      <button type="button" className="context-menu-item" onClick={() => run(onPaste)}>
        Įklijuoti
      </button>
      <button type="button" className="context-menu-item" onClick={() => run(onClear)}>
        Išvalyti turinį
      </button>

      <div className="context-menu-separator" />
      {rowInsertEnabled ? (
        <>
          <button type="button" className="context-menu-item" onClick={() => run(() => insertRows(rows[firstRowIndex].id, rowCount))}>
            Įterpti {rowCount > 1 ? 'eilutes' : 'eilutę'} virš{rowSuffix}
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => run(() => insertRows(rows[lastRowIndex + 1]?.id ?? null, rowCount))}
          >
            Įterpti {rowCount > 1 ? 'eilutes' : 'eilutę'} žemiau{rowSuffix}
          </button>
        </>
      ) : (
        <button type="button" className="context-menu-item" onClick={() => run(() => addRow())}>
          Pridėti eilutę
        </button>
      )}
      <button type="button" className="context-menu-item" onClick={() => run(() => setRowsHidden(rowTargetIds, true))}>
        Slėpti {rowCount > 1 ? 'eilutes' : 'eilutę'}{rowSuffix}
      </button>
      <button
        type="button"
        className="context-menu-item context-menu-danger"
        onClick={async () => {
          const ok = await confirmDialog({
            message: `Ištrinti ${rowCount > 1 ? `pasirinktas eilutes (${rowCount})` : 'šią eilutę'}?`,
            danger: true,
          });
          if (ok) run(() => removeRows(rowTargetIds));
        }}
      >
        Ištrinti {rowCount > 1 ? 'eilutes' : 'eilutę'}{rowSuffix}
      </button>

      <div className="context-menu-separator" />
      <button type="button" className="context-menu-item" onClick={() => run(() => insertColumns(columns[firstColIndex].id, colCount))}>
        Įterpti {colCount > 1 ? 'stulpelius' : 'stulpelį'} kairėje{colSuffix}
      </button>
      <button
        type="button"
        className="context-menu-item"
        onClick={() => run(() => insertColumns(columns[lastColIndex + 1]?.id ?? null, colCount))}
      >
        Įterpti {colCount > 1 ? 'stulpelius' : 'stulpelį'} dešinėje{colSuffix}
      </button>
      <button type="button" className="context-menu-item" onClick={() => run(() => setColumnsHidden(columnTargetIds, true))}>
        Slėpti {colCount > 1 ? 'stulpelius' : 'stulpelį'}{colSuffix}
      </button>
      <button
        type="button"
        className="context-menu-item context-menu-danger"
        onClick={async () => {
          const ok = await confirmDialog({
            message: `Ištrinti ${colCount > 1 ? `pasirinktus stulpelius (${colCount})` : 'šį stulpelį'}? Duomenys bus prarasti.`,
            danger: true,
          });
          if (ok) run(() => removeColumns(columnTargetIds));
        }}
      >
        Ištrinti {colCount > 1 ? 'stulpelius' : 'stulpelį'}{colSuffix}
      </button>
    </ContextMenu>
  );
}
