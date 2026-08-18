import { create } from 'zustand';
import type { Row, TableMeta } from '../types';
import { deleteTableDB, getTable, loadRowsForTable, loadTables, saveRows, saveTable, updateTableName } from '../db/db';

const LAST_ACTIVE_KEY = 'cold-crm:last-active-table';

interface WorkspaceState {
  tables: TableMeta[];
  activeTableId: string | null;
  ready: boolean;
  init: () => Promise<void>;
  createTable: (name: string) => string;
  /** Clones a table's columns and every row (fresh ids throughout, cell
   * keys remapped to the new column ids) into a brand-new table — used by
   * SheetTabs' right-click "Duplicate". Async because it has to read the
   * source table's rows from IndexedDB first (useWorkspaceStore only
   * holds TableMeta — columns — in memory, never rows). Returns null if
   * the source table id isn't found. */
  duplicateTable: (id: string) => Promise<string | null>;
  renameTable: (id: string, name: string) => void;
  deleteTable: (id: string) => void;
  setActiveTable: (id: string | null) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  tables: [],
  activeTableId: null,
  ready: false,

  init: async () => {
    let tables = await loadTables();
    if (tables.length === 0) {
      const now = Date.now();
      const table: TableMeta = {
        id: crypto.randomUUID(),
        name: 'Lentelė 1',
        columns: [],
        createdAt: now,
        updatedAt: now,
      };
      await saveTable(table);
      tables = [table];
    }
    tables = [...tables].sort((a, b) => a.createdAt - b.createdAt);
    const savedActiveId = localStorage.getItem(LAST_ACTIVE_KEY);
    const activeTableId = tables.some((t) => t.id === savedActiveId) ? savedActiveId : null;
    set({ tables, activeTableId, ready: true });
  },

  createTable: (name) => {
    const now = Date.now();
    const table: TableMeta = {
      id: crypto.randomUUID(),
      name: name.trim() || `Lentelė ${get().tables.length + 1}`,
      columns: [],
      createdAt: now,
      updatedAt: now,
    };
    set({ tables: [...get().tables, table] });
    void saveTable(table);
    return table.id;
  },

  duplicateTable: async (id) => {
    // Re-read fresh from IndexedDB rather than trusting get().tables' cached
    // TableMeta — that snapshot is only as current as whenever the
    // workspace list itself last loaded, and never updated when
    // useTableStore edits columns (only the IndexedDB record is; see
    // loadTable's own doc comment for the same rule). Reading the cached
    // copy here reproduced that exact class of bug: duplicating a table
    // right after adding a column to it copied zero columns, because
    // get().tables still held the table's columns as they were before
    // that edit.
    const source = await getTable(id);
    if (!source) return null;

    const columnIdMap = new Map<string, string>();
    const columns = source.columns.map((c) => {
      const newId = crypto.randomUUID();
      columnIdMap.set(c.id, newId);
      return { ...c, id: newId };
    });

    const now = Date.now();
    const newTable: TableMeta = {
      id: crypto.randomUUID(),
      name: `${source.name} (kopija)`,
      columns,
      createdAt: now,
      updatedAt: now,
    };

    const sourceRows = await loadRowsForTable(id);
    const newRows: Row[] = sourceRows.map((r) => {
      const cells: Record<string, string> = {};
      for (const [oldColId, value] of Object.entries(r.cells)) {
        const newColId = columnIdMap.get(oldColId);
        if (newColId) cells[newColId] = value;
      }
      let colors: Record<string, string> | undefined;
      if (r.colors) {
        colors = {};
        for (const [oldColId, color] of Object.entries(r.colors)) {
          const newColId = columnIdMap.get(oldColId);
          if (newColId) colors[newColId] = color;
        }
      }
      return { id: crypto.randomUUID(), tableId: newTable.id, cells, colors, order: r.order, height: r.height, createdAt: now, updatedAt: now };
    });

    // Both awaited (not the usual fire-and-forget void saveX(...) pattern
    // elsewhere in this store) — the caller switches to viewing this new
    // table right after this resolves (SheetTabs' "Duplicate table"), and
    // loadTable() does a one-shot fresh read from IndexedDB with no retry.
    // Returning before the writes land would make the new table briefly
    // (or, if the write loses the race, indefinitely) look empty.
    await saveTable(newTable);
    await saveRows(newRows);
    set({ tables: [...get().tables, newTable] });
    return newTable.id;
  },

  renameTable: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const tables = get().tables.map((t) => (t.id === id ? { ...t, name: trimmed, updatedAt: Date.now() } : t));
    set({ tables });
    void updateTableName(id, trimmed);
  },

  deleteTable: (id) => {
    const wasActive = get().activeTableId === id;
    const tables = get().tables.filter((t) => t.id !== id);
    set({ tables, activeTableId: wasActive ? null : get().activeTableId });
    if (wasActive) localStorage.removeItem(LAST_ACTIVE_KEY);
    void deleteTableDB(id);
  },

  setActiveTable: (id) => {
    set({ activeTableId: id });
    if (id) localStorage.setItem(LAST_ACTIVE_KEY, id);
    else localStorage.removeItem(LAST_ACTIVE_KEY);
  },
}));
