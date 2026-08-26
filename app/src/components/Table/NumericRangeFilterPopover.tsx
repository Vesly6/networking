import { useState } from 'react';
import type { NumericRangeFilter } from '../../utils/numericFilter';
import { Popover } from '../Popover';

interface NumericRangeFilterPopoverProps {
  anchor: HTMLElement;
  columnName: string;
  current: NumericRangeFilter | undefined;
  onApply: (filter: NumericRangeFilter) => void;
  onClear: () => void;
  onClose: () => void;
}

/** Additive alongside the column header menu's existing A→Z/Z→A sort —
 * that sort compares cell values as plain text (String.localeCompare, see
 * TableView's commitSort), which is exactly right for a name/company
 * column but produces "1, 10, 100, 1000, 11, 12..." on a numeric-looking
 * one like "Darbuotojai"/"Apyvarta" — a real, reported problem. This
 * doesn't touch sorting at all; it's a genuinely different operation
 * (hiding rows outside a range, not reordering them), opened as a third
 * item in ColumnHeaderMenu right next to the two sort buttons. Only one
 * column's filter is edited at a time here, but TableView tracks them as
 * a map (numericFilters), so filters on several columns can be active
 * together, same as a real spreadsheet's per-column filters. */
export function NumericRangeFilterPopover({ anchor, columnName, current, onApply, onClear, onClose }: NumericRangeFilterPopoverProps) {
  const [min, setMin] = useState(current?.min !== undefined ? String(current.min) : '');
  const [max, setMax] = useState(current?.max !== undefined ? String(current.max) : '');

  const submit = () => {
    const minNum = min.trim() ? Number(min) : undefined;
    const maxNum = max.trim() ? Number(max) : undefined;
    if (minNum === undefined && maxNum === undefined) {
      onClear();
    } else {
      onApply({ min: minNum, max: maxNum });
    }
    onClose();
  };

  return (
    <Popover anchor={anchor}>
      <div className="popover-field-label">Filtruoti „{columnName}“ (skaičius)</div>
      <label className="popover-field">
        <span>Nuo</span>
        <input
          type="number"
          autoFocus
          value={min}
          onChange={(e) => setMin(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onClose();
          }}
        />
      </label>
      <label className="popover-field">
        <span>Iki</span>
        <input
          type="number"
          value={max}
          onChange={(e) => setMax(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onClose();
          }}
        />
      </label>
      <div className="popover-footer">
        <button
          type="button"
          onClick={() => {
            onClear();
            onClose();
          }}
        >
          Išvalyti
        </button>
        <button type="button" className="primary" onClick={submit}>
          Taikyti
        </button>
      </div>
    </Popover>
  );
}
