import { useRef } from 'react';
import type { Column } from '../types';
import { parseCsvFile, sniffColumnType, exportRowsToCsv, downloadCsv, sanitizeFilename } from '../utils/csv';
import { randomUUID } from '../utils/uuid';
import { useDemoTableStore } from '../store/useDemoTableStore';
import { Search, Plus, Trash2, Upload, Download } from 'lucide-react';

interface DemoToolbarProps {
  tableId: string;
  tableName: string;
  columns: Column[];
  rows: import('../types').Row[];
  query: string;
  onQueryChange: (q: string) => void;
  selectedRowIds: string[];
  onClearSelection: () => void;
}

/** Search/add-row/delete-selected/import/export — all client-side, all
 * scoped to this one demo table's in-memory rows. Import maps a CSV
 * header to an existing column by case-insensitive name match, creating
 * a new text/note/contact-typed column (via the same sniffColumnType
 * heuristic the real import mapping defaults to) for anything unmatched
 * — a simplified, no-modal version of the production CsvImportMapping
 * flow, appropriate for a demo where there's no risk of silently
 * corrupting a real column's data. */
export function DemoToolbar({ tableId, tableName, columns, rows, query, onQueryChange, selectedRowIds, onClearSelection }: DemoToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addRow = useDemoTableStore((s) => s.addRow);
  const removeRows = useDemoTableStore((s) => s.removeRows);
  const importRows = useDemoTableStore((s) => s.importRows);

  const handleExport = () => {
    const csv = exportRowsToCsv(columns, rows);
    downloadCsv(`${sanitizeFilename(tableName)}.csv`, csv);
  };

  const handleImportFile = async (file: File) => {
    const { headers, rows: dataRows } = await parseCsvFile(file);
    if (headers.length === 0) return;

    const nextColumns = [...columns];
    const headerToColumnId = headers.map((header) => {
      const existing = nextColumns.find((c) => c.name.trim().toLowerCase() === header.trim().toLowerCase());
      if (existing) return existing.id;
      const sampleValues = dataRows.slice(0, 8).map((r) => r[headers.indexOf(header)] ?? '');
      const newColumn: Column = { id: randomUUID(), name: header, type: sniffColumnType(sampleValues) };
      nextColumns.push(newColumn);
      return newColumn.id;
    });

    const newRows = dataRows.map((values) => {
      const cells: Record<string, string> = {};
      headerToColumnId.forEach((colId, i) => {
        cells[colId] = values[i] ?? '';
      });
      return cells;
    });

    importRows(tableId, nextColumns, newRows);
  };

  return (
    <div className="demo-toolbar">
      <div className="demo-toolbar-search">
        <Search size={14} />
        <input placeholder="Search…" value={query} onChange={(e) => onQueryChange(e.target.value)} />
      </div>
      <button type="button" onClick={() => addRow(tableId)}>
        <Plus size={14} /> Add row
      </button>
      {selectedRowIds.length > 0 && (
        <button
          type="button"
          className="danger"
          onClick={() => {
            removeRows(tableId, selectedRowIds);
            onClearSelection();
          }}
        >
          <Trash2 size={14} /> Delete ({selectedRowIds.length})
        </button>
      )}
      <div className="demo-toolbar-spacer" />
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleImportFile(file);
          e.target.value = '';
        }}
      />
      <button type="button" onClick={() => fileInputRef.current?.click()}>
        <Upload size={14} /> Import CSV
      </button>
      <button type="button" onClick={handleExport}>
        <Download size={14} /> Export CSV
      </button>
    </div>
  );
}
