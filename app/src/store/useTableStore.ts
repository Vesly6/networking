import { create } from 'zustand';
import type { Column, ColumnType, Row } from '../types';
import { clampToLimit } from '../utils/cellLimit';
import { deleteRowDB, getTable, loadRowsForTable, saveRow, saveRows, updateTableColumns } from '../db/db';

export interface ImportResult {
  createdRows: number;
  createdColumns: number;
  truncatedCells: number;
}

/** One decision per CSV header, resolved by the user in the import-mapping
 * modal before importCsvRows() runs — see CLAUDE.md's CSV import/export
 * section for why this replaced the old "always match by name, always
 * create unmatched headers as type: 'text'" behavior: a note/contact
 * column's raw JSON value only round-trips correctly if the destination
 * column already has the matching type, and the old auto-create path had
 * no way to know that. */
export type ImportColumnMapping =
  | { action: 'existing'; columnId: string }
  | { action: 'new'; columnType: ColumnType }
  | { action: 'skip' };

export interface CellUpdate {
  rowId: string;
  columnId: string;
  value: string;
}

export interface CellColorUpdate {
  rowId: string;
  columnId: string;
  color: string | null;
}

interface HistorySnapshot {
  columns: Column[];
  rows: Row[];
}

const MAX_HISTORY_DEPTH = 50;

interface TableState {
  tableId: string | null;
  columns: Column[];
  rows: Row[];
  ready: boolean;
  undoStack: HistorySnapshot[];
  redoStack: HistorySnapshot[];
  /** Always re-fetches the table fresh from IndexedDB rather than trusting a
   * cached copy from useWorkspaceStore — see CLAUDE.md for why. */
  loadTable: (tableId: string) => Promise<void>;
  unload: () => void;
  undo: () => void;
  redo: () => void;
  addColumn: (name: string, type: ColumnType, options?: string[]) => void;
  /** Inserts `count` new blank text columns immediately before `beforeColumnId`
   * (or at the end when null) — used by the header right-click menu's
   * "Insert N columns left/right". */
  insertColumns: (beforeColumnId: string | null, count: number) => void;
  renameColumn: (id: string, name: string) => void;
  removeColumn: (id: string) => void;
  removeColumns: (ids: string[]) => void;
  setColumnHidden: (id: string, hidden: boolean) => void;
  setColumnsHidden: (ids: string[], hidden: boolean) => void;
  setColumnType: (id: string, type: ColumnType) => void;
  setDropdownOptions: (id: string, options: string[]) => void;
  setOptionColor: (columnId: string, option: string, color: string | null) => void;
  setColumnWidth: (id: string, width: number) => void;
  setNextActionDateColumn: (id: string) => void;
  clearNextActionDateColumn: () => void;
  reorderColumns: (draggedId: string, targetId: string) => void;
  moveColumns: (draggedIds: string[], targetColumnId: string | null) => void;
  addRow: () => string;
  /** Inserts `count` new blank rows immediately before `beforeRowId` (or at
   * the end when null), reassigning `order` across every row exactly like
   * moveRows does — used by the row right-click menu's "Insert N rows
   * above/below". */
  insertRows: (beforeRowId: string | null, count: number) => void;
  removeRow: (id: string) => void;
  removeRows: (ids: string[]) => void;
  setRowHeight: (id: string, height: number) => void;
  /** null clears the link. See Row.linkedContactId in types.ts. */
  setLinkedContact: (rowId: string, contactId: string | null) => void;
  updateCell: (rowId: string, columnId: string, value: string) => boolean;
  updateCells: (updates: CellUpdate[]) => number;
  setCellColors: (updates: CellColorUpdate[]) => void;
  moveRows: (draggedIds: string[], targetRowId: string | null) => void;
  importCsvRows: (headers: string[], dataRows: string[][], mapping: Record<string, ImportColumnMapping>) => ImportResult;
}

function persistColumns(tableId: string | null, columns: Column[]) {
  if (!tableId) return;
  void updateTableColumns(tableId, columns);
}

/** "Stulpelis N" for a freshly inserted blank column — mirrors Excel's own
 * auto-naming for inserted columns, which get renamed via the existing
 * rename UI rather than prompted for a name up front. */
