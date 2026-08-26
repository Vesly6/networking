import { create } from 'zustand';
import type { Column, Row, TableMeta } from '../types';
import { deleteTableDB, getTable, loadRowsForTable, loadTables, saveRows, saveTable, updateTableName } from '../db/db';
import { randomUUID } from '../utils/uuid';

const LAST_ACTIVE_KEY = 'cold-crm:last-active-table';

// Every newly created table — the very first one on a fresh install, "+
// Nauja lentelė", and SheetTabs' own "+" — starts pre-populated with this
// many blank columns/rows, on explicit request. A deliberate reversal of
// this app's earlier "new tables start with zero columns, no default seed
// schema" design (see CLAUDE.md's own section on this). The concrete
// problem that prompted it: copying a large block of rows out of an
// existing table and pasting them into a brand-new one failed outright,
// because the new table had no columns/rows yet to paste into — forcing a
// detour through manually inventing column names first before the actual
// paste could even be attempted. Explicitly not meant to be a fixed
// schema ("это не приговор" — "this isn't a life sentence"): every seeded
// column is a plain, freely renamable/retypable/deletable `text` column,
// same as one added by hand, and an unused blank row behaves exactly like
// any other blank row already does everywhere else in this app (CSV
// export, search, copy/paste) — nothing about blank rows or generically-
// named columns needed special-casing to make this safe.
const DEFAULT_SEED_ROW_COUNT = 1000;
const DEFAULT_SEED_COLUMN_COUNT = 50;

function buildSeedColumns(): Column[] {
  return Array.from({ length: DEFAULT_SEED_COLUMN_COUNT }, (_, i) => ({
    id: randomUUID(),
    name: `Stulpelis ${i + 1}`,
    type: 'text' as const,
  }));
}

function buildSeedRows(tableId: string): Row[] {
  const now = Date.now();
  return Array.from({ length: DEFAULT_SEED_ROW_COUNT }, (_, i) => ({
    id: randomUUID(),
    tableId,
    cells: {},
    order: i,
    createdAt: now,
    updatedAt: now,
  }));
}

interface WorkspaceState {
  tables: TableMeta[];
  activeTableId: string | null;
  ready: boolean;
  /** Set when `init()` fails outright (most likely: the table-data
   * migration made `server/` load-bearing for the whole app, not just the
   * Calls tab — see CLAUDE.md — so "server/ isn't running" is now a real,
   * common way for this to fail, not a rare edge case). Left `null` on
   * success. App.tsx shows this instead of leaving the user staring at an
   * infinite "Kraunama…" spinner with no explanation, which is what
   * happened before this was added — `init()` throwing left `ready` stuck
   * at `false` forever with no user-facing signal at all. */
  initError: string | null;
  /** Set when the most recent createTable/duplicateTable/renameTable/
   * deleteTable call failed to persist server-side — null otherwise. A
   * real, reported bug: none of these four actions had any error
   * handling at all — createTable/duplicateTable let an unhandled
   * rejection propagate straight out of their onClick handlers (no
   * try/catch at the call sites in WorkspaceView.tsx/SheetTabs.tsx
   * either), and renameTable/deleteTable were plain fire-and-forget
   * (`void updateTableName(...)`/`void deleteTableDB(...)`). Duplicating
   * a large (~14,000-row) table is exactly the case most likely to hit a
   * slow/failed request (one big PUT /api/rows for the whole cloned
   * table), and with no error surfaced anywhere, that failure looked
   * like literally nothing happened — the context menu just sat there.
   * Same "stores own data, components own side effects" convention as
   * useTableStore's own lastCellSaveError — App.tsx watches this and
   * toasts, since both WorkspaceView and SheetTabs (the two places these
   * actions are triggered from) need the same handling and App.tsx is
   * the one thing always mounted regardless of which screen is active. */
  actionError: string | null;
  init: () => Promise<void>;
  /** Async, not a synchronous id return — awaits both the table record
   * and its seed rows actually landing server-side before resolving, for
   * the identical reason duplicateTable below does: a caller that
   * switches to viewing the new table immediately (both real callers do)
   * would otherwise race a still-in-flight bulk row write and could
   * render the freshly-seeded table as empty. Returns null (and sets
   * actionError) if either write fails, rather than throwing — see
   * actionError's own doc comment. */
  createTable: (name: string) => Promise<string | null>;
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
  initError: null,
  actionError: null,

