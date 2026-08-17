import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Column, ColumnType } from '../../types';
import type { ImportColumnMapping } from '../../store/useTableStore';
import { sniffColumnType } from '../../utils/csv';
import { TYPE_LABELS } from '../../utils/columnTypeLabels';

const SKIP = '__skip__';
const NEW = '__new__';

interface CsvImportMappingProps {
  headers: string[];
  dataRows: string[][];
  columns: Column[];
  onConfirm: (mapping: Record<string, ImportColumnMapping>) => void;
  onCancel: () => void;
}

function buildDefaultMapping(headers: string[], dataRows: string[][], columns: Column[]): Record<string, ImportColumnMapping> {
  const mapping: Record<string, ImportColumnMapping> = {};
  headers.forEach((header, i) => {
    const key = header.trim().toLowerCase();
    const match = columns.find((c) => c.name.trim().toLowerCase() === key);
    if (match) {
      mapping[header] = { action: 'existing', columnId: match.id };
      return;
    }
    const samples = dataRows.slice(0, 50).map((row) => row[i] ?? '');
    mapping[header] = { action: 'new', columnType: sniffColumnType(samples) };
  });
  return mapping;
}

/** Shown after a CSV file is parsed and before any row is written — lets the
 * user decide, per CSV header, whether it lands in an existing column, a
 * brand-new column (with an explicit type), or is skipped entirely. Replaces
 * the old behavior of always matching by name and always creating an
 * unmatched header as type 'text', which is what caused a re-imported
 * Note/Contact column's raw JSON to show up as literal garbled text — see
 * CLAUDE.md's CSV import/export section. */
export function CsvImportMapping({ headers, dataRows, columns, onConfirm, onCancel }: CsvImportMappingProps) {
  const [mapping, setMapping] = useState(() => buildDefaultMapping(headers, dataRows, columns));

  const setAction = (header: string, value: string) => {
    setMapping((prev) => {
      if (value === SKIP) return { ...prev, [header]: { action: 'skip' } };
      if (value === NEW) {
        const prevType = prev[header]?.action === 'new' ? prev[header].columnType : 'text';
        return { ...prev, [header]: { action: 'new', columnType: prevType } };
      }
      return { ...prev, [header]: { action: 'existing', columnId: value } };
    });
  };

  const setNewType = (header: string, columnType: ColumnType) => {
    setMapping((prev) => ({ ...prev, [header]: { action: 'new', columnType } }));
  };

  const selectValue = (header: string): string => {
    const decision = mapping[header];
    if (!decision || decision.action === 'skip') return SKIP;
    if (decision.action === 'new') return NEW;
    return decision.columnId;
  };

  const skippedCount = headers.filter((h) => mapping[h]?.action === 'skip').length;
  const newCount = headers.filter((h) => mapping[h]?.action === 'new').length;

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal csv-import-mapping" onClick={(e) => e.stopPropagation()}>
        <h2>Import CSV — map columns</h2>
        <p className="csv-import-mapping-hint">
          Choose where each CSV column goes. A column that doesn't match anything existing defaults to a guess based on
          its actual data — check it before importing, especially for Notes/Contacts.
        </p>
        <div className="csv-import-mapping-list">
          {headers.map((header) => {
            const decision = mapping[header];
            return (
              <div className="csv-import-mapping-row" key={header}>
                <span className="csv-import-mapping-header" title={header}>
                  {header || '(blank header)'}
                </span>
                <select value={selectValue(header)} onChange={(e) => setAction(header, e.target.value)}>
                  <option value={SKIP}>Skip this column</option>
                  <option value={NEW}>+ Create new column</option>
                  {columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      Match: {c.name} ({TYPE_LABELS[c.type]})
                    </option>
                  ))}
                </select>
                {decision?.action === 'new' && (
                  <select value={decision.columnType} onChange={(e) => setNewType(header, e.target.value as ColumnType)}>
                    {(Object.keys(TYPE_LABELS) as ColumnType[]).map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABELS[t]}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>
        <div className="csv-import-mapping-summary">
          {newCount} new column{newCount === 1 ? '' : 's'} · {skippedCount} skipped
        </div>
        <div className="popover-footer">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => onConfirm(mapping)}>
            Import
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