function nextColumnName(existing: Column[]): string {
  const names = new Set(existing.map((c) => c.name));
  let n = existing.length + 1;
  while (names.has(`Stulpelis ${n}`)) n++;
  return `Stulpelis ${n}`;
}

export const useTableStore = create<TableState>((set, get) => {
  /** Push the state as it was *before* the mutation about to run onto the
   * undo stack, and drop the redo stack (a fresh action invalidates "future"
   * history). Every action below always creates new `columns`/`rows`
   * arrays rather than mutating in place, so it's safe to keep bare
   * references here instead of deep-cloning. */
  const snapshot = () => {
    const { columns, rows, undoStack } = get();
    set({ undoStack: [...undoStack, { columns, rows }].slice(-MAX_HISTORY_DEPTH), redoStack: [] });
  };

  /** Undo/redo can restore rows that were deleted and must also delete rows
   * that were created since — a plain saveRows() only upserts, so diff
   * against what's disappearing too. */
  const syncRowsToDB = (previousRows: Row[], nextRows: Row[]) => {
    const nextIds = new Set(nextRows.map((r) => r.id));
    const removedIds = previousRows.filter((r) => !nextIds.has(r.id)).map((r) => r.id);
    void saveRows(nextRows);
    void Promise.all(removedIds.map((id) => deleteRowDB(id)));
  };

  return {
    tableId: null,
    columns: [],
    rows: [],
    ready: false,
    undoStack: [],
    redoStack: [],

    loadTable: async (tableId) => {
      set({ ready: false });
      const [table, rows] = await Promise.all([getTable(tableId), loadRowsForTable(tableId)]);
      if (!table) {
        set({ tableId: null, columns: [], rows: [], ready: true, undoStack: [], redoStack: [] });
        return;
      }
      rows.sort((a, b) => a.order - b.order);
      set({ tableId: table.id, columns: table.columns, rows, ready: true, undoStack: [], redoStack: [] });
    },

    unload: () => {
      set({ tableId: null, columns: [], rows: [], ready: false, undoStack: [], redoStack: [] });
    },

    undo: () => {
      const { undoStack, redoStack, columns, rows, tableId } = get();
      if (undoStack.length === 0) return;
      const prev = undoStack[undoStack.length - 1];
      set({
        columns: prev.columns,
        rows: prev.rows,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, { columns, rows }].slice(-MAX_HISTORY_DEPTH),
      });
      persistColumns(tableId, prev.columns);
      syncRowsToDB(rows, prev.rows);
    },

    redo: () => {
      const { undoStack, redoStack, columns, rows, tableId } = get();
      if (redoStack.length === 0) return;
      const next = redoStack[redoStack.length - 1];
      set({
        columns: next.columns,
        rows: next.rows,
        redoStack: redoStack.slice(0, -1),
        undoStack: [...undoStack, { columns, rows }].slice(-MAX_HISTORY_DEPTH),
      });
      persistColumns(tableId, next.columns);
      syncRowsToDB(rows, next.rows);
    },

    addColumn: (name, type, options) => {
      snapshot();
      const column: Column = {
        id: crypto.randomUUID(),
        name: name.trim() || 'Stulpelis',
        type,
        // The default column width (160px) is enough for a bare date, but
        // not for date + time + the contact-linking button + the clear
        // button all showing at once — confirmed directly: at 160px the
        // date itself could shrink to the point of being unreadable while
        // every *secondary* control around it stayed fully visible. A
        // wider starting point avoids that for any table's first date
        // column; existing narrower ones can still be drag-resized same
        // as any other column.
        ...(type === 'date' ? { width: 260 } : {}),
        ...(type === 'dropdown' ? { options: options ?? [] } : {}),
      };
      const columns = [...get().columns, column];
      set({ columns });
      persistColumns(get().tableId, columns);
    },

    insertColumns: (beforeColumnId, count) => {
      if (count <= 0) return;
      snapshot();
      const current = get().columns;
      const newColumns: Column[] = [];
      for (let i = 0; i < count; i++) {
        newColumns.push({ id: crypto.randomUUID(), name: nextColumnName([...current, ...newColumns]), type: 'text' });
      }
      const index = beforeColumnId === null ? -1 : current.findIndex((c) => c.id === beforeColumnId);
      const columns =
        index === -1
          ? [...current, ...newColumns]
          : [...current.slice(0, index), ...newColumns, ...current.slice(index)];
      set({ columns });
      persistColumns(get().tableId, columns);
    },

    renameColumn: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      snapshot();
      const columns = get().columns.map((c) => (c.id === id ? { ...c, name: trimmed } : c));
      set({ columns });
      persistColumns(get().tableId, columns);
    },

    removeColumn: (id) => {
      snapshot();
      const columns = get().columns.filter((c) => c.id !== id);
      const rows = get().rows.map((r) => {
        if (!(id in r.cells) && !r.colors?.[id]) return r;
        const cells = { ...r.cells };
        delete cells[id];
        const row = { ...r, cells };
        if (row.colors?.[id]) {
          const colors = { ...row.colors };
          delete colors[id];
          row.colors = colors;
        }
        return row;
      });
      set({ columns, rows });
      persistColumns(get().tableId, columns);
      void saveRows(rows);
    },

    removeColumns: (ids) => {
      if (ids.length === 0) return;
      snapshot();
      const idSet = new Set(ids);
      const columns = get().columns.filter((c) => !idSet.has(c.id));
      const rows = get().rows.map((r) => {
        const hasAny = ids.some((id) => id in r.cells || r.colors?.[id]);
        if (!hasAny) return r;
        const cells = { ...r.cells };
        const colors = r.colors ? { ...r.colors } : undefined;
        for (const id of ids) {
          delete cells[id];
          if (colors) delete colors[id];
        }
        return colors ? { ...r, cells, colors } : { ...r, cells };
      });
      set({ columns, rows });
      persistColumns(get().tableId, columns);
      void saveRows(rows);
    },

    setColumnHidden: (id, hidden) => {
      snapshot();
      const columns = get().columns.map((c) => (c.id === id ? { ...c, hidden } : c));
      set({ columns });
      persistColumns(get().tableId, columns);
    },

    setColumnsHidden: (ids, hidden) => {
      if (ids.length === 0) return;
      snapshot();
      const idSet = new Set(ids);
      const columns = get().columns.map((c) => (idSet.has(c.id) ? { ...c, hidden } : c));
      set({ columns });
      persistColumns(get().tableId, columns);
    },

    setColumnType: (id, type) => {
      snapshot();
      const columns = get().columns.map((c) => {
        if (c.id !== id) return c;
        const updated: Column = { ...c, type };
        if (type === 'dropdown') updated.options = c.options ?? [];
        else {
          delete updated.options;
          delete updated.optionColors;
        }
        if (type !== 'date') delete updated.isNextActionDate;
        return updated;
      });
      set({ columns });
      persistColumns(get().tableId, columns);
    },

    setDropdownOptions: (id, options) => {
      snapshot();
      const columns = get().columns.map((c) => (c.id === id ? { ...c, options } : c));
      set({ columns });
      persistColumns(get().tableId, columns);
    },

    setOptionColor: (columnId, option, color) => {
      snapshot();
      const columns = get().columns.map((c) => {
        if (c.id !== columnId) return c;
        const optionColors = { ...c.optionColors };
        if (color) optionColors[option] = color;
        else delete optionColors[option];
        return { ...c, optionColors };
      });
      set({ columns });
      persistColumns(get().tableId, columns);
    },

    setColumnWidth: (id, width) => {
      snapshot();
      const columns = get().columns.map((c) => (c.id === id ? { ...c, width } : c));
      set({ columns });
      persistColumns(get().tableId, columns);
    },

    setNextActionDateColumn: (id) => {
      snapshot();
      const columns = get().columns.map((c) => ({ ...c, isNextActionDate: c.id === id }));
      set({ columns });
      persistColumns(get().tableId, columns);
    },

    clearNextActionDateColumn: () => {
      snapshot();
      const columns = get().columns.map((c) => ({ ...c, isNextActionDate: false }));
      set({ columns });
      persistColumns(get().tableId, columns);
    },

    reorderColumns: (draggedId, targetId) => {
      get().moveColumns([draggedId], targetId);
    },

    moveColumns: (draggedIds, targetColumnId) => {
      if (draggedIds.length === 0) return;
      const draggedSet = new Set(draggedIds);
      if (targetColumnId !== null && draggedSet.has(targetColumnId)) return;
      snapshot();
      const current = get().columns;
      const dragged = current.filter((c) => draggedSet.has(c.id));
      const rest = current.filter((c) => !draggedSet.has(c.id));

      let reordered: Column[];
      if (targetColumnId === null) {
        reordered = [...rest, ...dragged];
      } else {
        const targetIndex = rest.findIndex((c) => c.id === targetColumnId);
        if (targetIndex === -1) return;
        reordered = [...rest.slice(0, targetIndex), ...dragged, ...rest.slice(targetIndex)];
      }

      set({ columns: reordered });
      persistColumns(get().tableId, reordered);
    },

    addRow: () => {
      const { tableId, rows } = get();
      if (!tableId) return '';
      snapshot();
      const id = crypto.randomUUID();
      const now = Date.now();
      const maxOrder = rows.reduce((m, r) => Math.max(m, r.order), -1);
      const row: Row = { id, tableId, cells: {}, order: maxOrder + 1, createdAt: now, updatedAt: now };
      set({ rows: [...rows, row] });
      void saveRow(row);
      return id;
    },

    insertRows: (beforeRowId, count) => {
      const { tableId } = get();
      if (!tableId || count <= 0) return;
      snapshot();
      const current = [...get().rows].sort((a, b) => a.order - b.order);
      const now = Date.now();
      const newRows: Row[] = Array.from({ length: count }, () => ({
        id: crypto.randomUUID(),
        tableId,
        cells: {},
        order: 0, // reassigned below, alongside every other row
        createdAt: now,
        updatedAt: now,
      }));
      const index = beforeRowId === null ? -1 : current.findIndex((r) => r.id === beforeRowId);
      const combined = index === -1 ? [...current, ...newRows] : [...current.slice(0, index), ...newRows, ...current.slice(index)];
      const updated = combined.map((r, i) => ({ ...r, order: i }));
      set({ rows: updated });
      void saveRows(updated);
    },

    removeRow: (id) => {
      snapshot();
      const rows = get().rows.filter((r) => r.id !== id);
      set({ rows });
      void deleteRowDB(id);
    },

    removeRows: (ids) => {
      snapshot();
      const idSet = new Set(ids);
      const rows = get().rows.filter((r) => !idSet.has(r.id));
      set({ rows });
      void Promise.all(ids.map((id) => deleteRowDB(id)));
    },

    setRowHeight: (id, height) => {
      snapshot();
      let updatedRow: Row | undefined;
      const rows = get().rows.map((r) => {
        if (r.id !== id) return r;
        updatedRow = { ...r, height, updatedAt: Date.now() };
        return updatedRow;
      });
      set({ rows });
      if (updatedRow) void saveRow(updatedRow);
    },

    setLinkedContact: (rowId, contactId) => {
      snapshot();
      let updatedRow: Row | undefined;
      const rows = get().rows.map((r) => {
        if (r.id !== rowId) return r;
        updatedRow = { ...r, linkedContactId: contactId ?? undefined, updatedAt: Date.now() };
        return updatedRow;
      });
      set({ rows });
      if (updatedRow) void saveRow(updatedRow);
    },

    updateCell: (rowId, columnId, value) => {
      snapshot();
      const { value: clamped, truncated } = clampToLimit(value);
      let updatedRow: Row | undefined;
      const rows = get().rows.map((r) => {
        if (r.id !== rowId) return r;
        updatedRow = { ...r, cells: { ...r.cells, [columnId]: clamped }, updatedAt: Date.now() };
        return updatedRow;
      });
      set({ rows });
      if (updatedRow) void saveRow(updatedRow);
      return truncated;
    },

    updateCells: (updates) => {
      if (updates.length === 0) return 0;
      snapshot();
      const byRow = new Map<string, CellUpdate[]>();
      for (const u of updates) {
        const list = byRow.get(u.rowId) ?? [];
        list.push(u);
        byRow.set(u.rowId, list);
      }
      let truncatedCount = 0;
      const now = Date.now();
      const changedRows: Row[] = [];
      const rows = get().rows.map((r) => {
        const rowUpdates = byRow.get(r.id);
        if (!rowUpdates) return r;
        const cells = { ...r.cells };
        for (const u of rowUpdates) {
          const { value, truncated } = clampToLimit(u.value);
          if (truncated) truncatedCount++;
          cells[u.columnId] = value;
        }
        const updated = { ...r, cells, updatedAt: now };
        changedRows.push(updated);
        return updated;
      });
      set({ rows });
      void saveRows(changedRows);
      return truncatedCount;
    },

    setCellColors: (updates) => {
      if (updates.length === 0) return;
      snapshot();
      const byRow = new Map<string, CellColorUpdate[]>();
      for (const u of updates) {
        const list = byRow.get(u.rowId) ?? [];
        list.push(u);
        byRow.set(u.rowId, list);
      }
      const changedRows: Row[] = [];
      const rows = get().rows.map((r) => {
        const rowUpdates = byRow.get(r.id);
        if (!rowUpdates) return r;
        const colors = { ...r.colors };
        for (const u of rowUpdates) {
          if (u.color) colors[u.columnId] = u.color;
          else delete colors[u.columnId];
        }
        const updated = { ...r, colors, updatedAt: Date.now() };
        changedRows.push(updated);
        return updated;
      });
      set({ rows });
      void saveRows(changedRows);
    },

    moveRows: (draggedIds, targetRowId) => {
      if (draggedIds.length === 0) return;
      const draggedSet = new Set(draggedIds);
      if (targetRowId !== null && draggedSet.has(targetRowId)) return;
      snapshot();
      const current = [...get().rows].sort((a, b) => a.order - b.order);
      const dragged = current.filter((r) => draggedSet.has(r.id));
      const rest = current.filter((r) => !draggedSet.has(r.id));

      let reordered: Row[];
      if (targetRowId === null) {
        reordered = [...rest, ...dragged];
      } else {
        const targetIndex = rest.findIndex((r) => r.id === targetRowId);
        if (targetIndex === -1) return;
        reordered = [...rest.slice(0, targetIndex), ...dragged, ...rest.slice(targetIndex)];
      }

      const now = Date.now();
      const updated = reordered.map((r, i) => ({ ...r, order: i, updatedAt: now }));
      set({ rows: updated });
      void saveRows(updated);
    },

    importCsvRows: (headers, dataRows, mapping) => {
      const state = get();
      if (!state.tableId) return { createdRows: 0, createdColumns: 0, truncatedCells: 0 };
      snapshot();
      const columns = [...state.columns];
      let createdColumns = 0;

      // headerToColumnId has no entry for a 'skip' header — that's the
      // signal below to drop that CSV column entirely rather than write it
      // into some fallback column.
      const headerToColumnId = new Map<string, string>();
      for (const header of headers) {
        const decision = mapping[header];
        if (!decision || decision.action === 'skip') continue;
        if (decision.action === 'existing') {
          headerToColumnId.set(header, decision.columnId);
          continue;
        }
        const column: Column = { id: crypto.randomUUID(), name: header.trim() || 'Stulpelis', type: decision.columnType };
        columns.push(column);
        createdColumns++;
        headerToColumnId.set(header, column.id);
      }

      let truncatedCells = 0;
      const now = Date.now();
      let nextOrder = state.rows.reduce((m, r) => Math.max(m, r.order), -1) + 1;
      const newRows: Row[] = dataRows
        .filter((dataRow) => dataRow.some((cell) => cell && cell.trim() !== ''))
        .map((dataRow) => {
          const cells: Record<string, string> = {};
          headers.forEach((header, i) => {
            const columnId = headerToColumnId.get(header);
            if (!columnId) return;
            const raw = dataRow[i] ?? '';
            const { value, truncated } = clampToLimit(raw);
            if (truncated) truncatedCells++;
            cells[columnId] = value;
          });
          return { id: crypto.randomUUID(), tableId: state.tableId!, cells, order: nextOrder++, createdAt: now, updatedAt: now };
        });

      const rows = [...state.rows, ...newRows];
      set({ columns, rows });
      persistColumns(state.tableId, columns);
      void saveRows(newRows);

      return { createdRows: newRows.length, createdColumns, truncatedCells };
    },
  };
});
