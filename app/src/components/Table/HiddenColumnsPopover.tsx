import type { Column } from '../../types';
import { useTableStore } from '../../store/useTableStore';
import { Popover } from '../Popover';

interface HiddenColumnsPopoverProps {
  anchor: HTMLElement;
  columns: Column[];
  onClose: () => void;
}

/** Hiding a column (ColumnHeaderMenu's "Hide column") has to come with a way
 * back, or it's a one-way trip — this is that way back. Only rendered by
 * TableView when at least one column has `hidden: true`. */
export function HiddenColumnsPopover({ anchor, columns, onClose }: HiddenColumnsPopoverProps) {
  const setColumnHidden = useTableStore((s) => s.setColumnHidden);
  const hidden = columns.filter((c) => c.hidden);

  return (
    <Popover anchor={anchor}>
      {hidden.length === 0 ? (
        <div className="popover-field">Nothing hidden</div>
      ) : (
        hidden.map((c) => (
          <div key={c.id} className="popover-field popover-checkbox" style={{ justifyContent: 'space-between' }}>
            <span>{c.name}</span>
            <button type="button" onClick={() => setColumnHidden(c.id, false)}>
              Show
            </button>
          </div>
        ))
      )}
      <div className="popover-footer">
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </Popover>
  );
}
