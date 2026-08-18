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
  // Lithuanian nouns decline by number/case rather than take an English-
  // style "-s" suffix, so plural phrasing uses a parenthetical count
  // instead of trying to templatize declension.
  const suffix = count > 1 ? ` (${count})` : '';

  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <ContextMenu x={x} y={y}>
      <button type="button" className="context-menu-item" onClick={() => run(() => insertColumns(columns[firstIndex].id, count))}>
        Įterpti {count > 1 ? 'stulpelius' : 'stulpelį'} kairėje{suffix}
      </button>
      <button
        type="button"
        className="context-menu-item"
        onClick={() => run(() => insertColumns(columns[lastIndex + 1]?.id ?? null, count))}
      >
        Įterpti {count > 1 ? 'stulpelius' : 'stulpelį'} dešinėje{suffix}
      </button>
      <button type="button" className="context-menu-item" onClick={() => run(() => setColumnsHidden(targetIds, true))}>
        Slėpti {count > 1 ? 'stulpelius' : 'stulpelį'}{suffix}
      </button>
      <div className="context-menu-separator" />
      <button type="button" className="context-menu-item" onClick={() => run(onCopy)}>
        Kopijuoti {count > 1 ? 'stulpelius' : 'stulpelį'}{suffix}
      </button>
      <button type="button" className="context-menu-item" onClick={() => run(onPaste)}>
        Įklijuoti
      </button>
      <div className="context-menu-separator" />
      <button
        type="button"
        className="context-menu-item context-menu-danger"
        onClick={async () => {
          const ok = await confirmDialog({
            message: `Ištrinti ${count > 1 ? `pasirinktus stulpelius (${count})` : 'šį stulpelį'}? Duomenys bus prarasti.`,
            danger: true,
          });
          if (ok) run(() => removeColumns(targetIds));
        }}
      >
        Ištrinti {count > 1 ? 'stulpelius' : 'stulpelį'}{suffix}
      </button>
      {count === 1 && (
        <>
          <div className="context-menu-separator" />
          <button type="button" className="context-menu-item" onClick={() => run(() => onSort('asc'))}>
            Rikiuoti A → Z
          </button>
          <button type="button" className="context-menu-item" onClick={() => run(() => onSort('desc'))}>
            Rikiuoti Z → A
          </button>
        </>
      )}
    </ContextMenu>
  );
}
