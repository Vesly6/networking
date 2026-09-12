import { useRef, useState } from 'react';
import type { Column } from '../types';
import { parseCsvFile, exportRowsToCsv, downloadCsv, sanitizeFilename } from '../utils/csv';
import { useDemoTableStore, type ImportColumnMapping } from '../store/useDemoTableStore';
import { useToastStore } from '../store/useToastStore';
import { confirmDialog } from '../store/useConfirmStore';
import { DemoCsvImportMapping } from './DemoCsvImportMapping';
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
 * scoped to this one demo table's in-memory rows. CSV import now goes
 * through the same explicit per-header mapping review production's
 * CsvImportMapping.tsx requires, replacing this toolbar's old silent
 * auto-mapping (which always matched by name and always created an
 * unmatched header as plain text — the exact class of surprise the real
 * modal exists to prevent, per the parity audit). Every action gives the
 * same kind of feedback production does — a toast, and (for destructive
 * actions) a confirm step first. */
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
  const importCsvRows = useDemoTableStore((s) => s.importCsvRows);
  const showToast = useToastStore((s) => s.show);

  const [pendingImport, setPendingImport] = useState<{ headers: string[]; dataRows: string[][] } | null>(null);

  const handleExport = () => {
    const csv = exportRowsToCsv(columns, rows);
    downloadCsv(`${sanitizeFilename(tableName)}.csv`, csv);
    showToast('Exported to CSV');
  };

  const handleImportFile = async (file: File) => {
    const { headers, rows: dataRows } = await parseCsvFile(file);
    if (headers.length === 0) return;
    setPendingImport({ headers, dataRows });
  };

  const handleConfirmImport = (mapping: Record<string, ImportColumnMapping>) => {
    if (!pendingImport) return;
    const { createdRows, createdColumns } = importCsvRows(tableId, pendingImport.headers, pendingImport.dataRows, mapping);
    setPendingImport(null);
    showToast(
      `Imported ${createdRows} row${createdRows === 1 ? '' : 's'}${createdColumns > 0 ? `, added ${createdColumns} column${createdColumns === 1 ? '' : 's'}` : ''}`,
    );
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
      {pendingImport && (
        <DemoCsvImportMapping
          headers={pendingImport.headers}
          dataRows={pendingImport.dataRows}
          columns={columns}
          onConfirm={handleConfirmImport}
          onCancel={() => setPendingImport(null)}
        />
      )}
    </div>
  );
}
