import { create } from 'zustand';
import type { Column, ColumnType, Row } from '../types';
import { clampToLimit } from '../utils/cellLimit';
import { deleteRowDB, getTable, importRows, loadRowsForTable, saveRow, saveRows, updateTableColumns } from '../db/db';
import { randomUUID } from '../utils/uuid';
import { addNoteEntry } from '../utils/noteHistory';
import { useAuthStore } from './useAuthStore';
import { PRESET_COLORS } from '../constants';

// A real, reported pain: a CSV import that creates a brand-new `dropdown`
// column (e.g. re-importing a table you'd previously exported, now that
// "Importuoti CSV" always targets a new table — see App.tsx's
// startCsvImport) used to leave that column with zero options and zero
// colors, since CSV has nowhere to carry that metadata — every status had
// to be retyped by hand and re-colored one at a time through the column's
// own (⋮) menu. importCsvRows below now seeds a new dropdown column's
// `options`/`optionColors` directly from the distinct values actually
// found in the imported data, cycling through the same PRESET_COLORS the
// rest of the app already uses for status badges — not a guarantee of the
// *exact* original colors (CSV genuinely can't carry that), but real
// options with real colors already in place instead of a blank slate.
// Capped so a column mistakenly typed 'dropdown' against near-unique free
// text doesn't spray dozens of one-off "options" into the column.
const MAX_AUTO_DROPDOWN_OPTIONS = 30;

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
  /** Set when the most recent write to the server failed — null otherwise
   * (including on success). Every row/column write in this store is
   * fire-and-forget (persistRow/persistRows/persistColumns/persistDeletes,
   * defined inside this store's own closure below — no retry, no offline
   * queue, a deliberate, documented scope cut from the table-data
   * migration), which was a fine tradeoff when the only realistic failure
   * was a local IndexedDB write, but a real, reported bug once writes
   * started going over a phone's wifi (or a slow/sleeping backend) to this
   * Mac's local server instead: the local UI state updates immediately
   * regardless (optimistic), so a failed write was completely silent — an
   * edit looked saved right up until the next reload, when it would just
   * be gone (or a deleted row would silently reappear), with zero
   * indication anything had gone wrong. Originally only updateCell had
   * this — every other write (paste, row add/delete, drag-reorder, sort,
   * color-fill, column edits, note/contact-linked fields) stayed silent,
   * which was itself a real, reported gap, fixed by routing every write in
   * this store through the same small set of persist* helpers rather than
   * a bare `void saveX(...)`. Doesn't add retry/queueing (a genuinely
   * bigger project — see CLAUDE.md), just turns a silent failure into a
   * visible one, everywhere a write can happen. Follows this codebase's
   * "stores own data, components own side effects" convention (see
   * useCallsStore's own `error` field) — TableView watches this and
   * toasts, the store itself never calls showToast directly. */
  lastCellSaveError: string | null;
  /** Set when the most recent loadTable() call itself failed (server
   * unreachable, timed out, 401, etc.) — null otherwise. Before this
   * existed, loadTable() had no try/catch at all: a throw left `ready`
   * stuck at `false` forever with zero indication anything was wrong,
   * since `set({ ready: false })` runs *before* the awaited fetch and
   * nothing ever set it back. App.tsx's own `!tableReady` branch has no
   * timeout, so this reproduced as exactly what got reported — opening (or
   * returning to, or switching into) a table that happened to coincide
   * with a slow/failed request left the user staring at "Kraunama…"
   * indefinitely, with a full page reload being the only way out (which
   * "worked" only because it started a fresh request that, by then, often
   * landed against a server that had finished waking up). Mirrors
   * useWorkspaceStore's own `initError` field/fix exactly — same class of
   * bug, same shape of fix, just never applied here too at the time. */
  loadError: string | null;
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
  setStatusColumn: (id: string) => void;
  clearStatusColumn: () => void;
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
  /** null/empty clears the note. See Row.nextActionNote in types.ts. */
  setNextActionNote: (rowId: string, note: string | null) => void;
  /** Mirrors setColumnsHidden above, for rows — see Row.hidden in
   * types.ts. RowHeaderMenu's "Slėpti eilutę"/"Rodyti eilutę" call this. */
  setRowsHidden: (ids: string[], hidden: boolean) => void;
  updateCell: (rowId: string, columnId: string, value: string) => boolean;
  updateCells: (updates: CellUpdate[]) => number;
  setCellColors: (updates: CellColorUpdate[]) => void;
  moveRows: (draggedIds: string[], targetRowId: string | null) => void;
  /** Permanently reassigns every row's `order` to match `sortedIds` — used
   * by TableView's one-click column-sort action to actually commit the new
   * order into the data itself, rather than holding a separate "currently
   * sorted by X" view state that stays active until manually cleared. On
   * explicit request: sorting should do its one-time rearrangement job and
   * then be done — not leave anything "on" for the user to notice and turn
   * off later. Rows not present in `sortedIds` (shouldn't normally happen —
   * TableView always passes every row's id) are left untouched. */
  applySortOrder: (sortedIds: string[]) => void;
  /** Set while importCsvRows() is running, null otherwise — TableView's
   * toolbar renders a progress bar next to "🎨 Spalva" while this is set.
   * See importCsvRows's own doc comment for why this exists. */
  importProgress: { imported: number; total: number } | null;
  importCsvRows: (
    headers: string[],
    dataRows: string[][],
    mapping: Record<string, ImportColumnMapping>,
  ) => Promise<ImportResult>;
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