  init: async () => {
    try {
      let tables = await loadTables();
      if (tables.length === 0) {
        const now = Date.now();
        const table: TableMeta = {
          id: randomUUID(),
          name: 'Lentelė 1',
          columns: buildSeedColumns(),
          createdAt: now,
          updatedAt: now,
        };
        await saveTable(table);
        await saveRows(buildSeedRows(table.id));
        tables = [table];
      }
      tables = [...tables].sort((a, b) => a.createdAt - b.createdAt);
      const savedActiveId = localStorage.getItem(LAST_ACTIVE_KEY);
      const activeTableId = tables.some((t) => t.id === savedActiveId) ? savedActiveId : null;
      set({ tables, activeTableId, ready: true, initError: null });
    } catch {
      // Server unreachable (down, wrong VITE_API_BASE_URL, phone off the
      // Mac's wifi, etc). Deliberately doesn't set ready: true — App.tsx's
      // initError branch is what the user sees instead of the normal
      // workspace, with a retry button that just calls init() again.
      set({ initError: 'Nepavyko pasiekti serverio — patikrinkite, ar veikia server/ ir ar teisingas adresas.' });
    }
  },

  createTable: async (name) => {
    const now = Date.now();
    const table: TableMeta = {
      id: randomUUID(),
      name: name.trim() || `Lentelė ${get().tables.length + 1}`,
      columns: buildSeedColumns(),
      createdAt: now,
      updatedAt: now,
    };
    set({ tables: [...get().tables, table] });
    try {
      await saveTable(table);
      await saveRows(buildSeedRows(table.id));
      set({ actionError: null });
      return table.id;
    } catch (err) {
      set({
        tables: get().tables.filter((t) => t.id !== table.id),
        actionError: err instanceof Error ? `Nepavyko sukurti lentelės — ${err.message}` : 'Nepavyko sukurti lentelės serveryje',
      });
      return null;
    }
  },

  duplicateTable: async (id) => {
    try {
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
        const newId = randomUUID();
        columnIdMap.set(c.id, newId);
        return { ...c, id: newId };
      });

      const now = Date.now();
      const newTable: TableMeta = {
        id: randomUUID(),
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
        return { id: randomUUID(), tableId: newTable.id, cells, colors, order: r.order, height: r.height, createdAt: now, updatedAt: now };
      });

      // Both awaited (not the usual fire-and-forget void saveX(...) pattern
      // elsewhere in this store) — the caller switches to viewing this new
      // table right after this resolves (SheetTabs' "Duplicate table"), and
      // loadTable() does a one-shot fresh read from IndexedDB with no retry.
      // Returning before the writes land would make the new table briefly
      // (or, if the write loses the race, indefinitely) look empty.
      await saveTable(newTable);
      await saveRows(newRows);
      set({ tables: [...get().tables, newTable], actionError: null });
      return newTable.id;
    } catch (err) {
      // Whole body wrapped, not just the final writes — a real, reported
      // bug: nothing here had any error handling at all, so a failure
      // anywhere in this chain (even the initial getTable/loadRowsForTable
      // reads) was an unhandled rejection that propagated straight out of
      // SheetTabs.tsx's onClick with zero visible indication — the context
      // menu just sat there, looking like nothing had happened. Most
      // likely to bite on exactly the table size where it actually got
      // reported: a large (~14,000-row) table means saveRows() here is one
      // big PUT, the single most likely request in this whole app to hit
      // a slow/failed connection.
      set({
        actionError: err instanceof Error ? `Nepavyko dubliuoti lentelės — ${err.message}` : 'Nepavyko dubliuoti lentelės serveryje',
      });
      return null;
    }
  },

  renameTable: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const tables = get().tables.map((t) => (t.id === id ? { ...t, name: trimmed, updatedAt: Date.now() } : t));
    set({ tables });
    updateTableName(id, trimmed)
      .then(() => set({ actionError: null }))
      .catch((err) => {
        set({
          actionError: err instanceof Error ? `Nepavyko pervadinti lentelės — ${err.message}` : 'Nepavyko pervadinti lentelės serveryje',
        });
      });
  },

  deleteTable: (id) => {
    const wasActive = get().activeTableId === id;
    const tables = get().tables.filter((t) => t.id !== id);
    set({ tables, activeTableId: wasActive ? null : get().activeTableId });
    if (wasActive) localStorage.removeItem(LAST_ACTIVE_KEY);
    deleteTableDB(id)
      .then(() => set({ actionError: null }))
      .catch((err) => {
        set({
          actionError: err instanceof Error ? `Nepavyko ištrinti lentelės — ${err.message}` : 'Nepavyko ištrinti lentelės serveryje',
        });
      });
  },

  setActiveTable: (id) => {
    set({ activeTableId: id });
    if (id) localStorage.setItem(LAST_ACTIVE_KEY, id);
    else localStorage.removeItem(LAST_ACTIVE_KEY);
  },
}));
