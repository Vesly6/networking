import { useEffect, useMemo, useRef, useState } from 'react';
import type { DemoTable } from '../types';
import { useDemoTableStore } from '../store/useDemoTableStore';
import { DemoDataCell } from './DemoDataCell';
import { DemoToolbar } from './DemoToolbar';
import { DemoFormulaBar } from './DemoFormulaBar';
import { DemoColumnHeaderMenu } from './DemoColumnHeaderMenu';
import { DemoRowHeaderMenu } from './DemoRowHeaderMenu';
import { Popover } from './Popover';
import { ColorInput } from './ColorInput';
import { parseCellRef, formatCellRef } from '../utils/spreadsheet';
import { getColumnByType } from '../utils/row';
import { PRESET_COLORS } from '../constants';
import { ChevronUp, ChevronDown, MoreVertical } from 'lucide-react';

interface DemoTableViewProps {
  table: DemoTable;
  /** Set by App.tsx when the Calendar tab's "Open in table" jumps here —
   * scrolls the target row into view and briefly flash-highlights it,
   * same idea as production's own focusRowId/onFocusHandled plumbing
   * between Calendar and TableView. */
  focusRowId?: string | null;
  onFocusHandled?: () => void;
}

type SortState = { columnId: string; direction: 'asc' | 'desc' } | null;

/** A right-sized rebuild of the real TableView.tsx's core spreadsheet
 * interactions (search, sort, single-cell edit, row select+delete,
 * import/export, and — as of this pass — the Name Box, Formula Bar,
 * Undo/Redo, cell color fill, and the right-click column header menu) for
 * the demo's own, much smaller feature scope. Deliberately still not
 * ported: virtualization (demo tables are in the low hundreds of rows,
 * not tens of thousands — production's own reason for virtualizing
 * doesn't apply here), multi-cell range selection/copy-paste, and
 * multi-column selection in the header menu (single-column
 * insert/delete/sort only) — see DemoColumnHeaderMenu's own doc comment. */
