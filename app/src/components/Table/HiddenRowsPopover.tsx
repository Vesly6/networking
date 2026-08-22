import type { Column, Row } from '../../types';
import { useTableStore } from '../../store/useTableStore';
import { Popover } from '../Popover';
import { getPrimaryLabel } from '../../utils/row';

interface HiddenRowsPopoverProps {
  anchor: HTMLElement;
  rows: Row[];
  columns: Column[];
  onClose: () => void;
}

/** Mirrors HiddenColumnsPopover exactly, for rows — hiding a row
 * (RowHeaderMenu's "Slėpti eilutę") has to come with a way back, or it's
 * a one-way trip. Only rendered by TableView when at least one row has
 * `hidden: true`. */
export function HiddenRowsPopover({ anchor, rows, columns, onClose }: HiddenRowsPopoverProps) {
  const setRowsHidden = useTableStore((s) => s.setRowsHidden);
  const hidden = rows.filter((r) => r.hidden);

  return (
    <Popover anchor={anchor}>
      {hidden.length === 0 ? (
        <div className="popover-field">Nieko paslėpta</div>
      ) : (
        hidden.map((r) => (
          <div key={r.id} className="popover-field popover-checkbox" style={{ justifyContent: 'space-between' }}>
            <span>{getPrimaryLabel(r, columns) || '(be pavadinimo)'}</span>
            <button type="button" onClick={() => setRowsHidden([r.id], false)}>
              Rodyti
            </button>
          </div>
        ))
      )}
      <div className="popover-footer">
        <button type="button" onClick={onClose}>
          Uždaryti
        </button>
      </div>
    </Popover>
  );
}
