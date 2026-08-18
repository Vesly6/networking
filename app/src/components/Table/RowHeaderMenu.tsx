import type { Row } from '../../types';
import { useTableStore } from '../../store/useTableStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { ContextMenu } from '../ContextMenu';

interface RowHeaderMenuProps {
  x: number;
  y: number;
  /** The current view order (filteredSortedRows) — insert position is
   * resolved against this, not the raw stored order, so "above/below" means
   * what it visually looks like at the moment of the right-click. */
  rows: Row[];
  targetIds: string[];
  /** false while a sort/search is active — matches the same gate row
   * drag-reorder already uses (manual order and an active sort/filter can't
   * both define "row position"), so above/below insertion is hidden then
   * rather than silently inserting somewhere that doesn't match what's on
   * screen. */
  insertEnabled: boolean;
  onCopy: () => void;
  onPaste: () => void;
  onClose: () => void;
}

export function RowHeaderMenu({ x, y, rows, targetIds, insertEnabled, onCopy, onPaste, onClose }: RowHeaderMenuProps) {
  const insertRows = useTableStore((s) => s.insertRows);
  const removeRows = useTableStore((s) => s.removeRows);
  const addRow = useTableStore((s) => s.addRow);

  const targetSet = new Set(targetIds);
  const indices = rows.reduce<number[]>((acc, r, i) => (targetSet.has(r.id) ? [...acc, i] : acc), []);
  const firstIndex = Math.min(...indices);
  const lastIndex = Math.max(...indices);
  const count = targetIds.length;
  // Same reasoning as ColumnHeaderMenu — Lithuanian nouns decline rather
  // than take an English "-s" suffix, so plural phrasing uses a
  // parenthetical count instead of templatized declension.
  const suffix = count > 1 ? ` (${count})` : '';

  const run = (fn: () => void) => {
    fn();
    onClose();
  };

  return (
    <ContextMenu x={x} y={y}>
      {insertEnabled ? (
        <>
          <button type="button" className="context-menu-item" onClick={() => run(() => insertRows(rows[firstIndex].id, count))}>
            Įterpti {count > 1 ? 'eilutes' : 'eilutę'} virš{suffix}
          </button>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => run(() => insertRows(rows[lastIndex + 1]?.id ?? null, count))}
          >
            Įterpti {count > 1 ? 'eilutes' : 'eilutę'} žemiau{suffix}
          </button>
        </>
      ) : (
        <button type="button" className="context-menu-item" onClick={() => run(() => addRow())}>
          Pridėti eilutę
        </button>
      )}
      <div className="context-menu-separator" />
      <button type="button" className="context-menu-item" onClick={() => run(onCopy)}>
        Kopijuoti {count > 1 ? 'eilutes' : 'eilutę'}{suffix}
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
            message: `Ištrinti ${count > 1 ? `pasirinktas eilutes (${count})` : 'šią eilutę'}?`,
            danger: true,
          });
          if (ok) run(() => removeRows(targetIds));
        }}
      >
        Ištrinti {count > 1 ? 'eilutes' : 'eilutę'}{suffix}
      </button>
    </ContextMenu>
  );
}
