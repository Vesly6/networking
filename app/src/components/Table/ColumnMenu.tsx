import { useState } from 'react';
import type { Column, ColumnType } from '../../types';
import { useTableStore } from '../../store/useTableStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { useToastStore } from '../../store/useToastStore';
import { Popover } from '../Popover';
import { ColorInput } from '../ColorInput';
import { TYPE_LABELS } from '../../utils/columnTypeLabels';
import { contrastTextColor } from '../../utils/color';
import { parseTsv } from '../../utils/tsv';

interface ColumnMenuProps {
  column: Column;
  /** Every column in the table, in display order — needed only for
   * pasting a whole row of names at once (see the "Pavadinimas" input's
   * onPaste below), which renames this column plus however many follow
   * it, the same "starting at the anchor, row-major" convention the main
   * grid's own cell paste already uses. */
  columns: Column[];
  anchor: HTMLElement;
  onClose: () => void;
}

export function ColumnMenu({ column, columns, anchor, onClose }: ColumnMenuProps) {
  const renameColumn = useTableStore((s) => s.renameColumn);
  const showToast = useToastStore((s) => s.show);
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
        <span>Pavadinimas</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => renameColumn(column.id, name)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text/plain');
            // A single value pastes into just this field, normally (the
            // browser's own default single-input paste) — only a multi-
            // value clipboard (copied as a row of header cells from
            // Excel/Sheets) triggers the bulk rename below.
            const grid = parseTsv(text);
            const values = grid.flat();
            if (values.length <= 1) return;
            e.preventDefault();
            const startIndex = columns.findIndex((c) => c.id === column.id);
            if (startIndex === -1) return;
            let renamed = 0;
            let skipped = 0;
            values.forEach((value, i) => {
              const target = columns[startIndex + i];
              if (!target) {
                skipped++;
                return;
              }
              renameColumn(target.id, value);
              if (target.id === column.id) setName(value);
              renamed++;
            });
            const parts = [`Pervadinta stulpelių: ${renamed}`];
            if (skipped > 0) parts.push(`praleista (nebeliko stulpelių): ${skipped}`);
            showToast(parts.join(' · '));
          }}
        />
      </label>

      <label className="popover-field">
        <span>Tipas</span>
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
          <span>Sąrašo reikšmės</span>
          <div className="option-chips">
            {options.map((opt) => {
              const color = column.optionColors?.[opt];
              return (
                <span key={opt} className="chip" style={color ? { backgroundColor: color, color: contrastTextColor(color) } : undefined}>
                  <ColorInput
                    className="chip-color"
                    title="Pasirinkti spalvą"
                    value={color ?? '#e5e7eb'}
                    onCommit={(newColor) => setOptionColor(column.id, opt, newColor)}
                  />
                  {opt}
                  {color && (
                    <button
                      type="button"
                      className="chip-remove"
                      title="Išvalyti spalvą"
                      onClick={() => setOptionColor(column.id, opt, null)}
                    >
                      ⊘
                    </button>
                  )}
                  <button
                    type="button"
                    className="chip-remove"
                    title="Ištrinti reikšmę"
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
              placeholder="Nauja būsena…"
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
          <span>Naudoti kalendoriuje / užduočių sąraše</span>
        </label>
      )}

      <div className="popover-footer">
        <button
          type="button"
          className="danger"
          onClick={async () => {
            const ok = await confirmDialog({ message: `Ištrinti stulpelį „${column.name}“? Jo duomenys bus prarasti.`, danger: true });
            if (ok) {
              removeColumn(column.id);
              onClose();
            }
          }}
        >
          Ištrinti stulpelį
        </button>
        <button type="button" onClick={onClose}>
          Baigta
        </button>
      </div>
    </Popover>
  );
}
