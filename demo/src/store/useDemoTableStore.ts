import { create } from 'zustand';
import type { Column, ColumnType, DemoTable, Row } from '../types';
import { buildSeedData } from '../data/seed';
import { randomUUID } from '../utils/uuid';
import { PRESET_COLORS } from '../constants';

/** One decision per CSV header, resolved in the import-mapping modal
 * before importCsvRows() runs — mirrors production's own
 * ImportColumnMapping (useTableStore.ts) exactly. */
export type ImportColumnMapping = { action: 'existing'; columnId: string } | { action: 'new'; columnType: ColumnType } | { action: 'skip' };

export interface ImportResult {
  createdRows: number;
  createdColumns: number;
}

// A column mistakenly typed 'dropdown' against near-unique free text
// shouldn't spray dozens of one-off "options" into the column — same cap
// production's own importCsvRows uses.
const MAX_AUTO_DROPDOWN_OPTIONS = 30;

// Deliberately a *plain* Zustand store — no persist middleware, no
// localStorage/sessionStorage/IndexedDB read or write anywhere in this
// file. buildSeedData() runs exactly once, right here, at module-load
// time (i.e. every time this script is freshly loaded: a hard refresh, a
// new tab, a different browser, the next day). That single fact is what
// makes "every visitor always starts from the same clean demo dataset,
// and nothing one visitor does is ever visible to another" true without
// any explicit reset logic — there is simply nowhere for a change to be
// written that would outlive this page load.
const seed = buildSeedData();

const MAX_HISTORY_DEPTH = 50;

interface HistorySnapshot {
  columns: Column[];
  rows: Row[];
}

interface DemoTableState {
  tables: DemoTable[];
  activeTableId: string;
  rowsByTable: Record<string, Row[]>;
  /** Per-table undo/redo, same snapshot-stack shape as production's
   * useTableStore.ts — keyed by tableId since (unlike production, which
   * only ever holds one table's rows/columns in memory at a time) this
   * store holds every demo table simultaneously. */
  undoStackByTable: Record<string, HistorySnapshot[]>;
  redoStackByTable: Record<string, HistorySnapshot[]>;

  setActiveTable: (id: string) => void;
  addRow: (tableId: string) => void;
  removeRows: (tableId: string, rowIds: string[]) => void;
  updateCell: (tableId: string, rowId: string, columnId: string, value: string) => void;
  setDropdownOptions: (tableId: string, columnId: string, options: string[]) => void;
  importCsvRows: (tableId: string, headers: string[], dataRows: string[][], mapping: Record<string, ImportColumnMapping>) => ImportResult;
  /** Inserts one blank text column before `beforeColumnId` (end of the
   * table when null) — mirrors production's insertColumns (useTableStore.ts). */
  insertColumns: (tableId: string, beforeColumnId: string | null, count: number) => void;
  removeColumns: (tableId: string, columnIds: string[]) => void;
  setCellColor: (tableId: string, rowId: string, columnId: string, color: string | null) => void;
  /** At most one per table, same rule as production's own
   * isNextActionDate — setting a new one clears any previous one on the
   * same table. */
  setNextActionDateColumn: (tableId: string, columnId: string) => void;
  clearNextActionDateColumn: (tableId: string) => void;
  undo: (tableId: string) => void;
  redo: (tableId: string) => void;
  /** Workspace-screen table management — mirrors production's
   * createTable/renameTable/deleteTable (useWorkspaceStore.ts), minus the
   * server round-trip: a new table is plain, zero-column, matching
   * production's own "new tables start with zero columns" rule. Not part
   * of the undo/redo stack above, same scoping as production (that stack
   * only ever covers one open table's own columns/rows). */
  createTable: (name: string) => string;
  renameTable: (tableId: string, name: string) => void;
  deleteTable: (tableId: string) => void;
  /** Not exposed in the UI — kept only so a future "start over" affordance
   * has something to call. A page refresh already achieves the same
   * result via the module-reload behavior described above. */
  resetAll: () => void;
}

function nextColumnName(existing: Column[]): string {
  const names = new Set(existing.map((c) => c.name));
  let n = existing.length + 1;
  while (names.has(`Column ${n}`)) n++;
  return `Column ${n}`;
}