export function DemoTableView({ table, focusRowId, onFocusHandled }: DemoTableViewProps) {
  const rows = useDemoTableStore((s) => s.rowsByTable[table.id] ?? []);
  const updateCell = useDemoTableStore((s) => s.updateCell);
  const undo = useDemoTableStore((s) => s.undo);
  const redo = useDemoTableStore((s) => s.redo);
  const canUndo = useDemoTableStore((s) => (s.undoStackByTable[table.id]?.length ?? 0) > 0);
  const canRedo = useDemoTableStore((s) => (s.redoStackByTable[table.id]?.length ?? 0) > 0);
  const setCellColor = useDemoTableStore((s) => s.setCellColor);
  const setLinkedContact = useDemoTableStore((s) => s.setLinkedContact);
  const setNextActionNote = useDemoTableStore((s) => s.setNextActionNote);

  const contactColumn = useMemo(() => getColumnByType(table.columns, 'contact'), [table.columns]);
  const companyColumn = useMemo(() => getColumnByType(table.columns, 'company'), [table.columns]);

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortState>(null);
  const [activeCell, setActiveCell] = useState<{ rowId: string; columnId: string } | null>(null);
  // Which cell's expanded editor (contact list / note history) is open —
  // keyed by {rowId, columnId}, not just row, matching production's own
  // expandedCell shape (a row with more than one contact/note column
  // would otherwise show the same "open" popover under every one of
  // them).
  const [expandedCell, setExpandedCell] = useState<{ rowId: string; columnId: string } | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [columnMenu, setColumnMenu] = useState<{ x: number; y: number; columnId: string } | null>(null);
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; rowId: string } | null>(null);
  const [colorPickerAnchor, setColorPickerAnchor] = useState<HTMLElement | null>(null);
  const [flashRowId, setFlashRowId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const filteredSortedRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = rows;
    if (q) {
      list = list.filter((r) => Object.values(r.cells).some((v) => v.toLowerCase().includes(q)));
    }
    if (sort) {
      const { columnId, direction } = sort;
      list = [...list].sort((a, b) => {
        const av = a.cells[columnId] ?? '';
        const bv = b.cells[columnId] ?? '';
        const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
        return direction === 'asc' ? cmp : -cmp;
      });
    } else {
      list = [...list].sort((a, b) => a.order - b.order);
    }
    return list;
  }, [rows, query, sort]);

  const toggleSort = (columnId: string) => {
    setSort((prev) => {
      if (!prev || prev.columnId !== columnId) return { columnId, direction: 'asc' };
      if (prev.direction === 'asc') return { columnId, direction: 'desc' };
      return null;
    });
  };

  const toggleRowSelected = (rowId: string) => {
    setSelectedRowIds((prev) => (prev.includes(rowId) ? prev.filter((id) => id !== rowId) : [...prev, rowId]));
  };

  // --- Name Box (Excel's top-left "C13" reference box) — same idea as
  // production's own (utils/spreadsheet.ts), simplified to a single-cell
  // jump rather than a full A1:D10 range, since this demo has no
  // multi-cell range-selection system to jump a *range* into. ---
  const [nameBoxDraft, setNameBoxDraft] = useState('');
  const nameBoxFocusedRef = useRef(false);
  useEffect(() => {
    if (nameBoxFocusedRef.current) return;
    if (!activeCell) {
      setNameBoxDraft('');
      return;
    }
    const r = filteredSortedRows.findIndex((row) => row.id === activeCell.rowId);
    const c = table.columns.findIndex((col) => col.id === activeCell.columnId);
    setNameBoxDraft(r !== -1 && c !== -1 ? formatCellRef({ r, c }) : '');
  }, [activeCell, filteredSortedRows, table.columns]);

  const submitNameBox = () => {
    const parsed = parseCellRef(nameBoxDraft);
    if (!parsed || table.columns.length === 0) {
      setNameBoxDraft(activeCell ? nameBoxDraft : '');
      return;
    }
    const r = Math.min(Math.max(0, parsed.r), Math.max(0, filteredSortedRows.length - 1));
    const c = Math.min(Math.max(0, parsed.c), Math.max(0, table.columns.length - 1));
    const row = filteredSortedRows[r];
    const col = table.columns[c];
    if (row && col) setActiveCell({ rowId: row.id, columnId: col.id });
  };

  const applyColor = (color: string | null) => {
    if (!activeCell) return;
    setCellColor(table.id, activeCell.rowId, activeCell.columnId, color);
    setColorPickerAnchor(null);
  };

  // Not virtualized (see this component's own doc comment), so a plain
  // querySelector + scrollIntoView is enough — no need for a virtualizer
  // API to scroll to an unmounted row the way production's TableView.tsx
  // needs.
  useEffect(() => {
    if (!focusRowId) return;
    const el = scrollRef.current?.querySelector(`tr[data-row-id="${focusRowId}"]`);
    el?.scrollIntoView({ block: 'center' });
    setFlashRowId(focusRowId);
    onFocusHandled?.();
    const timeout = setTimeout(() => setFlashRowId(null), 1500);
    return () => clearTimeout(timeout);
  }, [focusRowId, onFocusHandled]);

  return (
    <div className="demo-table-view">
      <DemoToolbar
        tableId={table.id}
        tableName={table.name}
        columns={table.columns}
        rows={rows}
        query={query}
        onQueryChange={setQuery}
        selectedRowIds={selectedRowIds}
        onClearSelection={() => setSelectedRowIds([])}
        nameBoxValue={nameBoxDraft}
        onNameBoxChange={setNameBoxDraft}
        onNameBoxFocus={() => (nameBoxFocusedRef.current = true)}
        onNameBoxBlur={() => {
          nameBoxFocusedRef.current = false;
          submitNameBox();
        }}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={() => undo(table.id)}
        onRedo={() => redo(table.id)}
        colorDisabled={!activeCell}
        onOpenColorPicker={(anchor) => setColorPickerAnchor((prev) => (prev ? null : anchor))}
      />
      {colorPickerAnchor && (
        <Popover anchor={colorPickerAnchor} width={200}>
          <div className="color-palette-label">Fill color</div>
          <div className="color-palette">
            {PRESET_COLORS.map((c) => (
              <button key={c} type="button" className="color-swatch" style={{ background: c }} onClick={() => applyColor(c)} />
            ))}
            <label className="color-swatch color-swatch-custom" title="Custom color">
              +
              <ColorInput onCommit={applyColor} />
            </label>
          </div>
          <button type="button" className="color-clear-btn" onClick={() => applyColor(null)}>
            Clear color
          </button>
        </Popover>
      )}
      <DemoFormulaBar tableId={table.id} selection={activeCell} columns={table.columns} rows={rows} />
      <div
        className="demo-table-scroll"
        ref={scrollRef}
        onClick={() => {
          setColumnMenu(null);
          setRowMenu(null);
        }}
      >
        <table className="demo-sheet">
          <colgroup>
            <col className="demo-col-gutter" />
            {table.columns.map((col) => (
              <col key={col.id} className={col.type === 'date' ? 'demo-col-date' : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="demo-row-gutter" />
              {table.columns.map((col) => (
                <th
                  key={col.id}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setColumnMenu({ x: e.clientX, y: e.clientY, columnId: col.id });
                  }}
                  className="demo-th-sortable"
                >
                  <div className="demo-th-content">
                    <button type="button" className="demo-th-name" onClick={() => toggleSort(col.id)}>
                      {col.name}
                      {sort?.columnId === col.id && (sort.direction === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                    </button>
                    <button
                      type="button"
                      className="demo-th-menu-btn"
                      title="Column options"
                      onClick={(e) => {
                        e.stopPropagation();
                        setColumnMenu({ x: e.clientX, y: e.clientY, columnId: col.id });
                      }}
                    >
                      <MoreVertical size={14} />
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredSortedRows.map((row, rowIndex) => (
              <tr
                key={row.id}
                data-row-id={row.id}
                className={`${selectedRowIds.includes(row.id) ? 'demo-row-selected' : ''} ${flashRowId === row.id ? 'demo-row-flash' : ''}`}
              >
                <td
                  className="demo-row-gutter"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setRowMenu({ x: e.clientX, y: e.clientY, rowId: row.id });
                  }}
                >
                  <button type="button" className="demo-row-number" onClick={() => toggleRowSelected(row.id)}>
                    {rowIndex + 1}
                  </button>
                </td>
                {table.columns.map((col) => (
                  <DemoDataCell
                    key={col.id}
                    row={row}
                    column={col}
                    editable={activeCell?.rowId === row.id && activeCell.columnId === col.id}
                    highlightQuery={query}
                    onSelect={(e) => {
                      // preventDefault matters here, not just convention:
                      // this mousedown swaps the clicked <button> for a
                      // live, auto-focused <input> synchronously, within
                      // this same event — without preventDefault, the
                      // browser's own default mousedown-focus handling
                      // (which still targets the now-removed button)
                      // runs right after and steals focus back to
                      // document.body, firing a spurious blur that
                      // immediately re-collapses the cell before a real
                      // user ever gets a chance to type. Confirmed live.
                      e.preventDefault();
                      setActiveCell({ rowId: row.id, columnId: col.id });
                    }}
                    onCommit={(value) => {
                      updateCell(table.id, row.id, col.id, value);
                      // Deliberately does NOT clear activeCell — matches
                      // production's own model (a cell stays the
                      // selection, and the Formula Bar keeps reflecting
                      // it, until a *different* cell is clicked), rather
                      // than snapping back to "nothing selected" on every
                      // Enter/blur.
                    }}
                    onOpenEditor={() => setExpandedCell({ rowId: row.id, columnId: col.id })}
                    editorOpen={expandedCell?.rowId === row.id && expandedCell?.columnId === col.id}
                    onCloseEditor={() => setExpandedCell(null)}
                    contactsRaw={contactColumn ? row.cells[contactColumn.id] : undefined}
                    companyName={companyColumn ? row.cells[companyColumn.id] : undefined}
                    onSetLinkedContact={(contactId) => setLinkedContact(table.id, row.id, contactId)}
                    onSetNextActionNote={(note) => setNextActionNote(table.id, row.id, note)}
                  />
                ))}
              </tr>
            ))}
            {filteredSortedRows.length === 0 && (
              <tr>
                <td colSpan={table.columns.length + 1} className="demo-empty-state">
                  No rows match "{query}"
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {columnMenu && (
        <DemoColumnHeaderMenu
          tableId={table.id}
          x={columnMenu.x}
          y={columnMenu.y}
          columns={table.columns}
          columnId={columnMenu.columnId}
          onSort={(direction) => setSort({ columnId: columnMenu.columnId, direction })}
          onClose={() => setColumnMenu(null)}
        />
      )}
      {rowMenu && (
        <DemoRowHeaderMenu tableId={table.id} x={rowMenu.x} y={rowMenu.y} rows={rows} rowId={rowMenu.rowId} onClose={() => setRowMenu(null)} />
      )}
    </div>
  );
}
