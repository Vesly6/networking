import { useState } from 'react';
import type { Column, ColumnType } from '../types';
import type { ImportColumnMapping } from '../store/useDemoTableStore';
import { sniffColumnType } from '../utils/csv';
import { TYPE_LABELS } from '../utils/columnTypeLabels';

const SKIP = '__skip__';
const NEW = '__new__';

interface DemoCsvImportMappingProps {
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

/** Adapted from production's CsvImportMapping.tsx — shown after a CSV
 * file is parsed and before any row is written, replacing the demo's old
 * silent auto-mapping (which always matched by name and always created
 * an unmatched header as plain text — exactly the class of surprise the
 * real modal exists to prevent, per the parity audit). Reuses the same
 * .modal/.modal-backdrop chrome the demo's confirm dialog already uses,
 * rather than a portal — this demo has no sticky-header/overflow
 * container this content could get clipped by, so the extra portal
 * plumbing production's version needs isn't necessary here. */
export function DemoCsvImportMapping({ headers, dataRows, columns, onConfirm, onCancel }: DemoCsvImportMappingProps) {
  const [mapping, setMapping] = useState(() => buildDefaultMapping(headers, dataRows, columns));

  const setAction = (header: string, value: string) => {
    setMapping((prev) => {
      if (value === SKIP) return { ...prev, [header]: { action: 'skip' } };
      if (value === NEW) {
        const prevDecision = prev[header];
        const prevType = prevDecision?.action === 'new' ? prevDecision.columnType : 'text';
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

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal csv-import-mapping" onClick={(e) => e.stopPropagation()}>
        <h2>CSV import — map columns</h2>
        <p className="csv-import-mapping-hint">
          Choose where each CSV column goes. A header that doesn't match an existing column defaults to a guess based
          on its data — review before importing.
        </p>
        <div className="csv-import-mapping-list">
          {headers.map((header) => {
            const decision = mapping[header];
            return (
              <div className="csv-import-mapping-row" key={header}>
                <span className="csv-import-mapping-header" title={header}>
                  {header || '(empty header)'}
                </span>
                <select value={selectValue(header)} onChange={(e) => setAction(header, e.target.value)}>
                  <option value={SKIP}>Skip this column</option>
                  <option value={NEW}>+ Create new column</option>
                  {columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      Map to: {c.name} ({TYPE_LABELS[c.type]})
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
          New columns: {newCount} · Skipped: {skippedCount}
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
    </div>
  );
}
