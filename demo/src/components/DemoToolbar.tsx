import { useRef } from 'react';
import type { Column } from '../types';
import { parseCsvFile, sniffColumnType, exportRowsToCsv, downloadCsv, sanitizeFilename } from '../utils/csv';
import { randomUUID } from '../utils/uuid';
import { useDemoTableStore } from '../store/useDemoTableStore';
import { useToastStore } from '../store/useToastStore';
import { confirmDialog } from '../store/useConfirmStore';
import { Search, Plus, Trash2, Upload, Download, Undo2, Redo2 } from 'lucide-react';

interface DemoToolbarProps {
  tableId: string;
  tableName: string;
  columns: Column[];
  rows: import('../types').Row[];
  query: string;
  onQueryChange: (q: string) => void;
  selectedRowIds: string[];
  onClearSelection: () => void;
  nameBoxValue: string;
  onNameBoxChange: (v: string) => void;
  onNameBoxFocus: () => void;
  onNameBoxBlur: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  colorDisabled: boolean;
  onOpenColorPicker: (anchor: HTMLElement) => void;
}

/** Search/add-row/delete-selected/import/export — all client-side, all
 * scoped to this one demo table's in-memory rows. Import maps a CSV
 * header to an existing column by case-insensitive name match, creating
 * a new text/note/contact-typed column (via the same sniffColumnType
 * heuristic the real import mapping defaults to) for anything unmatched
 * — a simplified, no-modal version of the production CsvImportMapping
 * flow, appropriate for a demo where there's no risk of silently
 * corrupting a real column's data. Every action now gives the same kind
 * of feedback production does — a toast, and (for the one destructive
 * action here) a confirm step first. */
export function DemoToolbar({
  tableId,
  tableName,
  columns,
  rows,
  query,
  onQueryChange,
  selectedRowIds,
  onClearSelection,
  nameBoxValue,
  onNameBoxChange,
  onNameBoxFocus,
  onNameBoxBlur,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  colorDisabled,
  onOpenColorPicker,
}: DemoToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addRow = useDemoTableStore((s) => s.addRow);
  const removeRows = useDemoTableStore((s) => s.removeRows);
  const importRows = useDemoTableStore((s) => s.importRows);
  const showToast = useToastStore((s) => s.show);

  const handleExport = () => {
    const csv = exportRowsToCsv(columns, rows);
    downloadCsv(`${sanitizeFilename(tableName)}.csv`, csv);
    showToast('Exported to CSV');
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
    showToast(`Imported ${newRows.length} row${newRows.length === 1 ? '' : 's'}`);
  };

  const handleDeleteSelected = async () => {
    const ok = await confirmDialog({
      message: `Delete ${selectedRowIds.length} selected row${selectedRowIds.length === 1 ? '' : 's'}? This can't be undone.`,
      danger: true,
    });
    if (!ok) return;
    const count = selectedRowIds.length;
    removeRows(tableId, selectedRowIds);
    onClearSelection();
    showToast(`Deleted ${count} row${count === 1 ? '' : 's'}`);
  };

  return (
    <div className="demo-toolbar">
      <input
        className="name-box"
        value={nameBoxValue}
        onChange={(e) => onNameBoxChange(e.target.value)}
        onFocus={onNameBoxFocus}
        onBlur={onNameBoxBlur}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        placeholder="A1"
        title="Type a cell reference (e.g. C13) and press Enter"
      />
      <div className="demo-toolbar-search">
        <Search size={14} />
        <input placeholder="Search…" value={query} onChange={(e) => onQueryChange(e.target.value)} />
      </div>
      <button type="button" title="Undo" disabled={!canUndo} onClick={onUndo}>
        <Undo2 size={14} />
      </button>
      <button type="button" title="Redo" disabled={!canRedo} onClick={onRedo}>
        <Redo2 size={14} />
      </button>
      <button
        type="button"
        disabled={colorDisabled}
        onClick={(e) => {
          e.stopPropagation();
          onOpenColorPicker(e.currentTarget);
        }}
      >
        Color
      </button>
      <button
        type="button"
        onClick={() => {
          addRow(tableId);
          showToast('Row added');
        }}
      >
        <Plus size={14} /> Add row
      </button>
      {selectedRowIds.length > 0 && (
        <button type="button" className="danger" onClick={() => void handleDeleteSelected()}>
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
