import type { Column } from '../../types';
import { useTableStore } from '../../store/useTableStore';
import { useAuthStore } from '../../store/useAuthStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { ContextMenu } from '../ContextMenu';
import { Hash, Palette, Reply } from 'lucide-react';

interface ColumnHeaderMenuProps {
  x: number;
  y: number;
  columns: Column[];
  /** The right-clicked column plus whatever else was already selected —
   * resolved by the caller before opening this menu (see TableView's
   * handleColumnContextMenu: right-clicking outside the current selection
   * collapses it to just the clicked column first, matching Excel). */
  targetIds: string[];
  /** Sorting is a one-time, permanent action (see TableView's commitSort)
   * — there's no persistent "currently sorted" state to clear afterward,
   * so this menu only ever offers to run a sort, never to undo one. */
  onSort: (direction: 'asc' | 'desc') => void;
  /** Opens NumericRangeFilterPopover — deliberately takes no anchor
   * argument from here. This menu's own buttons get unmounted the instant
   * `run()` also calls onClose(), and Popover requires its anchor to
   * still be `isConnected` when it computes position — a real bug caught
   * before shipping: passing e.currentTarget straight through left the
   * popover permanently invisible (position stuck at -9999, since
   * Popover's effect bails out on a detached anchor). TableView instead
   * resolves a *persistent* anchor itself (the column's own .th-name
   * header button, which outlives this context menu) via its own ref map,
   * keyed by the target column id it already has. Unlike sort, this
   * filter *is* persistent state (TableView's numericFilters map) until
   * cleared — see NumericRangeFilterPopover's own doc comment for why
   * this is additive alongside sort, not a replacement for it. */
  onFilterRange: () => void;
  /** Opens ColumnColorFilterPopover — same anchor-resolution reasoning as
   * onFilterRange above (this menu's own buttons don't outlive onClose()).
   * Always shown for a single-column target, same as onFilterRange —
   * originally gated on "does this column actually have a colored cell
   * right now," which was reverted on explicit request: that gate made
   * the item appear/disappear per-column in a way that read as broken
   * ("кнопка фильтра вообще пропала") rather than as the intended "no
   * colors here yet" state. The popover itself still handles the "no
   * colors" case gracefully — see ColumnColorFilterPopover, which always
   * offers the "Numatytoji" (no color) swatch regardless. */
  onFilterColor: () => void;
  /** Opens ColumnReplyStatusFilterPopover — same anchor-resolution
   * reasoning as onFilterRange/onFilterColor above. Only offered for a
   * `note`-type column (see this menu's own render gate below): the
   * filter matches entries carrying NoteEntry.replyFields, which only a
   * note column's cells can ever hold. */
  onFilterReplyStatus: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onClose: () => void;
}

export function ColumnHeaderMenu({
  x,
  y,
  columns,
  targetIds,
  onSort,
  onFilterRange,
  onFilterColor,
  onFilterReplyStatus,
  onCopy,
  onPaste,
  onClose,
}: ColumnHeaderMenuProps) {
  const insertColumns = useTableStore((s) => s.insertColumns);
  const removeColumns = useTableStore((s) => s.removeColumns);
  const setColumnsHidden = useTableStore((s) => s.setColumnsHidden);
  const currentUser = useAuthStore((s) => s.user);
  const canDelete = currentUser?.role !== 'worker' || currentUser.permissions.canDeleteColumns;
  const canInsert = currentUser?.role !== 'worker' || currentUser.permissions.canInsertColumns;
  const canHide = currentUser?.role !== 'worker' || currentUser.permissions.canHideRowsColumns;

  const targetSet = new Set(targetIds);
  const indices = columns.reduce<number[]>((acc, c, i) => (targetSet.has(c.id) ? [...acc, i] : acc), []);
  const firstIndex = Math.min(...indices);
  const lastIndex = Math.max(...indices);
  const count = targetIds.length;
  // Only a `note` column's cells can ever hold a NoteEntry.replyFields
  // entry (see ColumnReplyStatusFilterPopover's own doc comment) — gating
  // here keeps the item from appearing on every other column type, where
  // it could never match anything.
  const isNoteColumn = count === 1 && columns[firstIndex]?.type === 'note';
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
      {canInsert && (
        <>
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
        </>
      )}
      {canHide && (
        <button type="button" className="context-menu-item" onClick={() => run(() => setColumnsHidden(targetIds, true))}>
          Slėpti {count > 1 ? 'stulpelius' : 'stulpelį'}{suffix}
        </button>
      )}
      <div className="context-menu-separator" />
      <button type="button" className="context-menu-item" onClick={() => run(onCopy)}>
        Kopijuoti {count > 1 ? 'stulpelius' : 'stulpelį'}{suffix}
      </button>
      <button type="button" className="context-menu-item" onClick={() => run(onPaste)}>
        Įklijuoti
      </button>
      {canDelete && (
        <>
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
        </>
      )}
      {count === 1 && (
        <>
          <div className="context-menu-separator" />
          <button type="button" className="context-menu-item" onClick={() => run(() => onSort('asc'))}>
            Rikiuoti A → Z
          </button>
          <button type="button" className="context-menu-item" onClick={() => run(() => onSort('desc'))}>
            Rikiuoti Z → A
          </button>
          <button type="button" className="context-menu-item" onClick={() => run(onFilterRange)}>
            <Hash className="icon" size={16} /> Filtruoti (nuo–iki)
          </button>
          <button type="button" className="context-menu-item" onClick={() => run(onFilterColor)}>
            <Palette className="icon" size={16} /> Filtruoti pagal spalvą
          </button>
          {isNoteColumn && (
            <button type="button" className="context-menu-item" onClick={() => run(onFilterReplyStatus)}>
              <Reply className="icon" size={16} /> Filtruoti pagal atsakymo statusą
            </button>
          )}
        </>
      )}
    </ContextMenu>
  );
}
