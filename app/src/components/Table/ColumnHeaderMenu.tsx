import type { Column } from '../../types';
import { useTableStore } from '../../store/useTableStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { ContextMenu } from '../ContextMenu';

interface ColumnHeaderMenuProps {
  x: number;
  y: number;
  columns: Column[];
  /** The right-clicked column plus whatever else was already selected —
   * resolved by the caller before opening this menu (see TableView's
   * handleColumnContextMenu: right-clicking outside the current selection
   * collapses it to just the clicked column first, matching Excel). */
  targetIds: string[];
  onSort: (direction: 'asc' | 'desc') => void;
  onCopy: () => void;
  onPaste: () => void;
  onClose: () => void;
}

export function ColumnHeaderMenu({ x, y, columns, targetIds, onSort, onCopy, onPaste, onClose }: ColumnHeaderMenuProps) {
  const insertColumns = useTableStore((s) => s.insertColumns);
  const removeColumns = useTableStore((s) => s.removeColumns);
  const setColumnsHidden = useTableStore((s) => s.setColumnsHidden);

  const targetSet = new Set(targetIds);
  const indices = columns.reduce<number[]>((acc, c, i) => (targetSet.has(c.id) ? [...acc, i] : acc), []);
  const firstIndex = Math.min(...indices);
  const lastIndex = Math.max(...indices);
  const count = targetIds.length;
  const n = count > 1 ? `${count} ` : '';
  const plural = count > 1 ? 's' : '';

  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <ContextMenu x={x} y={y}>
      <button type="button" className="context-menu-item" onClick={() => run(() => insertColumns(columns[firstIndex].id, count))}>
        Insert {n}column{plural} left
      </button>
      <button
        type="button"
        className="context-menu-item"
        onClick={() => run(() => insertColumns(columns[lastIndex + 1]?.id ?? null, count))}
      >
        Insert {n}column{plural} right
      </button>
      <button type="button" className="context-menu-item" onClick={() => run(() => setColumnsHidden(targetIds, true))}>
        Hide column{plural}
      </button>
      <div className="context-menu-separator" />
      <button type="button" className="context-menu-item" onClick={() => run(onCopy)}>
        Copy column{plural}
      </button>
      <button type="button" className="context-menu-item" onClick={() => run(onPaste)}>
        Paste
      </button>
      <div className="context-menu-separator" />
      <button
        type="button"
        className="context-menu-item context-menu-danger"
        onClick={async () => {
          const ok = await confirmDialog({
            message: `Delete ${count > 1 ? `these ${count} columns` : 'this column'}? Data will be lost.`,
            danger: true,
          });
          if (ok) run(() => removeColumns(targetIds));
        }}
      >
        Delete column{plural}
      </button>
      {count === 1 && (
        <>
          <div className="context-menu-separator" />
          <button type="button" className="context-menu-item" onClick={() => run(() => onSort('asc'))}>
            Sort A → Z
          </button>
          <button type="button" className="context-menu-item" onClick={() => run(() => onSort('desc'))}>
            Sort Z → A
          </button>
        </>
      )}
    </ContextMenu>
  );
}