export const useDemoTableStore = create<DemoTableState>((set, get) => {
  /** Pushes {columns, rows} for one table onto its own undo stack, before
   * a mutation — same "cheap, no deep clone" reasoning as production's
   * own snapshot(): every mutating action already produces fresh
   * columns/rows arrays rather than mutating in place. */
  const snapshot = (tableId: string) => {
    const table = get().tables.find((t) => t.id === tableId);
    if (!table) return;
    const rows = get().rowsByTable[tableId] ?? [];
    const stack = get().undoStackByTable[tableId] ?? [];
    set({
      undoStackByTable: { ...get().undoStackByTable, [tableId]: [...stack, { columns: table.columns, rows }].slice(-MAX_HISTORY_DEPTH) },
      redoStackByTable: { ...get().redoStackByTable, [tableId]: [] },
    });
  };

  return {
    tables: seed.tables,
    activeTableId: seed.tables[0]?.id ?? '',
    rowsByTable: seed.rowsByTable,
    undoStackByTable: {},
    redoStackByTable: {},

    setActiveTable: (id) => set({ activeTableId: id }),

    addRow: (tableId) => {
      snapshot(tableId);
      const rows = get().rowsByTable[tableId] ?? [];
      const maxOrder = rows.reduce((m, r) => Math.max(m, r.order), -1);
      const newRow: Row = { id: randomUUID(), tableId, cells: {}, order: maxOrder + 1 };
      set({ rowsByTable: { ...get().rowsByTable, [tableId]: [...rows, newRow] } });
    },

    removeRows: (tableId, rowIds) => {
      snapshot(tableId);
      const idSet = new Set(rowIds);
      const rows = (get().rowsByTable[tableId] ?? []).filter((r) => !idSet.has(r.id));
      set({ rowsByTable: { ...get().rowsByTable, [tableId]: rows } });
    },

    updateCell: (tableId, rowId, columnId, value) => {
      snapshot(tableId);
      const rows = (get().rowsByTable[tableId] ?? []).map((r) =>
        r.id === rowId ? { ...r, cells: { ...r.cells, [columnId]: value } } : r,
      );
      set({ rowsByTable: { ...get().rowsByTable, [tableId]: rows } });
    },

    setDropdownOptions: (tableId, columnId, options) => {
      snapshot(tableId);
      const tables = get().tables.map((t) =>
        t.id === tableId ? { ...t, columns: t.columns.map((c) => (c.id === columnId ? { ...c, options } : c)) } : t,
      );
      set({ tables });
    },

    /** Executes a per-header mapping already resolved by
     * DemoCsvImportMapping — mirrors production's own importCsvRows
     * (useTableStore.ts) exactly, minus the batching/progress-bar
     * machinery that exists there only because a real 14,000-row import
     * needs it; demo tables are small enough to build and commit in one
     * pass. A 'new' decision seeds a dropdown column's options/colors from
     * the data's own distinct values, same as production. */
    importCsvRows: (tableId, headers, dataRows, mapping) => {
      const table = get().tables.find((t) => t.id === tableId);
      if (!table) return { createdRows: 0, createdColumns: 0 };
      snapshot(tableId);

      const columns = [...table.columns];
      let createdColumns = 0;
      const headerToColumnId = new Map<string, string>();
      headers.forEach((header, headerIndex) => {
        const decision = mapping[header];
        if (!decision || decision.action === 'skip') return;
        if (decision.action === 'existing') {
          headerToColumnId.set(header, decision.columnId);
          return;
        }
        const column: Column = { id: randomUUID(), name: header.trim() || 'Column', type: decision.columnType };
        if (decision.columnType === 'dropdown') {
          const seen = new Set<string>();
          const distinct: string[] = [];
          for (const dataRow of dataRows) {
            const raw = (dataRow[headerIndex] ?? '').trim();
            if (!raw || seen.has(raw)) continue;
            seen.add(raw);
            distinct.push(raw);
            if (distinct.length >= MAX_AUTO_DROPDOWN_OPTIONS) break;
          }
          if (distinct.length > 0) {
            column.options = distinct;
            column.optionColors = Object.fromEntries(distinct.map((opt, i) => [opt, PRESET_COLORS[i % PRESET_COLORS.length]]));
          }
        }
        columns.push(column);
        createdColumns++;
        headerToColumnId.set(header, column.id);
      });

      const existingRows = get().rowsByTable[tableId] ?? [];
      let nextOrder = existingRows.reduce((m, r) => Math.max(m, r.order), -1) + 1;
      const nonEmptyDataRows = dataRows.filter((dataRow) => dataRow.some((cell) => cell && cell.trim() !== ''));
      const appended: Row[] = nonEmptyDataRows.map((dataRow) => {
        const cells: Record<string, string> = {};
        headers.forEach((header, i) => {
          const columnId = headerToColumnId.get(header);
          if (columnId) cells[columnId] = dataRow[i] ?? '';
        });
        return { id: randomUUID(), tableId, cells, order: nextOrder++ };
      });

      set({
        tables: get().tables.map((t) => (t.id === tableId ? { ...t, columns } : t)),
        rowsByTable: { ...get().rowsByTable, [tableId]: [...existingRows, ...appended] },
      });
      return { createdRows: appended.length, createdColumns };
    },

    insertColumns: (tableId, beforeColumnId, count) => {
      if (count <= 0) return;
      const table = get().tables.find((t) => t.id === tableId);
      if (!table) return;
      snapshot(tableId);
      const newColumns: Column[] = [];
      for (let i = 0; i < count; i++) {
        newColumns.push({ id: randomUUID(), name: nextColumnName([...table.columns, ...newColumns]), type: 'text' });
      }
      const index = beforeColumnId === null ? -1 : table.columns.findIndex((c) => c.id === beforeColumnId);
      const columns =
        index === -1 ? [...table.columns, ...newColumns] : [...table.columns.slice(0, index), ...newColumns, ...table.columns.slice(index)];
      set({ tables: get().tables.map((t) => (t.id === tableId ? { ...t, columns } : t)) });
    },

    removeColumns: (tableId, columnIds) => {
      if (columnIds.length === 0) return;
      const table = get().tables.find((t) => t.id === tableId);
      if (!table) return;
      snapshot(tableId);
      const idSet = new Set(columnIds);
      const columns = table.columns.filter((c) => !idSet.has(c.id));
      const rows = (get().rowsByTable[tableId] ?? []).map((r) => {
        const hasAny = columnIds.some((id) => id in r.cells || r.colors?.[id]);
        if (!hasAny) return r;
        const cells = { ...r.cells };
        const colors = r.colors ? { ...r.colors } : undefined;
        columnIds.forEach((id) => {
          delete cells[id];
          if (colors) delete colors[id];
        });
        return { ...r, cells, colors };
      });
      set({
        tables: get().tables.map((t) => (t.id === tableId ? { ...t, columns } : t)),
        rowsByTable: { ...get().rowsByTable, [tableId]: rows },
      });
    },

    setCellColor: (tableId, rowId, columnId, color) => {
      snapshot(tableId);
      const rows = (get().rowsByTable[tableId] ?? []).map((r) => {
        if (r.id !== rowId) return r;
        const colors = { ...r.colors };
        if (color) colors[columnId] = color;
        else delete colors[columnId];
        return { ...r, colors };
      });
      set({ rowsByTable: { ...get().rowsByTable, [tableId]: rows } });
    },

    setNextActionDateColumn: (tableId, columnId) => {
      const table = get().tables.find((t) => t.id === tableId);
      if (!table) return;
      snapshot(tableId);
      const columns = table.columns.map((c) => ({ ...c, isNextActionDate: c.id === columnId }));
      set({ tables: get().tables.map((t) => (t.id === tableId ? { ...t, columns } : t)) });
    },

    clearNextActionDateColumn: (tableId) => {
      const table = get().tables.find((t) => t.id === tableId);
      if (!table) return;
      snapshot(tableId);
      const columns = table.columns.map((c) => (c.isNextActionDate ? { ...c, isNextActionDate: false } : c));
      set({ tables: get().tables.map((t) => (t.id === tableId ? { ...t, columns } : t)) });
    },

    undo: (tableId) => {
      const undoStack = get().undoStackByTable[tableId] ?? [];
      if (undoStack.length === 0) return;
      const table = get().tables.find((t) => t.id === tableId);
      if (!table) return;
      const prev = undoStack[undoStack.length - 1];
      const redoStack = get().redoStackByTable[tableId] ?? [];
      const currentRows = get().rowsByTable[tableId] ?? [];
      set({
        tables: get().tables.map((t) => (t.id === tableId ? { ...t, columns: prev.columns } : t)),
        rowsByTable: { ...get().rowsByTable, [tableId]: prev.rows },
        undoStackByTable: { ...get().undoStackByTable, [tableId]: undoStack.slice(0, -1) },
        redoStackByTable: {
          ...get().redoStackByTable,
          [tableId]: [...redoStack, { columns: table.columns, rows: currentRows }].slice(-MAX_HISTORY_DEPTH),
        },
      });
    },

    redo: (tableId) => {
      const redoStack = get().redoStackByTable[tableId] ?? [];
      if (redoStack.length === 0) return;
      const table = get().tables.find((t) => t.id === tableId);
      if (!table) return;
      const next = redoStack[redoStack.length - 1];
      const undoStack = get().undoStackByTable[tableId] ?? [];
      const currentRows = get().rowsByTable[tableId] ?? [];
      set({
        tables: get().tables.map((t) => (t.id === tableId ? { ...t, columns: next.columns } : t)),
        rowsByTable: { ...get().rowsByTable, [tableId]: next.rows },
        redoStackByTable: { ...get().redoStackByTable, [tableId]: redoStack.slice(0, -1) },
        undoStackByTable: {
          ...get().undoStackByTable,
          [tableId]: [...undoStack, { columns: table.columns, rows: currentRows }].slice(-MAX_HISTORY_DEPTH),
        },
      });
    },

    createTable: (name) => {
      const id = randomUUID();
      const table: DemoTable = { id, name, columns: [] };
      set({ tables: [...get().tables, table], rowsByTable: { ...get().rowsByTable, [id]: [] }, activeTableId: id });
      return id;
    },

    renameTable: (tableId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      set({ tables: get().tables.map((t) => (t.id === tableId ? { ...t, name: trimmed } : t)) });
    },

    deleteTable: (tableId) => {
      const remaining = get().tables.filter((t) => t.id !== tableId);
      const rowsByTable = { ...get().rowsByTable };
      delete rowsByTable[tableId];
      const nextActive = get().activeTableId === tableId ? (remaining[0]?.id ?? '') : get().activeTableId;
      set({ tables: remaining, rowsByTable, activeTableId: nextActive });
    },

    resetAll: () => {
      const fresh = buildSeedData();
      set({
        tables: fresh.tables,
        activeTableId: fresh.tables[0]?.id ?? '',
        rowsByTable: fresh.rowsByTable,
        undoStackByTable: {},
        redoStackByTable: {},
      });
    },
  };
});