/** On explicit request: a table's designated "Status" dropdown column
 * (Column.isStatusColumn — set via ColumnMenu's "Naudoti kaip Status"
 * checkbox, at most one per table, same one-at-a-time rule as
 * isNextActionDate) auto-logs every value change into the table's own
 * note column, so a status transition ("Rejected" → "Accepted") leaves a
 * permanent, in-context record without a separate audit UI. Applies to
 * every user (not worker-specific — this is a general feature), called
 * from both updateCell and updateCells so no write path misses it. A
 * no-op when: the changed column isn't the status column, the value
 * didn't actually change, the new value is empty (clearing a status isn't
 * itself a status worth logging), or the table has no note column to
 * write into. Reads the acting user directly off useAuthStore's current
 * state (not a hook — this runs inside a store action, not a component)
 * purely for the note entry's author attribution, same as every other
 * addNoteEntry call site in this app. */
function logStatusChangeIfNeeded(
  cells: Record<string, string>,
  columnId: string,
  oldValue: string,
  newValue: string,
  columns: Column[],
): Record<string, string> {
  if (oldValue === newValue || !newValue) return cells;
  const column = columns.find((c) => c.id === columnId);
  if (!column?.isStatusColumn) return cells;
  const noteColumn = columns.find((c) => c.type === 'note');
  if (!noteColumn) return cells;
  const user = useAuthStore.getState().user;
  const authorName = user ? `${user.firstName} ${user.lastName}`.trim() : undefined;
  const rawNote = cells[noteColumn.id] ?? '';
  return { ...cells, [noteColumn.id]: addNoteEntry(rawNote, newValue, authorName) };
}

