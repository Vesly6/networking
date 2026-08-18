import { useState } from 'react';
import type { ColumnType } from '../../types';
import { useTableStore } from '../../store/useTableStore';
import { Popover } from '../Popover';
import { TYPE_LABELS } from '../../utils/columnTypeLabels';

interface AddColumnPopoverProps {
  anchor: HTMLElement;
  onClose: () => void;
}

export function AddColumnPopover({ anchor, onClose }: AddColumnPopoverProps) {
  const addColumn = useTableStore((s) => s.addColumn);
  const [name, setName] = useState('');
  const [type, setType] = useState<ColumnType>('text');
  const [optionsText, setOptionsText] = useState('');

  const submit = () => {
    if (!name.trim()) return;
    const options =
      type === 'dropdown'
        ? optionsText
            .split(',')
            .map((o) => o.trim())
            .filter(Boolean)
        : undefined;
    addColumn(name, type, options);
    onClose();
  };

  return (
    <Popover anchor={anchor}>
      <label className="popover-field">
        <span>Stulpelio pavadinimas</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onClose();
          }}
        />
      </label>
      <label className="popover-field">
        <span>Tipas</span>
        <select value={type} onChange={(e) => setType(e.target.value as ColumnType)}>
          {(Object.keys(TYPE_LABELS) as ColumnType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      {type === 'dropdown' && (
        <label className="popover-field">
          <span>Sąrašo reikšmės (atskirtos kableliais)</span>
          <input
            placeholder="neatsakė, perskambinti, atsisakė"
            value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)}
          />
        </label>
      )}
      <div className="popover-footer">
        <button type="button" onClick={onClose}>
          Atšaukti
        </button>
        <button type="button" className="primary" onClick={submit} disabled={!name.trim()}>
          Pridėti
        </button>
      </div>
    </Popover>
  );
}
