import { useState } from 'react';
import type { Column, ColumnType } from '../../types';
import { useTableStore } from '../../store/useTableStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { Popover } from '../Popover';
import { ColorInput } from '../ColorInput';
import { TYPE_LABELS } from '../../utils/columnTypeLabels';

interface ColumnMenuProps {
  column: Column;
  anchor: HTMLElement;
  onClose: () => void;
}

export function ColumnMenu({ column, anchor, onClose }: ColumnMenuProps) {
  const renameColumn = useTableStore((s) => s.renameColumn);
  const removeColumn = useTableStore((s) => s.removeColumn);
  const setColumnType = useTableStore((s) => s.setColumnType);
  const setDropdownOptions = useTableStore((s) => s.setDropdownOptions);
  const setOptionColor = useTableStore((s) => s.setOptionColor);
  const setNextActionDateColumn = useTableStore((s) => s.setNextActionDateColumn);
  const clearNextActionDateColumn = useTableStore((s) => s.clearNextActionDateColumn);

  const [name, setName] = useState(column.name);
  const [newOption, setNewOption] = useState('');

  const options = column.options ?? [];

  return (
    <Popover anchor={anchor}>
      <label className="popover-field">
        <span>Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => renameColumn(column.id, name)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
      </label>

      <label className="popover-field">
        <span>Type</span>
        <select value={column.type} onChange={(e) => setColumnType(column.id, e.target.value as ColumnType)}>
          {(Object.keys(TYPE_LABELS) as ColumnType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>

      {column.type === 'dropdown' && (
        <div className="popover-field">
          <span>List values</span>
          <div className="option-chips">
            {options.map((opt) => {
              const color = column.optionColors?.[opt];
              return (
                <span key={opt} className="chip" style={color ? { backgroundColor: color } : undefined}>
                  <ColorInput
                    className="chip-color"
                    title="Pick a color"
                    value={color ?? '#e5e7eb'}
                    onCommit={(newColor) => setOptionColor(column.id, opt, newColor)}
                  />
                  {opt}
                  {color && (
                    <button
                      type="button"
                      className="chip-remove"
                      title="Clear color"
                      onClick={() => setOptionColor(column.id, opt, null)}
                    >
                      ⊘
                    </button>
                  )}
                  <button
                    type="button"
                    className="chip-remove"
                    title="Delete value"
                    onClick={() => setDropdownOptions(column.id, options.filter((o) => o !== opt))}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
          <div className="option-add-row">
            <input
              placeholder="New status…"
              value={newOption}
              onChange={(e) => setNewOption(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newOption.trim()) {
                  setDropdownOptions(column.id, [...options, newOption.trim()]);
                  setNewOption('');
                }
              }}
            />
            <button
              type="button"
              onClick={() => {
                if (newOption.trim()) {
                  setDropdownOptions(column.id, [...options, newOption.trim()]);
                  setNewOption('');
                }
              }}
            >
              +
            </button>
          </div>
        </div>
      )}

      {column.type === 'date' && (
        <label className="popover-field popover-checkbox">
          <input
            type="checkbox"
            checked={!!column.isNextActionDate}
            onChange={(e) =>
              e.target.checked ? setNextActionDateColumn(column.id) : clearNextActionDateColumn()
            }
          />
          <span>Use in calendar / task list</span>
        </label>
      )}

      <div className="popover-footer">
        <button
          type="button"
          className="danger"
          onClick={async () => {
            const ok = await confirmDialog({ message: `Delete column "${column.name}"? Its data will be lost.`, danger: true });
            if (ok) {
              removeColumn(column.id);
              onClose();
            }
          }}
        >
          Delete column
        </button>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </div>
    </Popover>
  );
}
