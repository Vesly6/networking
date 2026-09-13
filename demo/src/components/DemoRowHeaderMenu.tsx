import { useDemoTableStore } from '../store/useDemoTableStore';
import { confirmDialog } from '../store/useConfirmStore';
import { ContextMenu } from './ContextMenu';
import type { Row } from '../types';

interface DemoRowHeaderMenuProps {
  tableId: string;
  x: number;
  y: number;
  rows: Row[];
  rowId: string;
  onClose: () => void;
}

/** A trimmed port of production's RowHeaderMenu.tsx — insert row above/
 * below, delete row. Single-row only (matching DemoColumnHeaderMenu's own
 * documented scope decision — demo has no multi-row range selection in
 * this pass). `rows` here is the table's own unsorted (order-only) array,
 * not the filtered/sorted view — same reasoning as production's own row
 * insert/reorder, which resolves position against the real underlying
 * order, not whatever the current search/sort happens to display. */
export function DemoRowHeaderMenu({ tableId, x, y, rows, rowId, onClose }: DemoRowHeaderMenuProps) {
  const insertRows = useDemoTableStore((s) => s.insertRows);
  const removeRows = useDemoTableStore((s) => s.removeRows);

  const index = rows.findIndex((r) => r.id === rowId);
  if (index === -1) return null;

  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <ContextMenu x={x} y={y}>
      <button type="button" className="context-menu-item" onClick={() => run(() => insertRows(tableId, rowId, 1))}>
        Insert row above
      </button>
      <button type="button" className="context-menu-item" onClick={() => run(() => insertRows(tableId, rows[index + 1]?.id ?? null, 1))}>
        Insert row below
      </button>
      <div className="context-menu-separator" />
      <button
        type="button"
        className="context-menu-item context-menu-danger"
        onClick={async () => {
          const ok = await confirmDialog({ message: 'Delete this row? This can\'t be undone.', danger: true });
          if (ok) run(() => removeRows(tableId, [rowId]));
        }}
      >
        Delete row
      </button>
    </ContextMenu>
  );
}
