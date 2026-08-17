import { create } from 'zustand';
import type { TableMeta } from '../types';
import { deleteTableDB, loadTables, saveTable, updateTableName } from '../db/db';

const LAST_ACTIVE_KEY = 'cold-crm:last-active-table';

interface WorkspaceState {
  tables: TableMeta[];
  activeTableId: string | null;
  ready: boolean;
  init: () => Promise<void>;
  createTable: (name: string) => string;
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
        name: 'Table 1',
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
      name: name.trim() || `Table ${get().tables.length + 1}`,
      columns: [],
      createdAt: now,
      updatedAt: now,
    };
    set({ tables: [...get().tables, table] });
    void saveTable(table);
    return table.id;
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