export const useTableStore = create<TableState>((set, get) => {
  /** Tracks which table the *most recently started* loadTable() call was
   * for — a real, reported bug: switching tables quickly (SheetTabs) fires
   * a new loadTable() before the previous one has resolved, and with no
   * guard, whichever request happened to resolve *last* won regardless of
   * whether it was actually the most recent one — a slower, now-stale
   * request for a table the user already navigated away from could
   * overwrite the correct, already-loaded table with stale
   * rows/columns, or (worse) apply its own late failure as `loadError`
   * even though the table the user is now actually looking at loaded
   * fine. Every loadTable() call checks this against its own `tableId`
   * before applying its result — same "capture an identifier, check it's
   * still current before applying" pattern this codebase already uses for
   * Apollo's phone-reveal poll and InboxPanel's AI-suggest-reply race. */
  let latestRequestedTableId: string | null = null;
  /** Actually cancels a superseded loadTable()'s in-flight requests
   * (fetch's AbortController), not just its eventually-ignored result —
   * a real, reported production issue: rapidly switching between tables
   * (SheetTabs) never used to cancel the abandoned request, so the
   * server kept building/holding that response (a full row-array +
   * JSON.stringify of it, multi-MB for a ~14,000-row table) in memory
   * even after the client no longer wanted it; several of those piling
   * up concurrently under fast repeated switching is a plausible
   * contributor to a real "JavaScript heap out of memory" crash seen in
   * production. Aborting the fetch as soon as a newer loadTable() starts
   * means the browser stops waiting on/buffering that response, and the
   * server-side request is torn down rather than left to keep running to
   * completion for a client that already left. */
  let currentLoadController: AbortController | null = null;

  /** Push the state as it was *before* the mutation about to run onto the
   * undo stack, and drop the redo stack (a fresh action invalidates "future"
   * history). Every action below always creates new `columns`/`rows`
   * arrays rather than mutating in place, so it's safe to keep bare
   * references here instead of deep-cloning. */
  const snapshot = () => {
    const { columns, rows, undoStack } = get();
    set({ undoStack: [...undoStack, { columns, rows }].slice(-MAX_HISTORY_DEPTH), redoStack: [] });
  };

  /** Every row/column write in this store goes through one of the three
   * helpers below instead of a bare `void saveX(...)` — a real, reported
   * gap: only updateCell (plain single-cell typing) surfaced a failed
   * save (via lastCellSaveError, watched/toasted by TableView); paste, row
   * add/delete, drag-reorder, sort, color-fill, column edits, and every
   * note/contact-linked field write (setLinkedContact, setNextActionNote,
   * etc.) stayed completely silent — a write that never reached the
   * server (a slow/asleep backend, a dropped phone connection) looked
   * identical to a successful one right up until the next reload, when it
   * would just be gone with no explanation. This doesn't add retry or an
   * offline queue — same accepted scope cut as before, see
   * lastCellSaveError's own doc comment — it just makes a failure visible
   * instead of invisible, everywhere a write can happen. */
  const reportSaveError = (err: unknown) => {
    set({
      lastCellSaveError: err instanceof Error ? `Nepavyko išsaugoti — ${err.message}` : 'Nepavyko išsaugoti pakeitimo serveryje',
    });
  };
  const persistRow = (row: Row) => {
    saveRow(row)
      .then(() => set({ lastCellSaveError: null }))
      .catch(reportSaveError);
  };
  const persistRows = (rows: Row[]) => {
    if (rows.length === 0) return;
    saveRows(rows)
      .then(() => set({ lastCellSaveError: null }))
      .catch(reportSaveError);
  };
  const persistColumns = (columns: Column[]) => {
    const { tableId } = get();
    if (!tableId) return;
    updateTableColumns(tableId, columns)
      .then(() => set({ lastCellSaveError: null }))
      .catch(reportSaveError);
  };
  const persistDeletes = (ids: string[]) => {
    if (ids.length === 0) return;
    Promise.all(ids.map((id) => deleteRowDB(id)))
      .then(() => set({ lastCellSaveError: null }))
      .catch(reportSaveError);
  };

  /** Undo/redo can restore rows that were deleted and must also delete rows
   * that were created since — a plain saveRows() only upserts, so diff
   * against what's disappearing too. */
  const syncRowsToDB = (previousRows: Row[], nextRows: Row[]) => {
    const nextIds = new Set(nextRows.map((r) => r.id));
    const removedIds = previousRows.filter((r) => !nextIds.has(r.id)).map((r) => r.id);
    persistRows(nextRows);
    persistDeletes(removedIds);
  };

  return {
    tableId: null,
    columns: [],
    rows: [],
    ready: false,
    undoStack: [],
    redoStack: [],
    lastCellSaveError: null,
    loadError: null,
    importProgress: null,

    loadTable: async (tableId) => {
      latestRequestedTableId = tableId;
      currentLoadController?.abort();
      const controller = new AbortController();
      currentLoadController = controller;
      set({ ready: false, loadError: null });
      try {
        const [table, rows] = await Promise.all([
          getTable(tableId, controller.signal),
          loadRowsForTable(tableId, controller.signal),
        ]);
        // A newer loadTable() call has since started (the user switched
        // tables again before this one finished) — applying this result
        // now would overwrite whatever that newer call already loaded (or
        // is about to), possibly with a different table's stale data.
        if (latestRequestedTableId !== tableId) return;
        if (!table) {
          set({ tableId: null, columns: [], rows: [], ready: true, loadError: null, undoStack: [], redoStack: [] });
          return;
        }
        rows.sort((a, b) => a.order - b.order);
        set({ tableId: table.id, columns: table.columns, rows, ready: true, loadError: null, undoStack: [], redoStack: [] });
      } catch (err) {
        if (latestRequestedTableId !== tableId) return;
        set({
          loadError: err instanceof Error ? `Nepavyko įkelti lentelės — ${err.message}` : 'Nepavyko įkelti lentelės iš serverio',
        });
      }
    },

    unload: () => {
      // Also invalidates AND actually cancels any loadTable() still in
      // flight for the table being left — see latestRequestedTableId's
      // and currentLoadController's own doc comments above.
      latestRequestedTableId = null;
      currentLoadController?.abort();
      currentLoadController = null;
      set({ tableId: null, columns: [], rows: [], ready: false, loadError: null, undoStack: [], redoStack: [] });
    },

    undo: () => {
      const { undoStack, redoStack, columns, rows } = get();
      if (undoStack.length === 0) return;
      const prev = undoStack[undoStack.length - 1];
      set({
        columns: prev.columns,
        rows: prev.rows,
        undoStack: undoStack.slice(0, -1),
        redoStack: [...redoStack, { columns, rows }].slice(-MAX_HISTORY_DEPTH),
      });
      persistColumns(prev.columns);
      syncRowsToDB(rows, prev.rows);
    },

    redo: () => {
      const { undoStack, redoStack, columns, rows } = get();
      if (redoStack.length === 0) return;
      const next = redoStack[redoStack.length - 1];
      set({
        columns: next.columns,
        rows: next.rows,
        redoStack: redoStack.slice(0, -1),
        undoStack: [...undoStack, { columns, rows }].slice(-MAX_HISTORY_DEPTH),
      });
      persistColumns(next.columns);
      syncRowsToDB(rows, next.rows);
    },

    addColumn: (name, type, options) => {
      snapshot();
      const column: Column = {
        id: randomUUID(),
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
      persistColumns(columns);
    },

    insertColumns: (beforeColumnId, count) => {
      if (count <= 0) return;
      snapshot();
      const current = get().columns;
      const newColumns: Column[] = [];
      for (let i = 0; i < count; i++) {
        newColumns.push({ id: randomUUID(), name: nextColumnName([...current, ...newColumns]), type: 'text' });
      }
      const index = beforeColumnId === null ? -1 : current.findIndex((c) => c.id === beforeColumnId);
      const columns =
        index === -1
          ? [...current, ...newColumns]
          : [...current.slice(0, index), ...newColumns, ...current.slice(index)];
      set({ columns });
      persistColumns(columns);
    },

    renameColumn: (id, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      snapshot();
      const columns = get().columns.map((c) => (c.id === id ? { ...c, name: trimmed } : c));
      set({ columns });
      persistColumns(columns);
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
      persistColumns(columns);
      persistRows(rows);
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
      persistColumns(columns);
      persistRows(rows);
    },

    setColumnHidden: (id, hidden) => {
      snapshot();
      const columns = get().columns.map((c) => (c.id === id ? { ...c, hidden } : c));
      set({ columns });
      persistColumns(columns);
    },

    setColumnsHidden: (ids, hidden) => {
      if (ids.length === 0) return;
      snapshot();
      const idSet = new Set(ids);
      const columns = get().columns.map((c) => (idSet.has(c.id) ? { ...c, hidden } : c));
      set({ columns });
      persistColumns(columns);
    },

    setColumnType: (id, type) => {
      snapshot();
      const columns = get().columns.map((c) => {
        if (c.id !== id) {
          // Switching *this* column to 'date' takes over as the calendar/
          // task-list column, same "only one at a time" rule
          // setNextActionDateColumn already enforces — so any other
          // column currently holding that flag loses it here too.
          return type === 'date' && c.isNextActionDate ? { ...c, isNextActionDate: false } : c;
        }
        const updated: Column = { ...c, type };
        if (type === 'dropdown') updated.options = c.options ?? [];
        else {
          delete updated.options;
          delete updated.optionColors;
        }
        if (type !== 'dropdown') {
          // Unlike isNextActionDate, this is NOT auto-set when a column
          // becomes 'dropdown' — a dropdown column is just as often a
          // priority/source/category field as an actual status one, so
          // auto-claiming the flag here would be wrong more often than
          // right. It only ever gets set explicitly via the "Naudoti kaip
          // Status" checkbox below; this branch just clears it when a
          // column stops being a dropdown at all.
          delete updated.isStatusColumn;
        }
        if (type === 'date') {
          // Auto-wired into the calendar the moment a column becomes
          // Date-typed — on explicit request, removing what used to be a
          // mandatory separate checkbox click for the common case. The
          // "Naudoti kalendoriuje" checkbox in ColumnMenu stays available
          // to opt back out (e.g. a second, unrelated date column).
          updated.isNextActionDate = true;
        } else {
          delete updated.isNextActionDate;
        }
        return updated;
      });
      set({ columns });
      persistColumns(columns);
    },

    setDropdownOptions: (id, options) => {
      snapshot();
      const columns = get().columns.map((c) => (c.id === id ? { ...c, options } : c));
      set({ columns });
      persistColumns(columns);
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
      persistColumns(columns);
    },

    setColumnWidth: (id, width) => {
      snapshot();
      const columns = get().columns.map((c) => (c.id === id ? { ...c, width } : c));
      set({ columns });
      persistColumns(columns);
    },

    setNextActionDateColumn: (id) => {
      snapshot();
      const columns = get().columns.map((c) => ({ ...c, isNextActionDate: c.id === id }));
      set({ columns });
      persistColumns(columns);
    },

    clearNextActionDateColumn: () => {
      snapshot();
      const columns = get().columns.map((c) => ({ ...c, isNextActionDate: false }));
      set({ columns });
      persistColumns(columns);
    },

    setStatusColumn: (id) => {
      snapshot();
      const columns = get().columns.map((c) => ({ ...c, isStatusColumn: c.id === id }));
      set({ columns });
      persistColumns(columns);
    },

    clearStatusColumn: () => {
      snapshot();
      const columns = get().columns.map((c) => ({ ...c, isStatusColumn: false }));
      set({ columns });
      persistColumns(columns);
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
      persistColumns(reordered);
    },

    addRow: () => {
      const { tableId, rows } = get();
      if (!tableId) return '';
      snapshot();
      const id = randomUUID();
      const now = Date.now();
      const maxOrder = rows.reduce((m, r) => Math.max(m, r.order), -1);
      const row: Row = { id, tableId, cells: {}, order: maxOrder + 1, createdAt: now, updatedAt: now };
      set({ rows: [...rows, row] });
      persistRow(row);
      return id;
    },

    insertRows: (beforeRowId, count) => {
      const { tableId } = get();
      if (!tableId || count <= 0) return;
      snapshot();
      const current = [...get().rows].sort((a, b) => a.order - b.order);
      const now = Date.now();
      const newRows: Row[] = Array.from({ length: count }, () => ({
        id: randomUUID(),
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
      persistRows(updated);
    },

    removeRow: (id) => {
      snapshot();
      const rows = get().rows.filter((r) => r.id !== id);
      set({ rows });
      persistDeletes([id]);
    },

    removeRows: (ids) => {
      snapshot();
      const idSet = new Set(ids);
      const rows = get().rows.filter((r) => !idSet.has(r.id));
      set({ rows });
      persistDeletes(ids);
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
      if (updatedRow) persistRow(updatedRow);
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
      if (updatedRow) persistRow(updatedRow);
    },

    setNextActionNote: (rowId, note) => {
      snapshot();
      const trimmed = note?.trim() ?? '';
      let updatedRow: Row | undefined;
      const rows = get().rows.map((r) => {
        if (r.id !== rowId) return r;
        updatedRow = { ...r, nextActionNote: trimmed || undefined, updatedAt: Date.now() };
        return updatedRow;
      });
      set({ rows });
      if (updatedRow) persistRow(updatedRow);
    },

    setRowsHidden: (ids, hidden) => {
      if (ids.length === 0) return;
      snapshot();
      const idSet = new Set(ids);
      const changedRows: Row[] = [];
      const rows = get().rows.map((r) => {
        if (!idSet.has(r.id)) return r;
        const updated = { ...r, hidden, updatedAt: Date.now() };
        changedRows.push(updated);
        return updated;
      });
      set({ rows });
      persistRows(changedRows);
    },

    updateCell: (rowId, columnId, value) => {
      snapshot();
      const { value: clamped, truncated } = clampToLimit(value);
      const columns = get().columns;
      let updatedRow: Row | undefined;
      const rows = get().rows.map((r) => {
        if (r.id !== rowId) return r;
        const oldValue = r.cells[columnId] ?? '';
        const cells = logStatusChangeIfNeeded({ ...r.cells, [columnId]: clamped }, columnId, oldValue, clamped, columns);
        updatedRow = { ...r, cells, updatedAt: Date.now() };
        return updatedRow;
      });
      set({ rows });
      if (updatedRow) persistRow(updatedRow);
      return truncated;
    },

    updateCells: (updates) => {
      if (updates.length === 0) return 0;
      snapshot();
      const columns = get().columns;
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
        let cells = { ...r.cells };
        for (const u of rowUpdates) {
          const { value, truncated } = clampToLimit(u.value);
          if (truncated) truncatedCount++;
          const oldValue = cells[u.columnId] ?? '';
          cells[u.columnId] = value;
          cells = logStatusChangeIfNeeded(cells, u.columnId, oldValue, value, columns);
        }
        const updated = { ...r, cells, updatedAt: now };
        changedRows.push(updated);
        return updated;
      });
      set({ rows });
      persistRows(changedRows);
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
      persistRows(changedRows);
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
      persistRows(updated);
    },

    applySortOrder: (sortedIds) => {
      snapshot();
      const now = Date.now();
      const byId = new Map(get().rows.map((r) => [r.id, r]));
      // Rebuild the array itself in the new sequence (not just each row's
      // own `order` field) — the rest of this store's own convention
      // (moveRows, above) is that the in-memory `rows` array's own
      // iteration order IS the visual order; only touching the field
      // without touching the array would leave the table showing the old
      // order until something else happened to re-trigger a re-render off
      // real array movement.
      const ordered: Row[] = [];
      for (const id of sortedIds) {
        const r = byId.get(id);
        if (r) {
          ordered.push(r);
          byId.delete(id);
        }
      }
      // Any row not present in sortedIds (shouldn't normally happen) is
      // appended at the end rather than dropped.
      for (const r of byId.values()) ordered.push(r);
      const updated = ordered.map((r, i) => ({ ...r, order: i, updatedAt: now }));
      set({ rows: updated });
      persistRows(updated);
    },

    // Builds and appends rows in batches instead of one synchronous pass
    // over the whole file — a real, reported problem: for a 14k-row
    // export, building every Row object (with clampToLimit run per cell)
    // in one blocking loop, then a single `set()`, then handing all 14k
    // rows to saveRows() as one multi-MB PUT, froze the tab for around two
    // minutes with zero feedback — nothing rendered until literally
    // everything (parse, build, *and* the network round trip) had
    // finished. Chunking fixes this on both ends: `set()` after each
    // batch means the first rows are on screen almost immediately instead
    // of waiting for row 14,617, and the `await new Promise(requestAnimationFrame)`
    // between batches actually yields to the browser so it can repaint —
    // a plain synchronous loop of any length blocks that regardless of
    // how the *data* is chunked. saveRows() is called per batch too
    // (still fire-and-forget, matching every other write in this store),
    // so persistence lands as a series of smaller requests instead of one
    // giant one. `importProgress` drives TableView's toolbar progress bar
    // (next to "🎨 Spalva") — set to null when done so the bar disappears.
    importCsvRows: async (headers, dataRows, mapping) => {
      const state = get();
      if (!state.tableId) return { createdRows: 0, createdColumns: 0, truncatedCells: 0 };
      const tableId = state.tableId;
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
        const column: Column = { id: randomUUID(), name: header.trim() || 'Stulpelis', type: decision.columnType };
        if (decision.columnType === 'dropdown') {
          const headerIndex = headers.indexOf(header);
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
      }
      // Columns (and the resulting empty-state/header render) should
      // update immediately, before the row batches start landing.
      set({ columns });
      persistColumns(columns);

      const nonEmptyDataRows = dataRows.filter((dataRow) => dataRow.some((cell) => cell && cell.trim() !== ''));
      let truncatedCells = 0;
      const now = Date.now();
      let nextOrder = state.rows.reduce((m, r) => Math.max(m, r.order), -1) + 1;
      const total = nonEmptyDataRows.length;
      const BATCH_SIZE = 500;
      let imported = 0;
      if (total > 0) set({ importProgress: { imported: 0, total } });

      for (let start = 0; start < total; start += BATCH_SIZE) {
        const batch = nonEmptyDataRows.slice(start, start + BATCH_SIZE).map((dataRow) => {
          const cells: Record<string, string> = {};
          headers.forEach((header, i) => {
            const columnId = headerToColumnId.get(header);
            if (!columnId) return;
            const raw = dataRow[i] ?? '';
            const { value, truncated } = clampToLimit(raw);
            if (truncated) truncatedCells++;
            cells[columnId] = value;
          });
          return { id: randomUUID(), tableId, cells, order: nextOrder++, createdAt: now, updatedAt: now };
        });

        // The batch is on screen (and in the undo snapshot) the instant
        // it's built — only *persisting* it waits its turn below.
        set((s) => ({ rows: [...s.rows, ...batch] }));
        // Awaited, not fire-and-forget — a real, caught bug: firing every
        // batch's save at once (~10 requests for a 5,000-row test import)
        // hit Chromium's own connection limit and started failing with
        // net::ERR_INSUFFICIENT_RESOURCES. Awaiting means at most one
        // batch's request is in flight at a time, which also makes the
        // progress bar honest — it reflects rows actually persisted, not
        // just rows appended to in-memory state. importRows (not the
        // plain saveRows every other write in this store uses) hits a
        // distinct server route specifically so a worker's
        // can_export_import permission can gate CSV import without also
        // blocking ordinary paste/drag-reorder/sort saves.
        await importRows(batch);
        imported += batch.length;
        set({ importProgress: { imported, total } });
        // Yields to the browser so the batch just appended actually paints
        // before the next batch starts building — awaiting saveRows()
        // above already does this in practice (a real network round trip
        // spans plenty of paint opportunities), but keeping this explicit
        // means the progress bar still animates smoothly even against a
        // very fast/local backend where the save resolves almost
        // instantly.
        await new Promise(requestAnimationFrame);
      }

      set({ importProgress: null });
      return { createdRows: total, createdColumns, truncatedCells };
    },
  };
});
