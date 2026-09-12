import { create } from 'zustand';
import type { Column, DemoTable, Row } from '../types';
import { buildSeedData } from '../data/seed';
import { randomUUID } from '../utils/uuid';

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

interface DemoTableState {
  tables: DemoTable[];
  activeTableId: string;
  rowsByTable: Record<string, Row[]>;

  setActiveTable: (id: string) => void;
  addRow: (tableId: string) => void;
  removeRows: (tableId: string, rowIds: string[]) => void;
  updateCell: (tableId: string, rowId: string, columnId: string, value: string) => void;
  setDropdownOptions: (tableId: string, columnId: string, options: string[]) => void;
  importRows: (tableId: string, columns: Column[], newRows: Array<Record<string, string>>) => void;
  /** Not exposed in the UI — kept only so a future "start over" affordance
   * has something to call. A page refresh already achieves the same
   * result via the module-reload behavior described above. */
  resetAll: () => void;
}

export const useDemoTableStore = create<DemoTableState>((set, get) => ({
  tables: seed.tables,
  activeTableId: seed.tables[0]?.id ?? '',
  rowsByTable: seed.rowsByTable,

  setActiveTable: (id) => set({ activeTableId: id }),

  addRow: (tableId) => {
    const rows = get().rowsByTable[tableId] ?? [];
    const maxOrder = rows.reduce((m, r) => Math.max(m, r.order), -1);
    const newRow: Row = { id: randomUUID(), tableId, cells: {}, order: maxOrder + 1 };
    set({ rowsByTable: { ...get().rowsByTable, [tableId]: [...rows, newRow] } });
  },

  removeRows: (tableId, rowIds) => {
    const idSet = new Set(rowIds);
    const rows = (get().rowsByTable[tableId] ?? []).filter((r) => !idSet.has(r.id));
    set({ rowsByTable: { ...get().rowsByTable, [tableId]: rows } });
  },

  updateCell: (tableId, rowId, columnId, value) => {
    const rows = (get().rowsByTable[tableId] ?? []).map((r) =>
      r.id === rowId ? { ...r, cells: { ...r.cells, [columnId]: value } } : r,
    );
    set({ rowsByTable: { ...get().rowsByTable, [tableId]: rows } });
  },

  setDropdownOptions: (tableId, columnId, options) => {
    const tables = get().tables.map((t) =>
      t.id === tableId ? { ...t, columns: t.columns.map((c) => (c.id === columnId ? { ...c, options } : c)) } : t,
    );
    set({ tables });
  },

  /** Extends the current table's columns with any newly-discovered CSV
   * headers (mirroring the production import's own "map to existing or
   * create new" idea, simplified to auto-create-as-text) and appends the
   * parsed rows — same "never leaves the tab" property as everything
   * else here, since `columns`/`newRows` were already parsed client-side
   * by DemoToolbar before this is called. */
  importRows: (tableId, columns, newRows) => {
    const table = get().tables.find((t) => t.id === tableId);
    if (!table) return;
    const existingRows = get().rowsByTable[tableId] ?? [];
    const maxOrder = existingRows.reduce((m, r) => Math.max(m, r.order), -1);
    const appended: Row[] = newRows.map((cells, i) => ({
      id: randomUUID(),
      tableId,
      cells,
      order: maxOrder + 1 + i,
    }));
    const tables = get().tables.map((t) => (t.id === tableId ? { ...t, columns } : t));
    set({
      tables,
      rowsByTable: { ...get().rowsByTable, [tableId]: [...existingRows, ...appended] },
    });
  },

  resetAll: () => {
    const fresh = buildSeedData();
    set({ tables: fresh.tables, activeTableId: fresh.tables[0]?.id ?? '', rowsByTable: fresh.rowsByTable });
  },
}));
