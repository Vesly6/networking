import { useDemoTableStore } from '../store/useDemoTableStore';
import { confirmDialog } from '../store/useConfirmStore';
import { ContextMenu } from './ContextMenu';
import type { Column } from '../types';

interface DemoColumnHeaderMenuProps {
  tableId: string;
  x: number;
  y: number;
  columns: Column[];
  columnId: string;
  onSort: (direction: 'asc' | 'desc') => void;
  onClose: () => void;
}

/** A trimmed port of production's ColumnHeaderMenu.tsx — insert left/
 * right, delete column, sort A→Z/Z→A. Deliberately dropped for this
 * pass: multi-column selection (demo has no column range-select), hide
 * column, copy/paste column, and the numeric/color/reply-status filter
 * popovers (each needs its own ported popover component) — single-column
 * insert/delete/sort already closes the single biggest gap the parity
 * audit found ("zero right-click menu anywhere"). */
export function DemoColumnHeaderMenu({ tableId, x, y, columns, columnId, onSort, onClose }: DemoColumnHeaderMenuProps) {
  const insertColumns = useDemoTableStore((s) => s.insertColumns);
  const removeColumns = useDemoTableStore((s) => s.removeColumns);

  const index = columns.findIndex((c) => c.id === columnId);
  if (index === -1) return null;

  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <ContextMenu x={x} y={y}>
      <button type="button" className="context-menu-item" onClick={() => run(() => insertColumns(tableId, columnId, 1))}>
        Insert column left
      </button>
      <button
        type="button"
        className="context-menu-item"
        onClick={() => run(() => insertColumns(tableId, columns[index + 1]?.id ?? null, 1))}
      >
        Insert column right
      </button>
      <div className="context-menu-separator" />
      <button
        type="button"
        className="context-menu-item context-menu-danger"
        onClick={async () => {
          const ok = await confirmDialog({ message: 'Delete this column? Data will be lost.', danger: true });
          if (ok) run(() => removeColumns(tableId, [columnId]));
        }}
      >
        Delete column
      </button>
      <div className="context-menu-separator" />
      <button type="button" className="context-menu-item" onClick={() => run(() => onSort('asc'))}>
        Sort A → Z
      </button>
      <button type="button" className="context-menu-item" onClick={() => run(() => onSort('desc'))}>
        Sort Z → A
      </button>
    </ContextMenu>
  );
}
