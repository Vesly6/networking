import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Column, Row } from '../../types';
import { useTableStore, type CellColorUpdate, type CellUpdate, type ImportColumnMapping } from '../../store/useTableStore';
import { useToastStore } from '../../store/useToastStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { DataCell } from './DataCell';
import { ColorInput } from '../ColorInput';
import { CellHoverEditor } from './CellHoverEditor';
import { ColumnMenu } from './ColumnMenu';
import { AddColumnPopover } from './AddColumnPopover';
import { CsvImportMapping } from './CsvImportMapping';
import { ColumnHeaderMenu } from './ColumnHeaderMenu';
import { RowHeaderMenu } from './RowHeaderMenu';
import { HiddenColumnsPopover } from './HiddenColumnsPopover';
import { FormulaBar } from '../FormulaBar';
import { Popover } from '../Popover';
import { parseCsvFile, exportRowsToCsv, downloadCsv } from '../../utils/csv';
import { parseTsv, buildTsv } from '../../utils/tsv';
import { addNoteEntry, updateNoteEntry, removeNoteEntry } from '../../utils/noteHistory';
import { addContact, updateContact, removeContact, markSocialLookupNotFound } from '../../utils/contacts';
import { columnLetter, formatCellRef, parseRangeRef } from '../../utils/spreadsheet';
import { getColumnByType } from '../../utils/row';
import { normalizePhoneDigits } from '../../utils/phoneMatch';
import {
  ADD_COLUMN_WIDTH,
  DEFAULT_COLUMN_WIDTH,
  DEFAULT_ROW_HEIGHT,
  GUTTER_WIDTH,
  MAX_COLUMN_WIDTH,
  MAX_ROW_HEIGHT,
  MIN_COLUMN_WIDTH,
  MIN_ROW_HEIGHT,
  PRESET_COLORS,
  RECENT_COLORS_KEY,
  TABLE_VIEW_STATE_KEY_PREFIX,
} from '../../constants';

interface TableViewProps {
  focusRowId: string | null;
  onFocusHandled: () => void;
  /** Like focusRowId, but also opens that row's Kontaktai editor with one
   * specific entry highlighted — the Calls tab's "🔍 Ieškoti" button (a
   * missed call matched to a person inside a Contacts entry, not the row's
   * own Phone column) drives this. */
  focusContact: { rowId: string; columnId: string; contactId: string } | null;
  onContactFocusHandled: () => void;
}

type SortDirection = 'asc' | 'desc';
interface CellPos {
  r: number;
  c: number;
}

// Below this many digits, a numeric search query is treated as plain text
// only (not also matched against phone-digit substrings) — otherwise a
// short numeric search (a year, a single digit) would start matching every
// phone-containing cell in the table.
const MIN_PHONE_SEARCH_DIGITS = 4;

/** The fill handle only ever extends along a single axis — same as
 * Excel's own: whichever of row/column has the larger displacement from
 * the source cell wins, and the other axis is ignored (a mostly-diagonal
 * drag doesn't fill an L-shaped block). Recomputed fresh on every mouse
 * move during the drag (not locked in once), so the preview rectangle
 * can flip axis if the user changes direction mid-drag, matching what
 * Excel's own fill handle does. Returns the cells to be *filled* —
 * excludes the origin itself, which already has the value. */
function computeFillRange(origin: CellPos, current: CellPos): CellPos[] {
  const dr = current.r - origin.r;
  const dc = current.c - origin.c;
  if (dr === 0 && dc === 0) return [];
  const cells: CellPos[] = [];
  if (Math.abs(dr) >= Math.abs(dc)) {
    const step = dr > 0 ? 1 : -1;
    for (let r = origin.r + step; step > 0 ? r <= current.r : r >= current.r; r += step) {
      cells.push({ r, c: origin.c });
    }
  } else {
    const step = dc > 0 ? 1 : -1;
    for (let c = origin.c + step; step > 0 ? c <= current.c : c >= current.c; c += step) {
      cells.push({ r: origin.r, c });
    }
  }
  return cells;
}

// Search text survives a full page reload (not just switching tabs — see
// App.tsx's tab-panel comment for that half of "my work keeps
// disappearing"), keyed per table id so a filter left over in one table
// can never silently hide rows in a different one after a reload. Sort is
// deliberately NOT persisted (or tracked as view state at all) — see
// toggleSort's own doc comment: sorting commits a real, permanent row
// order via applySortOrder() the moment it's clicked, so there is no
// "currently sorted" mode left to remember by the time this would run
// again. Scroll position and the active cell/range aren't included here
// either — restoring those meaningfully after an async table load,
// potentially against rows that no longer exist, is a fair bit more
// machinery for less payoff than what's actually reported as "resetting
// to some default."
function loadPersistedViewState(tableId: string | null): { search: string } {
  if (!tableId) return { search: '' };
  try {
    const raw = localStorage.getItem(`${TABLE_VIEW_STATE_KEY_PREFIX}${tableId}`);
    if (!raw) return { search: '' };
    const parsed = JSON.parse(raw) as { search?: unknown };
    const search = typeof parsed.search === 'string' ? parsed.search : '';
    return { search };
  } catch {
    return { search: '' };
  }
}

function saveViewState(tableId: string | null, search: string) {
  if (!tableId) return;
  try {
    localStorage.setItem(`${TABLE_VIEW_STATE_KEY_PREFIX}${tableId}`, JSON.stringify({ search }));
  } catch {
    // localStorage can throw (quota exceeded, private-browsing
    // restrictions) — persistence here is a nice-to-have, not required
    // for the table itself to keep working.
  }
}

function loadRecentColors(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_COLORS_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function saveRecentColor(color: string) {
  const current = loadRecentColors().filter((c) => c !== color);
  const next = [color, ...current].slice(0, 8);
  localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(next));
  return next;
}

export function TableView({ focusRowId, onFocusHandled, focusContact, onContactFocusHandled }: TableViewProps) {
  const tableId = useTableStore((s) => s.tableId);
  const columns = useTableStore((s) => s.columns);
  const rows = useTableStore((s) => s.rows);
  const hiddenColumns = columns.filter((c) => c.hidden);
  // For the next-action-date cell's "who are you calling" picker — computed
  // once per render here rather than per-cell, since it only depends on
  // `columns` (same reasoning as any other columns.find()-derived value).
  const contactColumn = useMemo(() => getColumnByType(columns, 'contact'), [columns]);
  const addRow = useTableStore((s) => s.addRow);
  const removeRows = useTableStore((s) => s.removeRows);
  const importCsvRows = useTableStore((s) => s.importCsvRows);
  const updateCell = useTableStore((s) => s.updateCell);
  const updateCells = useTableStore((s) => s.updateCells);
  const setCellColors = useTableStore((s) => s.setCellColors);
  const setDropdownOptions = useTableStore((s) => s.setDropdownOptions);
  const moveColumns = useTableStore((s) => s.moveColumns);
  const moveRows = useTableStore((s) => s.moveRows);
  const applySortOrder = useTableStore((s) => s.applySortOrder);
  const setColumnWidth = useTableStore((s) => s.setColumnWidth);
  const setRowHeight = useTableStore((s) => s.setRowHeight);
  const undo = useTableStore((s) => s.undo);
  const redo = useTableStore((s) => s.redo);
  const canUndo = useTableStore((s) => s.undoStack.length > 0);
  const canRedo = useTableStore((s) => s.redoStack.length > 0);
  const showToast = useToastStore((s) => s.show);

  const [search, setSearch] = useState(() => loadPersistedViewState(tableId).search);
  useEffect(() => {
    saveViewState(tableId, search);
  }, [tableId, search]);
  // Memory for "which direction did the last click on this same column
  // use" — purely so a second click on the same header flips asc -> desc,
  // same as before. Deliberately a ref, not state: nothing should
  // re-render or show any "currently sorted" indicator off the back of
  // this — see toggleSort's own doc comment below for why.
  const lastSortRef = useRef<{ columnId: string; direction: SortDirection } | null>(null);
  // note/contact cells expand into CellHoverEditor on click (see DataCell's
  // note/contact branch) — closed the same way every other popover in this
  // file is: `.table-view`'s onClick={closePopovers} below, or a click on
  // any other cell via handleCellMouseDown.
  const [expandedCell, setExpandedCell] = useState<{ rowId: string; columnId: string; anchor: HTMLElement } | null>(null);
  // Set alongside expandedCell only by the Calls tab's "🔍 Ieškoti" jump
  // (see the focusContact effect below) — CellHoverEditor uses this to
  // scroll to and briefly flash the one contact entry that actually
  // matched the missed call, since a Contacts column can hold several
  // people and the row/cell-level jump alone doesn't say which one.
  const [highlightContactId, setHighlightContactId] = useState<string | null>(null);
  // The next-action-date cell's own 📝 note / 👤 "who to call" mini-popovers
  // (DataCell.tsx) — lifted up here, rather than local state inside
  // DataCell, specifically so they close the same way every other popover
  // in this file does: via closePopovers below (a document-level "click
  // anywhere else" listener). A real, reported bug: while this lived as
  // local state inside DataCell, clicking any other cell did nothing to it
  // at all — the only way to close it was clicking the exact same 📝/👤
  // button again, which read as broken/unintuitive ("I click any other
  // cell and it doesn't close"). Keyed by rowId+columnId (not just "is one
  // open") since many date cells can exist across the table and only one's
  // popover should ever ee open at a time.
  const [dateCellPopover, setDateCellPopover] = useState<{
    rowId: string;
    columnId: string;
    kind: 'note' | 'contact';
    anchor: HTMLElement;
  } | null>(null);
  const toggleDatePopover = (rowId: string, columnId: string, kind: 'note' | 'contact', anchor: HTMLElement) => {
    setDateCellPopover((prev) =>
      prev && prev.rowId === rowId && prev.columnId === columnId && prev.kind === kind
        ? null
        : { rowId, columnId, kind, anchor },
    );
  };
  const [addColumnAnchor, setAddColumnAnchor] = useState<HTMLElement | null>(null);
  // Set once a CSV file is parsed, holding the raw parse result until the
  // user resolves the CsvImportMapping modal (confirm or cancel) — see
  // handleFileChange/handleConfirmImport below.
  const [pendingImport, setPendingImport] = useState<{ headers: string[]; dataRows: string[][] } | null>(null);
  const [columnContextMenu, setColumnContextMenu] = useState<{ x: number; y: number; targetIds: string[] } | null>(null);
  const [rowContextMenu, setRowContextMenu] = useState<{ x: number; y: number; targetIds: string[] } | null>(null);
  const [hiddenColumnsAnchor, setHiddenColumnsAnchor] = useState<HTMLElement | null>(null);
  const [openMenu, setOpenMenu] = useState<{ columnId: string; anchor: HTMLElement } | null>(null);
  const [colorPickerAnchor, setColorPickerAnchor] = useState<HTMLElement | null>(null);
  const [recentColors, setRecentColors] = useState<string[]>(() => loadRecentColors());
  const [flashRowId, setFlashRowId] = useState<string | null>(null);

  // Cell range selection (formula bar, copy/paste, color fill)
  const [rangeAnchor, setRangeAnchor] = useState<CellPos | null>(null);
  const [rangeFocus, setRangeFocus] = useState<CellPos | null>(null);
  const [isRangeDragging, setIsRangeDragging] = useState(false);
  // DataCell is memoized (see DataCell.tsx) and deliberately skips
  // re-rendering when a cell's own row/column/selected/editable/inRange
  // haven't changed — which most cells' don't, on a plain mousedown. That's
  // exactly the point (it's what makes clicking fast), but it means a cell
  // that's skipped keeps whatever onMouseEnter closure was bound at its
  // *last actual* render — which can predate the mousedown that just set
  // isRangeDragging/rangeAnchor. Reading those two through refs instead of
  // the closed-over state means even a "stale" bound closure still sees
  // the current value when the event actually fires, since a ref is one
  // shared mutable box, not a new snapshot per render. Kept in sync
  // unconditionally on every render — cheap, and simpler than an effect.
  const isRangeDraggingRef = useRef(isRangeDragging);
  isRangeDraggingRef.current = isRangeDragging;
  const rangeAnchorRef = useRef(rangeAnchor);
  rangeAnchorRef.current = rangeAnchor;
  // Pixel position of the mousedown that started the current drag — lets
  // handleCellMouseEnter tell a genuine drag apart from the few pixels of
  // essentially unavoidable hand jitter between mousedown and mouseup on an
  // ordinary click. Without this, a plain click landing near a cell edge
  // could cross into the neighboring cell's boundary and fire onMouseEnter,
  // turning a single click into an accidental 2-cell range (and, since that
  // also un-focuses the clicked cell's <input>, silently dropping out of
  // edit mode) even though the user never intended to drag at all.
  const dragStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const DRAG_SELECT_THRESHOLD_PX = 4;

  // Fill handle (the little square at the active cell's bottom-right
  // corner — Excel calls this the "fill handle") — a fourth, independent
  // drag system alongside cell/row/column range selection, only ever
  // active for a single source cell (fillDragOrigin), copying its value
  // into whichever cells the drag passes over. Refs mirror the state for
  // the same reason isRangeDraggingRef etc. do above: the global mouseup
  // listener below has an intentionally empty dependency array (so it's
  // not torn down and re-added on every render) and DataCell's memoing
  // means a cell's own onMouseEnter closure can predate the mousedown
  // that started this drag.
  const [fillDragActive, setFillDragActive] = useState(false);
  const [fillDragOrigin, setFillDragOrigin] = useState<CellPos | null>(null);
  const [fillDragCurrent, setFillDragCurrent] = useState<CellPos | null>(null);
  // Live cursor position (viewport coordinates) during the drag — used
  // only to give the preview rectangle below a smoothly-following edge
  // along the locked axis; the actual fill on drop uses fillDragCurrent's
  // cell indices, not this, so any pixel imprecision here never affects
  // which cells actually get filled.
  const [fillDragMousePos, setFillDragMousePos] = useState<{ x: number; y: number } | null>(null);
  const fillDragActiveRef = useRef(fillDragActive);
  fillDragActiveRef.current = fillDragActive;
  const fillDragOriginRef = useRef(fillDragOrigin);
  fillDragOriginRef.current = fillDragOrigin;
  const fillDragCurrentRef = useRef(fillDragCurrent);
  fillDragCurrentRef.current = fillDragCurrent;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  // Row-header selection (for multi-row drag-reorder / bulk delete)
  const [rowRangeAnchor, setRowRangeAnchor] = useState<number | null>(null);
  const [rowRangeFocus, setRowRangeFocus] = useState<number | null>(null);
  const [isRowRangeDragging, setIsRowRangeDragging] = useState(false);
  const [dragRowIds, setDragRowIds] = useState<string[] | null>(null);
  const [dragOverRowId, setDragOverRowId] = useState<string | null>(null);
  const [dragOverAfter, setDragOverAfter] = useState(false);

  // Column-header selection (for multi-column drag-reorder)
  const [colRangeAnchor, setColRangeAnchor] = useState<number | null>(null);
  const [colRangeFocus, setColRangeFocus] = useState<number | null>(null);
  const [isColRangeDragging, setIsColRangeDragging] = useState(false);
  const [dragColumnIds, setDragColumnIds] = useState<string[] | null>(null);
  const [dragOverColumnId, setDragOverColumnId] = useState<string | null>(null);
  const [dragOverColumnAfter, setDragOverColumnAfter] = useState(false);

  // Column/row resize (live-preview locally, committed to the store on release)
  const [resizingColumn, setResizingColumn] = useState<{ id: string; startX: number; startWidth: number; liveWidth: number } | null>(null);
  const [resizingRow, setResizingRow] = useState<{ id: string; startY: number; startHeight: number; liveHeight: number } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // A real, reported bug: `editable` (below) is computed purely from
  // *position* (activeCell.r/c), with no awareness of whether the search
  // box itself is focused. Typing into search changes `filteredSortedRows`
  // (fewer/reordered rows), so a *different* row can land at the stale
  // activeCell position on the very next keystroke — and since rows are
  // keyed by id, that's a fresh DataCell mount, which (for text/phone/
  // company columns) renders an `<input autoFocus>`, stealing focus out of
  // the search box mid-word. Tracking search focus explicitly and gating
  // `editable` on it means no cell can ever steal focus while the user is
  // actively typing a query, regardless of position coincidences.
  const [searchFocused, setSearchFocused] = useState(false);

  // Mirrors of isRowRangeDragging/isColRangeDragging, kept in sync so the
  // mouseup effect below (registered once, empty deps) can read a
  // never-stale value instead of one captured at mount time.
  const isRowRangeDraggingRef = useRef(false);
  const isColRangeDraggingRef = useRef(false);
  // After a row/column drag-select ends, the click that follows can bubble
  // to the outer "click anywhere closes popovers" handler even though it
  // didn't land on the row-number/letter itself (mousedown and mouseup were
  // on different elements, so the browser fires the click on their nearest
  // common ancestor, well above any element-level stopPropagation). This
  // flag tells that handler "a drag just finished, don't clear the
  // selection it just made" for the one click that follows.
  const justFinishedHeaderDragRef = useRef(false);

  useEffect(() => {
    if (!focusRowId) return;
    const found = filteredSortedRowsRef.current.some((r) => r.id === focusRowId);
    if (found) {
      scrollToRowId(focusRowId);
      setFlashRowId(focusRowId);
    }
    onFocusHandled();
    // scrollToRowId is intentionally omitted — it's a plain function
    // redefined every render (not a ref), but this effect should only
    // actually re-run when focusRowId itself changes, not on every render
    // that happens to produce a new scrollToRowId closure (e.g. typing in
    // the search box). It always reads filteredSortedRowsRef.current, a
    // ref, so it's never stale regardless of which render's closure fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRowId, onFocusHandled]);

  // The flash-clearing timer used to live inside the effect above, keyed on
  // [focusRowId, onFocusHandled] — a real, reported bug: onFocusHandled()
  // calls setFocusRowId(null) in the parent (App.tsx), which changes
  // focusRowId almost immediately, which is one of that *same* effect's own
  // dependencies — so React tears down and reruns that effect right away,
  // and the teardown's `clearTimeout(timer)` cancelled the pending
  // setFlashRowId(null) before it ever fired. flashRowId was then left set
  // to that row's id forever, so every time the (virtualized) row scrolled
  // out of view and back in — a fresh <tr> DOM node, per TanStack Virtual —
  // it mounted with the `row-flash` class already present, replaying the
  // CSS animation on that new element, indefinitely, on every scroll.
  // Splitting the timer into its own effect, keyed only on the *local*
  // flashRowId state, decouples it from focusRowId/onFocusHandled entirely
  // — nothing about clearing focusRowId in the parent can cancel this timer
  // anymore, so flashRowId reliably clears once, 1.6s after being set.
  useEffect(() => {
    if (!flashRowId) return;
    const timer = setTimeout(() => setFlashRowId(null), 1600);
    return () => clearTimeout(timer);
  }, [flashRowId]);

  // Same "scroll to it" step as the focusRowId effect above, but this one
  // also has to *open* that row's Kontaktai popup afterward — and the row
  // is virtualized, so its <td> (CellHoverEditor's positioning anchor)
  // doesn't exist in the DOM until the scroll has actually landed and React
  // has committed that row. `behavior: 'smooth'` (scrollToRowIndex's
  // default) makes that take real, variable wall-clock time, so this polls
  // for the cell via requestAnimationFrame instead of guessing a fixed
  // delay — see DataCell.tsx's data-row-id/data-column-id attributes,
  // added specifically so this cell is findable without threading a ref
  // for every cell in the table.
  useEffect(() => {
    if (!focusContact) return;
    const { rowId, columnId, contactId } = focusContact;
    const found = filteredSortedRowsRef.current.some((r) => r.id === rowId);
    if (!found) {
      onContactFocusHandled();
      return;
    }
    scrollToRowId(rowId);
    let cancelled = false;
    let attempts = 0;
    const tryOpen = () => {
      if (cancelled) return;
      const td = tableScrollRef.current?.querySelector<HTMLElement>(
        `td[data-row-id="${rowId}"][data-column-id="${columnId}"]`,
      );
      if (td) {
        openCellEditor(rowId, columnId, td);
        setHighlightContactId(contactId);
        onContactFocusHandled();
        return;
      }
      attempts += 1;
      if (attempts < 60) requestAnimationFrame(tryOpen);
      else onContactFocusHandled();
    };
    requestAnimationFrame(tryOpen);
    return () => {
      cancelled = true;
    };
    // scrollToRowId/openCellEditor are plain functions redefined every
    // render (not refs) — same reasoning as the focusRowId effect above,
    // this should only re-run when focusContact itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusContact, onContactFocusHandled]);

  // Sort is a one-time, permanent action (see toggleSort below,
  // applySortOrder in useTableStore.ts) — it commits a new row order
  // directly into the data itself the moment a column header is clicked,
  // rather than layering a separate "currently sorted by X" view state on
  // top of `rows`. So there's nothing sort-related left to do here: `rows`
  // already arrives in the right order (same as any other row-reorder
  // action, e.g. manual drag), and this memo only needs to apply the
  // search filter.
  const filteredSortedRows = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.trim().toLowerCase();
    // Phone numbers get typed/stored in wildly different formats
    // ("+370 640 11013" vs "37064011013" vs a bare "64011013") — a plain
    // substring match on the raw text misses all but an exact match.
    // Comparing digits-only (in addition to, not instead of, the normal
    // text match) lets any of those find the same cell. Gated to queries
    // with at least a handful of digits so short numeric searches (a
    // year, a single digit) don't start matching every phone-containing
    // cell in the table.
    const qDigits = normalizePhoneDigits(search);
    const phoneSearchActive = qDigits.length >= MIN_PHONE_SEARCH_DIGITS;
    return rows.filter((row) =>
      Object.values(row.cells).some((v) => {
        if (!v) return false;
        if (v.toLowerCase().includes(q)) return true;
        if (!phoneSearchActive) return false;
        const vDigits = normalizePhoneDigits(v);
        return vDigits.length > 0 && vDigits.includes(qDigits);
      }),
    );
  }, [rows, search]);

  // Kept in sync on every render (not just inside effects) so rAF/timeout
  // callbacks elsewhere in this file (handleAddRow, the focusRowId effect)
  // can look up "the current row list" without closing over a stale array
  // from whichever render scheduled them.
  const filteredSortedRowsRef = useRef(filteredSortedRows);
  filteredSortedRowsRef.current = filteredSortedRows;

  // Renders only the rows actually near the viewport instead of the whole
  // table — without this, importing a realistic CSV (tested with a real
  // 14,617-row / 47-column export) tries to mount on the order of 700,000
  // DOM nodes in one React commit and hangs the tab for minutes, which is
  // indistinguishable from a crash to anyone using it. Row height is always
  // known exactly (row.height ?? DEFAULT_ROW_HEIGHT, never dynamically
  // measured from content), so estimateSize is authoritative, not a guess —
  // no measureElement/ResizeObserver wiring needed. getItemKey returns the
  // row's own id rather than its positional index, which matters here
  // specifically: the virtualizer caches each item's last-known size by
  // this key, so a row's cached height stays correctly attached to *that
  // row* across a sort/search re-order instead of leaking onto whatever
  // row happens to land at the same index afterward.
  const rowVirtualizer = useVirtualizer({
    count: filteredSortedRows.length,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: (index) => filteredSortedRows[index]?.height ?? DEFAULT_ROW_HEIGHT,
    getItemKey: (index) => filteredSortedRows[index]?.id ?? index,
    overscan: 12,
  });

  /** Used by every "jump to this row" interaction (Calendar → Open in
   * table, the Name Box, newly-added rows) instead of the old
   * rowRefs.current.get(id)?.scrollIntoView() — that only worked because
   * every row was always mounted; with virtualization, a row far from the
   * current scroll position simply isn't in the DOM yet, so scrolling has
   * to go through the virtualizer (which knows every item's computed
   * offset even when unmounted) rather than a ref that may not exist. */
  const scrollToRowIndex = (index: number) => {
    rowVirtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
  };
  const scrollToRowId = (id: string) => {
    const index = filteredSortedRowsRef.current.findIndex((r) => r.id === id);
    if (index >= 0) scrollToRowIndex(index);
  };


  // Search still blocks drag/insert — a search-filtered view isn't the
  // table's real row order, so "drag to position N" or "insert above this
  // row" wouldn't mean anything stable once the search clears. Sort no
  // longer needs its own gate here at all: since toggleSort commits a real,
  // permanent row order the instant it's clicked (applySortOrder, in
  // useTableStore.ts) rather than layering a separate live "currently
  // sorted" view state on top of `rows`, there's no second order for a
  // drag or insert to conflict with — `rows` IS the current order, same as
  // any other time. (This used to be two different answers — drag allowed
  // while sorted via a snapshot-splice mechanism, insert still blocked —
  // which was itself a real, reported complaint: sorting used to feel like
  // it "wouldn't let go." Both are just unconditionally allowed now.)
  const rowDragEnabled = search.trim() === '';
  const rowInsertEnabled = search.trim() === '';

  // --- Row-header (number) range selection: click / shift+click / drag ---
  const selectedRowIds = useMemo(() => {
    if (rowRangeAnchor === null) return new Set<string>();
    const focus = rowRangeFocus ?? rowRangeAnchor;
    const lo = Math.max(0, Math.min(rowRangeAnchor, focus));
    const hi = Math.min(filteredSortedRows.length - 1, Math.max(rowRangeAnchor, focus));
    const ids = new Set<string>();
    for (let i = lo; i <= hi; i++) ids.add(filteredSortedRows[i].id);
    return ids;
  }, [rowRangeAnchor, rowRangeFocus, filteredSortedRows]);

  // Selecting rows via the gutter also drives the cell range (rangeAnchor/
  // rangeFocus) to span every column of those rows — matching Excel, where
  // clicking a row number selects that row as a normal range, not a
  // separate concept. Without this, `applyColor`/copy/paste/the formula
  // bar (all of which only ever read the cell range) had no idea a row
  // selection had been made, so e.g. "Color" would silently repaint just
  // whatever single cell was last clicked instead of the selected rows.
  const handleRowNumberMouseDown = (index: number, extend: boolean) => {
    const anchorIndex = extend && rowRangeAnchor !== null ? rowRangeAnchor : index;
    if (extend && rowRangeAnchor !== null) setRowRangeFocus(index);
    else {
      setRowRangeAnchor(index);
      setRowRangeFocus(index);
    }
    setIsRowRangeDragging(true);
    isRowRangeDraggingRef.current = true;
    setRangeAnchor({ r: anchorIndex, c: 0 });
    setRangeFocus({ r: index, c: Math.max(0, columns.length - 1) });
  };
  const handleRowNumberMouseEnter = (index: number) => {
    if (!isRowRangeDragging || rowRangeAnchor === null) return;
    setRowRangeFocus(index);
    setRangeFocus({ r: index, c: Math.max(0, columns.length - 1) });
  };

  // --- Column-header (letter) range selection: click / shift+click / drag ---
  const selectedColumnIds = useMemo(() => {
    if (colRangeAnchor === null) return new Set<string>();
    const focus = colRangeFocus ?? colRangeAnchor;
    const lo = Math.max(0, Math.min(colRangeAnchor, focus));
    const hi = Math.min(columns.length - 1, Math.max(colRangeAnchor, focus));
    const ids = new Set<string>();
    for (let i = lo; i <= hi; i++) ids.add(columns[i].id);
    return ids;
  }, [colRangeAnchor, colRangeFocus, columns]);

  // Same reasoning as handleRowNumberMouseDown above, mirrored for columns.
  const handleColLetterMouseDown = (index: number, extend: boolean) => {
    const anchorIndex = extend && colRangeAnchor !== null ? colRangeAnchor : index;
    if (extend && colRangeAnchor !== null) setColRangeFocus(index);
    else {
      setColRangeAnchor(index);
      setColRangeFocus(index);
    }
    setIsColRangeDragging(true);
    isColRangeDraggingRef.current = true;
    setRangeAnchor({ r: 0, c: anchorIndex });
    setRangeFocus({ r: Math.max(0, filteredSortedRows.length - 1), c: index });
  };
  const handleColLetterMouseEnter = (index: number) => {
    if (!isColRangeDragging || colRangeAnchor === null) return;
    setColRangeFocus(index);
    setRangeFocus({ r: Math.max(0, filteredSortedRows.length - 1), c: index });
  };

  // Finish any drag-select or resize gesture on mouseup, anywhere on the page.
  useEffect(() => {
    const handleMouseUp = () => {
      if (fillDragActiveRef.current) {
        const origin = fillDragOriginRef.current;
        const current = fillDragCurrentRef.current;
        if (origin && current) {
          const targets = computeFillRange(origin, current);
          const rowList = filteredSortedRowsRef.current;
          const colList = columnsRef.current;
          const originRow = rowList[origin.r];
          const originColumn = colList[origin.c];
          if (originRow && originColumn && targets.length > 0) {
            const value = originRow.cells[originColumn.id] ?? '';
            const updates: CellUpdate[] = [];
            for (const t of targets) {
              const row = rowList[t.r];
              const col = colList[t.c];
              if (row && col) updates.push({ rowId: row.id, columnId: col.id, value });
            }
            if (updates.length > 0) {
              const truncated = updateCells(updates);
              const parts = [`Užpildyta langelių: ${updates.length}`];
              if (truncated > 0) parts.push(`apkarpyta pagal Excel ribą: ${truncated}`);
              showToast(parts.join(' · '));
            }
          }
        }
        setFillDragActive(false);
        setFillDragOrigin(null);
        setFillDragCurrent(null);
        setFillDragMousePos(null);
      }
      if (isRowRangeDraggingRef.current || isColRangeDraggingRef.current) {
        justFinishedHeaderDragRef.current = true;
        setTimeout(() => {
          justFinishedHeaderDragRef.current = false;
        }, 0);
      }
      isRowRangeDraggingRef.current = false;
      isColRangeDraggingRef.current = false;
      setIsRangeDragging(false);
      setIsRowRangeDragging(false);
      setIsColRangeDragging(false);
    };
    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
    // showToast/updateCells are Zustand action references — stable across
    // renders (defined once in the store, never reassigned), so closing
    // over "the current one" here is exactly the same as closing over
    // "the only one that will ever exist"; no staleness risk from the
    // empty dependency array, which is deliberate — this listener stays
    // attached once instead of tearing down/re-adding on every render,
    // matching every other global mouseup handler in this file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Cell range selection (formula bar target + copy/paste/color source) ---
  const activeCell = rangeFocus;
  const selection = useMemo(() => {
    if (!activeCell) return null;
    const row = filteredSortedRows[activeCell.r];
    const column = columns[activeCell.c];
    if (!row || !column) return null;
    return { rowId: row.id, columnId: column.id };
  }, [activeCell, filteredSortedRows, columns]);

  const rangeBounds = useMemo(() => {
    if (!rangeAnchor || !rangeFocus) return null;
    return {
      minR: Math.min(rangeAnchor.r, rangeFocus.r),
      maxR: Math.max(rangeAnchor.r, rangeFocus.r),
      minC: Math.min(rangeAnchor.c, rangeFocus.c),
      maxC: Math.max(rangeAnchor.c, rangeFocus.c),
    };
  }, [rangeAnchor, rangeFocus]);
  // A drag-select that spans more than one cell must NOT drop the user into
  // edit mode on whichever cell the mouse happened to release over — that
  // both hijacks the selection into a single-cell edit and (since focus then
  // sits inside that cell's <input>) silently defeats Delete/Backspace's
  // "clear the whole range" handler, which only fires when nothing is
  // focused in a text input. Only a true single-cell selection is editable.
  const isSingleCellSelection =
    !!rangeAnchor && !!rangeFocus && rangeAnchor.r === rangeFocus.r && rangeAnchor.c === rangeFocus.c;

  // Fill handle's on-screen position, in coordinates relative to
  // .table-scroll's own scrollable content (not the viewport) — computed
  // once per relevant change rather than on every scroll tick, because an
  // absolutely-positioned child of a `position: relative; overflow: auto`
  // container scrolls with that container's content automatically once
  // placed; no manual scroll-tracking needed. Only shown for a genuine
  // single-cell selection (same gate DataCell's own editable prop uses),
  // and hidden entirely while a drag is already in progress (dragging the
  // handle itself sets fillDragActive, at which point the *preview*
  // rectangle below takes over instead).
  const [fillHandlePos, setFillHandlePos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const scrollEl = tableScrollRef.current;
    if (!scrollEl || !isSingleCellSelection || fillDragActive) {
      setFillHandlePos(null);
      return;
    }
    const cellEl = scrollEl.querySelector('td.cell-selected');
    if (!(cellEl instanceof HTMLElement)) {
      setFillHandlePos(null);
      return;
    }
    const cellRect = cellEl.getBoundingClientRect();
    const scrollRect = scrollEl.getBoundingClientRect();
    setFillHandlePos({
      top: cellRect.bottom - scrollRect.top + scrollEl.scrollTop,
      left: cellRect.right - scrollRect.left + scrollEl.scrollLeft,
    });
  }, [activeCell, isSingleCellSelection, fillDragActive, filteredSortedRows, columns]);

  // Dashed preview rectangle shown while a fill drag is in progress —
  // pinned to the origin cell's own width/height on the axis that ISN'T
  // being extended (matching computeFillRange's own axis lock: a fill can
  // only go straight down/up/left/right, never diagonal), with the other
  // edge following the live cursor position. The origin cell is still
  // `td.cell-selected` throughout the drag (fillDragActive suppresses the
  // *handle*, not the selection itself), so the same query as above finds
  // it.
  const [fillPreviewRect, setFillPreviewRect] = useState<{ top: number; left: number; width: number; height: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    const scrollEl = tableScrollRef.current;
    if (!scrollEl || !fillDragActive || !fillDragOrigin || !fillDragCurrent || !fillDragMousePos) {
      setFillPreviewRect(null);
      return;
    }
    const cellEl = scrollEl.querySelector('td.cell-selected');
    if (!(cellEl instanceof HTMLElement)) {
      setFillPreviewRect(null);
      return;
    }
    const cellRect = cellEl.getBoundingClientRect();
    const scrollRect = scrollEl.getBoundingClientRect();
    const originTop = cellRect.top - scrollRect.top + scrollEl.scrollTop;
    const originLeft = cellRect.left - scrollRect.left + scrollEl.scrollLeft;
    const originBottom = originTop + cellRect.height;
    const originRight = originLeft + cellRect.width;
    const mouseY = fillDragMousePos.y - scrollRect.top + scrollEl.scrollTop;
    const mouseX = fillDragMousePos.x - scrollRect.left + scrollEl.scrollLeft;

    const dr = fillDragCurrent.r - fillDragOrigin.r;
    const dc = fillDragCurrent.c - fillDragOrigin.c;
    if (Math.abs(dr) >= Math.abs(dc)) {
      const top = Math.min(originTop, mouseY);
      const bottom = Math.max(originBottom, mouseY);
      setFillPreviewRect({ top, left: originLeft, width: cellRect.width, height: bottom - top });
    } else {
      const left = Math.min(originLeft, mouseX);
      const right = Math.max(originRight, mouseX);
      setFillPreviewRect({ top: originTop, left, width: right - left, height: cellRect.height });
    }
  }, [fillDragActive, fillDragOrigin, fillDragCurrent, fillDragMousePos]);

  // --- Name Box (Excel's top-left "C13" reference box) — type a cell or
  // range reference (e.g. "A1:A10000") and jump straight to it, for bulk
  // operations on a huge table without dragging through thousands of rows. ---
  const [nameBoxDraft, setNameBoxDraft] = useState('');
  const nameBoxFocusedRef = useRef(false);
  useEffect(() => {
    if (nameBoxFocusedRef.current) return;
    if (!rangeAnchor || !rangeFocus) {
      setNameBoxDraft('');
    } else if (rangeAnchor.r === rangeFocus.r && rangeAnchor.c === rangeFocus.c) {
      setNameBoxDraft(formatCellRef(rangeFocus));
    } else {
      // A real range is selected (dragged/shift-clicked across more than
      // one cell) — show both endpoints, e.g. "C21:F26", not just the last
      // cell touched, so it reflects what copy/paste/color/Delete would
      // actually act on.
      setNameBoxDraft(`${formatCellRef(rangeAnchor)}:${formatCellRef(rangeFocus)}`);
    }
  }, [rangeAnchor, rangeFocus]);

  const submitNameBox = () => {
    const parsed = parseRangeRef(nameBoxDraft);
    if (!parsed || columns.length === 0) {
      showToast('Įveskite nuorodą, pvz., C13 arba C13:D20');
      setNameBoxDraft(activeCell ? formatCellRef(activeCell) : '');
      return;
    }
    const maxR = Math.max(0, filteredSortedRows.length - 1);
    const maxC = Math.max(0, columns.length - 1);
    const clamp = (pos: { r: number; c: number }) => ({
      r: Math.min(Math.max(0, pos.r), maxR),
      c: Math.min(Math.max(0, pos.c), maxC),
    });
    const anchor = clamp(parsed.anchor);
    const focus = clamp(parsed.focus);
    setRangeAnchor(anchor);
    setRangeFocus(focus);
    setRowRangeAnchor(anchor.r);
    setRowRangeFocus(focus.r);
    if (filteredSortedRows[focus.r]) scrollToRowIndex(focus.r);
  };

  const handleCellMouseDown = (r: number, c: number, extend: boolean, e: ReactMouseEvent | ReactFocusEvent) => {
    // Clicking into the grid means "I'm done with that row/column reorder
    // selection" — clear it rather than leaving it stuck highlighted.
    setRowRangeAnchor(null);
    setRowRangeFocus(null);
    setColRangeAnchor(null);
    setColRangeFocus(null);
    // Any explicit click elsewhere closes a currently-open note/contact
    // editor; DataCell's note/contact branch re-opens it on the same click
    // if that's the cell that was actually clicked (see onOpenEditor below).
    setExpandedCell(null);
    setHighlightContactId(null);
    // Same reasoning as expandedCell above, for the date cell's own 📝/👤
    // mini-popovers — needs clearing here too, not just in closePopovers.
    // A real, reproduced bug without this: clicking a text/phone/company
    // cell (which becomes `editable` on this very mousedown, swapping to a
    // live autoFocus <input>) left the date popover open even though the
    // *next* click's bubble-to-document closePopovers should have caught
    // it — closePopovers does fire, but something about the same tick's
    // editable-cell/autoFocus transition made the popover reappear (or
    // never actually close) in practice. Clearing it immediately on
    // mousedown, before any of that has a chance to happen, sidesteps the
    // race entirely rather than chasing its exact mechanism.
    setDateCellPopover(null);
    if (extend && rangeAnchor) setRangeFocus({ r, c });
    else {
      setRangeAnchor({ r, c });
      setRangeFocus({ r, c });
    }
    // Only a real MouseEvent (onMouseDown) carries coordinates — a
    // FocusEvent (dropdown/date/time controls, see DataCell) has none,
    // since there's no drag concept there; leaving dragStartPosRef unset
    // in that case just means the threshold check in handleCellMouseEnter
    // has nothing to compare against, which never applies to these
    // controls' own interaction anyway.
    if ('clientX' in e) dragStartPosRef.current = { x: e.clientX, y: e.clientY };
    setIsRangeDragging(true);
  };
  // Full Excel-style rectangular drag-select (e.g. A1:C12 — both rows and
  // columns extend), gated by a small pixel-distance threshold from the
  // mousedown position rather than by direction. A plain click on a
  // text/phone/company cell enters edit mode instantly (see DataCell), and
  // real mouse clicks are never perfectly still between mousedown and
  // mouseup — a couple of pixels of drift is normal and, without a
  // threshold, was enough to cross into a neighboring cell's boundary and
  // fire onMouseEnter, silently turning an ordinary click into a 2-cell
  // range (and kicking the clicked cell back out of edit mode in the same
  // stroke). Below the threshold nothing happens, so a click stays a
  // click; past it, dragging behaves exactly like Excel/Sheets in any
  // direction. Shift+click (handleCellMouseDown's `extend` path) is
  // unaffected either way — it's a deliberate, keyboard-modified action,
  // not stray mouse movement.
  const handleCellMouseEnter = (r: number, c: number, e: ReactMouseEvent) => {
    if (fillDragActiveRef.current) {
      setFillDragCurrent({ r, c });
      setFillDragMousePos({ x: e.clientX, y: e.clientY });
      return;
    }
    if (!isRangeDraggingRef.current || !rangeAnchorRef.current) return;
    const start = dragStartPosRef.current;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_SELECT_THRESHOLD_PX) return;
    setRangeFocus({ r, c });
  };

  // Mousedown on the fill handle (rendered below, at the active cell's
  // bottom-right corner) — deliberately does NOT go through
  // handleCellMouseDown, since that would collapse the selection to
  // whatever cell happens to be under the handle instead of starting a
  // fill drag from the cell that's already selected.
  const handleFillHandleMouseDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!activeCell) return;
    setFillDragActive(true);
    setFillDragOrigin(activeCell);
    setFillDragCurrent(activeCell);
  };

  // note/contact cells open CellHoverEditor on click — see DataCell's
  // note/contact branch, which calls this from the cell's own onClick.
  const openCellEditor = (rowId: string, columnId: string, anchor: HTMLElement) => {
    setExpandedCell({ rowId, columnId, anchor });
  };

  // Shared by copy/paste and the Delete-key handler below: only intercept
  // the keyboard shortcut when focus isn't inside some unrelated text field
  // (the search box, a popover input, …).
  const withinTableFocus = () => {
    const active = document.activeElement;
    return active === document.body || !!tableScrollRef.current?.contains(active);
  };

  // A cell being edited is itself an <input> inside .table-scroll, so
  // withinTableFocus() alone can't distinguish "editing this one cell's
  // text" from "the table as a whole is focused" — without this check,
  // highlighting part of a cell's text mid-edit and pressing Ctrl+C copied
  // the *entire cell* instead of the highlighted substring, silently
  // discarding the user's actual selection. Only a genuine, non-collapsed
  // text selection defers to the browser's native copy/paste; a bare
  // cursor position (no highlight) keeps the existing whole-cell/range
  // behavior, since that's how "click a cell, Ctrl+C" already worked.
  //
  // This also has to cover plain (non-input) text selected ANYWHERE on the
  // page, not just inside an <input>/<textarea> — a real, reported bug:
  // Table/Calendar/Calls/Search all stay permanently mounted (switched via
  // CSS visibility, never unmounted), so this component's document-level
  // copy listener is always live regardless of which tab is showing.
  // Selecting plain text (a call transcript, a contact's displayed phone/
  // email, a calendar task's company name — none of them inputs) leaves
  // document.activeElement on document.body, which withinTableFocus()
  // treats as "inside the table," and the old input-only check here
  // returned false for it — so Ctrl+C silently discarded the user's actual
  // selection and copied the table's own selected range instead, with a
  // "Nukopijuota langelių: N" toast to match. window.getSelection() is
  // what actually tracks a real browser text selection anywhere on the
  // page; checking it here closes the gap for every screen at once, not
  // just the table's own inputs.
  const hasActiveTextSelection = () => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      return active.selectionStart !== null && active.selectionStart !== active.selectionEnd;
    }
    const sel = window.getSelection();
    return !!sel && !sel.isCollapsed && sel.toString().length > 0;
  };

  // --- Copy / paste (Excel & Google Sheets interop via the system clipboard) ---
  // buildGridTsv/applyPastedGrid are shared by two entry points: the native
  // copy/paste DOM events below (Ctrl+C/Ctrl+V, driven by the cell range)
  // and the row/column header menus' own Copy/Paste items (driven directly
  // by targetIds, since a right-click doesn't update the cell range — see
  // the note on handleRowContextMenu/handleColumnContextMenu).
  const buildGridTsv = (rowList: Row[], colList: Column[]) => {
    const grid: string[][] = [];
    let cellCount = 0;
    for (const row of rowList) {
      const cells: string[] = [];
      for (const col of colList) {
        cells.push(row.cells[col.id] ?? '');
        cellCount++;
      }
      grid.push(cells);
    }
    return { tsv: buildTsv(grid), cellCount };
  };

  const applyPastedGrid = (grid: string[][], anchor: CellPos, focus: CellPos) => {
    if (grid.length === 0) return;
    const spansMultiple = anchor.r !== focus.r || anchor.c !== focus.c;
    const singleValue = grid.length === 1 && grid[0].length === 1 ? grid[0][0] : null;
    const minR = Math.min(anchor.r, focus.r);
    const minC = Math.min(anchor.c, focus.c);

    const rowIdAt = (r: number): string => {
      if (r < filteredSortedRows.length) return filteredSortedRows[r].id;
      return addRow();
    };

    const updates: CellUpdate[] = [];
    let skippedColumns = false;

    if (singleValue !== null && spansMultiple) {
      const maxR = Math.max(anchor.r, focus.r);
      const maxC = Math.max(anchor.c, focus.c);
      for (let r = minR; r <= maxR; r++) {
        const rowId = rowIdAt(r);
        for (let c = minC; c <= maxC; c++) {
          if (c >= columns.length) {
            skippedColumns = true;
            continue;
          }
          updates.push({ rowId, columnId: columns[c].id, value: singleValue });
        }
      }
    } else {
      grid.forEach((rowValues, i) => {
        const rowId = rowIdAt(minR + i);
        rowValues.forEach((value, j) => {
          const c = minC + j;
          if (c >= columns.length) {
            skippedColumns = true;
            return;
          }
          updates.push({ rowId, columnId: columns[c].id, value });
        });
      });
    }

    // Pasting a value into a dropdown column that doesn't have it yet extends the option list
    // instead of silently dropping the data.
    const extrasByColumn = new Map<string, Set<string>>();
    for (const u of updates) {
      const col = columns.find((c) => c.id === u.columnId);
      if (col?.type === 'dropdown' && u.value && !(col.options ?? []).includes(u.value)) {
        const set = extrasByColumn.get(col.id) ?? new Set<string>();
        set.add(u.value);
        extrasByColumn.set(col.id, set);
      }
    }
    for (const [columnId, extras] of extrasByColumn) {
      const col = columns.find((c) => c.id === columnId)!;
      setDropdownOptions(columnId, [...(col.options ?? []), ...extras]);
    }

    const truncatedCells = updateCells(updates);
    const parts = [`Įklijuota langelių: ${updates.length}`];
    if (truncatedCells > 0) parts.push(`apkarpyta pagal Excel ribą: ${truncatedCells}`);
    if (skippedColumns) parts.push('papildomi stulpeliai, nesantys lentelėje, praleisti');
    showToast(parts.join(' · '));
  };

  // Row/column header menus' Copy — deliberately independent of rangeBounds:
  // a right-click that lands outside the current selection only updates
  // rowRangeAnchor/colRangeAnchor (see handleRowContextMenu below), not the
  // cell range, so reading rangeBounds here could copy stale, unrelated
  // cells instead of the rows/columns actually right-clicked.
  const copyRowsToClipboard = async (targetIds: string[]) => {
    const targetSet = new Set(targetIds);
    const rowList = filteredSortedRows.filter((r) => targetSet.has(r.id));
    const { tsv, cellCount } = buildGridTsv(rowList, columns);
    try {
      await navigator.clipboard.writeText(tsv);
      showToast(`Nukopijuota eilučių: ${targetIds.length} (langelių: ${cellCount})`);
    } catch {
      showToast('Nepavyko nukopijuoti — iškarpinės prieiga užblokuota');
    }
  };
  const copyColumnsToClipboard = async (targetIds: string[]) => {
    const targetSet = new Set(targetIds);
    const colList = columns.filter((c) => targetSet.has(c.id));
    const { tsv, cellCount } = buildGridTsv(filteredSortedRows, colList);
    try {
      await navigator.clipboard.writeText(tsv);
      showToast(`Nukopijuota stulpelių: ${targetIds.length} (langelių: ${cellCount})`);
    } catch {
      showToast('Nepavyko nukopijuoti — iškarpinės prieiga užblokuota');
    }
  };
  const pasteAtRows = async (targetIds: string[]) => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      showToast('Nepavyko nuskaityti iškarpinės — patikrinkite naršyklės iškarpinės leidimą');
      return;
    }
    if (!text) return;
    const targetSet = new Set(targetIds);
    const firstIndex = filteredSortedRows.findIndex((r) => targetSet.has(r.id));
    if (firstIndex < 0) return;
    applyPastedGrid(parseTsv(text), { r: firstIndex, c: 0 }, { r: firstIndex, c: 0 });
  };
  const pasteAtColumns = async (targetIds: string[]) => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      showToast('Nepavyko nuskaityti iškarpinės — patikrinkite naršyklės iškarpinės leidimą');
      return;
    }
    if (!text) return;
    const targetSet = new Set(targetIds);
    const firstIndex = columns.findIndex((c) => targetSet.has(c.id));
    if (firstIndex < 0) return;
    applyPastedGrid(parseTsv(text), { r: 0, c: firstIndex }, { r: 0, c: firstIndex });
  };

  useEffect(() => {
    const handleCopy = (e: ClipboardEvent) => {
      if (!withinTableFocus() || !rangeBounds || hasActiveTextSelection()) return;
      const { minR, maxR, minC, maxC } = rangeBounds;
      if (minR >= filteredSortedRows.length || minC >= columns.length) return;
      e.preventDefault();
      const rowList = filteredSortedRows.slice(minR, Math.min(maxR, filteredSortedRows.length - 1) + 1);
      const colList = columns.slice(minC, Math.min(maxC, columns.length - 1) + 1);
      const { tsv, cellCount } = buildGridTsv(rowList, colList);
      e.clipboardData?.setData('text/plain', tsv);
      showToast(`Nukopijuota langelių: ${cellCount}`);
    };

    const handlePaste = (e: ClipboardEvent) => {
      if (!withinTableFocus() || !rangeFocus || hasActiveTextSelection()) return;
      const text = e.clipboardData?.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      applyPastedGrid(parseTsv(text), rangeAnchor ?? rangeFocus, rangeFocus);
    };

    document.addEventListener('copy', handleCopy);
    document.addEventListener('paste', handlePaste);
    return () => {
      document.removeEventListener('copy', handleCopy);
      document.removeEventListener('paste', handlePaste);
    };
    // applyPastedGrid is deliberately omitted below: it's a plain,
    // unmemoized closure recreated every render (matching how this file
    // handles helper functions elsewhere), and every reactive value it
    // reads from — filteredSortedRows, columns, addRow, updateCells,
    // setDropdownOptions, showToast — is already listed, so there's no
    // actual staleness risk; adding it here would just make this effect
    // tear down and resubscribe its listeners on every render instead of
    // only when something it actually depends on changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rangeBounds, rangeAnchor, rangeFocus, filteredSortedRows, columns, addRow, updateCells, setDropdownOptions, showToast]);

  // Delete/Backspace on a selected cell (or range) clears its contents
  // immediately — no need to double-click in, select-all, then delete
  // character by character. Only fires when nothing is actively being typed
  // into (a focused <textarea>/<input> handles its own Delete/Backspace).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (!withinTableFocus() || !rangeBounds) return;
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;
      e.preventDefault();
      const { minR, maxR, minC, maxC } = rangeBounds;
      const updates: CellUpdate[] = [];
      for (let r = minR; r <= Math.min(maxR, filteredSortedRows.length - 1); r++) {
        for (let c = minC; c <= Math.min(maxC, columns.length - 1); c++) {
          updates.push({ rowId: filteredSortedRows[r].id, columnId: columns[c].id, value: '' });
        }
      }
      if (updates.length === 0) return;
      updateCells(updates);
      showToast(`Išvalyta langelių: ${updates.length}`);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [rangeBounds, filteredSortedRows, columns, updateCells, showToast]);

  // Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z (or Ctrl+Y) to redo.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (!withinTableFocus()) return;
        e.preventDefault();
        undo();
      } else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
        if (!withinTableFocus()) return;
        e.preventDefault();
        redo();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo]);

  // Ctrl/Cmd+F jumps into the app's own search box instead of the
  // browser's native find — which, against this row-virtualized table,
  // mostly fails anyway: native find can only match text actually in the
  // DOM, and almost all rows in a real-sized table aren't mounted at any
  // given moment. Always intercepted while this view is mounted (not
  // gated by withinTableFocus() like undo/redo) — there's nothing else on
  // this screen a native browser find would usefully serve instead.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const applyColor = (color: string | null) => {
    if (!rangeBounds) return;
    const { minR, maxR, minC, maxC } = rangeBounds;
    const updates: CellColorUpdate[] = [];
    for (let r = minR; r <= maxR && r < filteredSortedRows.length; r++) {
      for (let c = minC; c <= maxC && c < columns.length; c++) {
        updates.push({ rowId: filteredSortedRows[r].id, columnId: columns[c].id, color });
      }
    }
    setCellColors(updates);
    if (color) setRecentColors(saveRecentColor(color));
    setColorPickerAnchor(null);
  };

  // Sorting is a one-time, permanent action — on explicit request: "the
  // filter should do its job once and then be done," not hold a separate
  // "currently sorted" mode that other actions (drag, insert) have to work
  // around or that needs its own "turn it off" step. An earlier version
  // kept `sort` as persistent view state (asc/desc/null, shown as a
  // header arrow, snapshotted into sortSnapshotRef so drag-while-sorted
  // wouldn't get undone by a live re-sort) — correct, but still visibly
  // "on" after running, which is exactly what was reported as the problem.
  // Now a click just computes the new order and commits it for real via
  // applySortOrder (useTableStore.ts), the same way a manual drag commits
  // an order — so immediately afterward there is nothing sort-related
  // left "active" at all. lastSortRef is a plain ref (not state) purely so
  // a second click on the same header still flips asc -> desc rather than
  // sorting ascending every time; it drives no rendering.
  const commitSort = (columnId: string, direction: SortDirection) => {
    const order = [...rows]
      .sort((a, b) => {
        const av = a.cells[columnId] ?? '';
        const bv = b.cells[columnId] ?? '';
        const cmp = av.localeCompare(bv, 'en');
        return direction === 'asc' ? cmp : -cmp;
      })
      .map((r) => r.id);
    applySortOrder(order);
    lastSortRef.current = { columnId, direction };
  };
  const toggleSort = (columnId: string) => {
    const prev = lastSortRef.current;
    const direction: SortDirection = prev?.columnId === columnId && prev.direction === 'asc' ? 'desc' : 'asc';
    commitSort(columnId, direction);
  };

  // Right-clicking a column not already part of the current selection
  // collapses the selection to just that column first, matching Excel —
  // right-clicking *within* an existing multi-column selection keeps it, so
  // "Insert 3 columns left" etc. applies to the whole selection.
  const handleColumnContextMenu = (e: ReactMouseEvent, col: Column, index: number) => {
    e.preventDefault();
    setRowContextMenu(null);
    let targetIds: string[];
    if (selectedColumnIds.has(col.id)) {
      targetIds = columns.filter((c) => selectedColumnIds.has(c.id)).map((c) => c.id);
    } else {
      setColRangeAnchor(index);
      setColRangeFocus(index);
      targetIds = [col.id];
    }
    setColumnContextMenu({ x: e.clientX, y: e.clientY, targetIds });
  };

  const handleRowContextMenu = (e: ReactMouseEvent, row: Row, index: number) => {
    e.preventDefault();
    setColumnContextMenu(null);
    let targetIds: string[];
    if (selectedRowIds.has(row.id)) {
      targetIds = filteredSortedRows.filter((r) => selectedRowIds.has(r.id)).map((r) => r.id);
    } else {
      setRowRangeAnchor(index);
      setRowRangeFocus(index);
      targetIds = [row.id];
    }
    setRowContextMenu({ x: e.clientX, y: e.clientY, targetIds });
  };

  // moveRows/moveColumns reorder the underlying data, but rowRangeAnchor/
  // rowRangeFocus (colRangeAnchor/colRangeFocus) are plain *positional*
  // indices — left untouched by a move, they keep highlighting whatever
  // index range they already pointed at, which after a reorder is simply
  // wherever the moved rows/columns *used* to be, now occupied by different
  // content. This was a real, reported bug: dragging a 3-row selection
  // elsewhere left the highlight sitting on the old slot, making it look
  // like nothing had moved. These refs carry the just-moved ids across the
  // render where moveRows/moveColumns's new order actually lands in
  // filteredSortedRows/columns, so the effects below can re-point the
  // selection at wherever that data ended up.
  const pendingRowSelectionSyncRef = useRef<string[] | null>(null);
  const pendingColumnSelectionSyncRef = useRef<string[] | null>(null);

  useEffect(() => {
    const ids = pendingRowSelectionSyncRef.current;
    if (!ids) return;
    pendingRowSelectionSyncRef.current = null;
    const indices = ids
      .map((id) => filteredSortedRows.findIndex((r) => r.id === id))
      .filter((i) => i !== -1);
    if (indices.length === 0) return;
    const lo = Math.min(...indices);
    const hi = Math.max(...indices);
    setRowRangeAnchor(lo);
    setRowRangeFocus(hi);
    // rowRangeAnchor/rowRangeFocus alone only drive selectedRowIds (the
    // "Ištrinti pasirinktas"/insert-above-below machinery) — the actual
    // *visible* box-shadow highlight and the Name Box both read the
    // separate cell-range (rangeAnchor/rangeFocus), which a row-gutter
    // click also sets, matching Excel's "clicking a row number selects it
    // as a normal range" (see handleRowNumberMouseDown above). Without
    // updating this too, the highlight the user actually looks at stayed
    // pinned to the pre-move index range.
    setRangeAnchor({ r: lo, c: 0 });
    setRangeFocus({ r: hi, c: Math.max(0, columns.length - 1) });
  }, [filteredSortedRows, columns.length]);

  useEffect(() => {
    const ids = pendingColumnSelectionSyncRef.current;
    if (!ids) return;
    pendingColumnSelectionSyncRef.current = null;
    const indices = ids
      .map((id) => columns.findIndex((c) => c.id === id))
      .filter((i) => i !== -1);
    if (indices.length === 0) return;
    const lo = Math.min(...indices);
    const hi = Math.max(...indices);
    setColRangeAnchor(lo);
    setColRangeFocus(hi);
    // Same reasoning as the row effect above, mirrored for columns.
    setRangeAnchor({ r: 0, c: lo });
    setRangeFocus({ r: Math.max(0, filteredSortedRows.length - 1), c: hi });
  }, [columns, filteredSortedRows.length]);

  // --- Column drag-reorder (grip handle) ---
  const handleColGripDragStart = (e: DragEvent, col: (typeof columns)[number], index: number) => {
    if (!selectedColumnIds.has(col.id)) {
      setColRangeAnchor(index);
      setColRangeFocus(index);
    }
    const ids = selectedColumnIds.has(col.id) ? Array.from(selectedColumnIds) : [col.id];
    setDragColumnIds(ids);
    e.dataTransfer.effectAllowed = 'move';
  };
  const dropColumnIndexFromEvent = (e: DragEvent, colIndex: number) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientX > rect.left + rect.width / 2;
    return { after, targetIndex: after ? colIndex + 1 : colIndex };
  };
  const handleColumnDragOver = (e: DragEvent, columnId: string, index: number) => {
    if (!dragColumnIds || dragColumnIds.includes(columnId)) return;
    e.preventDefault();
    const { after } = dropColumnIndexFromEvent(e, index);
    setDragOverColumnId(columnId);
    setDragOverColumnAfter(after);
  };
  const handleColumnDrop = (e: DragEvent, columnId: string, index: number) => {
    e.preventDefault();
    if (dragColumnIds && !dragColumnIds.includes(columnId)) {
      const { targetIndex } = dropColumnIndexFromEvent(e, index);
      const target = targetIndex < columns.length ? columns[targetIndex] : null;
      moveColumns(dragColumnIds, target ? target.id : null);
      pendingColumnSelectionSyncRef.current = dragColumnIds;
    }
    setDragColumnIds(null);
    setDragOverColumnId(null);
    setDragOverColumnAfter(false);
  };
  const handleColumnDragEnd = () => {
    setDragColumnIds(null);
    setDragOverColumnId(null);
    setDragOverColumnAfter(false);
  };

  // --- Row drag-reorder (grip handle) ---
  const handleRowGripDragStart = (e: DragEvent, rowId: string, index: number) => {
    if (!rowDragEnabled) {
      e.preventDefault();
      return;
    }
    if (!selectedRowIds.has(rowId)) {
      setRowRangeAnchor(index);
      setRowRangeFocus(index);
    }
    const ids = selectedRowIds.has(rowId) ? Array.from(selectedRowIds) : [rowId];
    setDragRowIds(ids);
    e.dataTransfer.effectAllowed = 'move';
  };
  const dropRowIndexFromEvent = (e: DragEvent, rowIndex: number) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    return { after, targetIndex: after ? rowIndex + 1 : rowIndex };
  };
  const handleRowDragOver = (e: DragEvent, rowId: string, rowIndex: number) => {
    if (!dragRowIds || dragRowIds.includes(rowId)) return;
    e.preventDefault();
    const { after } = dropRowIndexFromEvent(e, rowIndex);
    setDragOverRowId(rowId);
    setDragOverAfter(after);
  };
  const handleRowDrop = (e: DragEvent, rowId: string, rowIndex: number) => {
    e.preventDefault();
    if (dragRowIds && !dragRowIds.includes(rowId)) {
      const { targetIndex } = dropRowIndexFromEvent(e, rowIndex);
      const target = targetIndex < filteredSortedRows.length ? filteredSortedRows[targetIndex] : null;
      moveRows(dragRowIds, target ? target.id : null);
      pendingRowSelectionSyncRef.current = dragRowIds;
    }
    setDragRowIds(null);
    setDragOverRowId(null);
    setDragOverAfter(false);
  };
  const handleRowDropAtEnd = (e: DragEvent) => {
    e.preventDefault();
    if (dragRowIds) {
      moveRows(dragRowIds, null);
      pendingRowSelectionSyncRef.current = dragRowIds;
    }
    setDragRowIds(null);
    setDragOverRowId(null);
    setDragOverAfter(false);
  };
  const handleRowDragEnd = () => {
    setDragRowIds(null);
    setDragOverRowId(null);
    setDragOverAfter(false);
  };

  // Auto-scroll while dragging a row near the top/bottom edge of the
  // scroll container — a real, reported gap: the table is virtualized (see
  // the class doc comment on the virtualizer below), so only rows near the
  // current viewport actually exist as DOM elements with drop handlers on
  // them. Without this, dragging row 37 up to row 2 (or the reverse) was
  // structurally impossible whenever row 2 wasn't already mounted — native
  // HTML5 drag events have nothing to fire dragover/drop on for a target
  // that isn't rendered, and nothing was scrolling the container to bring
  // it into view during the drag. Effect only runs while a row drag is
  // actually in progress (`dragRowIds` non-null); handleRowDragEnd
  // resetting it to null on every drag end (dropped or cancelled) is what
  // reliably tears this down again, so no separate document-level
  // dragend listener is needed here.
  useEffect(() => {
    if (!dragRowIds) return;
    const scrollEl = tableScrollRef.current;
    if (!scrollEl) return;

    const EDGE_ZONE_PX = 60;
    const MAX_SPEED_PX_PER_FRAME = 18;
    let scrollSpeed = 0;
    let rafId = requestAnimationFrame(function tick() {
      if (scrollSpeed !== 0) scrollEl.scrollTop += scrollSpeed;
      rafId = requestAnimationFrame(tick);
    });

    const handleDragOver = (e: globalThis.DragEvent) => {
      const rect = scrollEl.getBoundingClientRect();
      const y = e.clientY;
      if (y < rect.top + EDGE_ZONE_PX) {
        const proximity = Math.min(1, (rect.top + EDGE_ZONE_PX - y) / EDGE_ZONE_PX);
        scrollSpeed = -MAX_SPEED_PX_PER_FRAME * proximity;
      } else if (y > rect.bottom - EDGE_ZONE_PX) {
        const proximity = Math.min(1, (y - (rect.bottom - EDGE_ZONE_PX)) / EDGE_ZONE_PX);
        scrollSpeed = MAX_SPEED_PX_PER_FRAME * proximity;
      } else {
        scrollSpeed = 0;
      }
    };
    // Recomputed on every dragover anyway (many times/sec while the mouse
    // moves), so scrollSpeed naturally goes back to 0 the instant the
    // cursor isn't near an edge anymore — no dragleave handling needed,
    // which would otherwise have to fight the classic nested-child
    // dragenter/dragleave bubbling problem (rows are children of this same
    // scroll container).
    scrollEl.addEventListener('dragover', handleDragOver);

    return () => {
      cancelAnimationFrame(rafId);
      scrollEl.removeEventListener('dragover', handleDragOver);
    };
  }, [dragRowIds]);

  // --- Column resize ---
  // Live values live in a ref (not just state) so `handleUp` can read the
  // latest width without calling the zustand setter from inside a setState
  // updater — doing that from within setResizingColumn's updater tripped
  // React's "update while rendering a different component" warning, since
  // updater functions are expected to be pure.
  const resizingColumnLive = useRef<{ id: string; width: number } | null>(null);
  const startColumnResize = (e: ReactMouseEvent, col: (typeof columns)[number]) => {
    e.preventDefault();
    e.stopPropagation();
    const startWidth = col.width ?? DEFAULT_COLUMN_WIDTH;
    resizingColumnLive.current = { id: col.id, width: startWidth };
    setResizingColumn({ id: col.id, startX: e.clientX, startWidth, liveWidth: startWidth });
  };
  useEffect(() => {
    if (!resizingColumn) return;
    const handleMove = (e: globalThis.MouseEvent) => {
      const delta = e.clientX - resizingColumn.startX;
      const liveWidth = Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, resizingColumn.startWidth + delta));
      resizingColumnLive.current = { id: resizingColumn.id, width: liveWidth };
      setResizingColumn((prev) => (prev ? { ...prev, liveWidth } : prev));
    };
    const handleUp = () => {
      if (resizingColumnLive.current) setColumnWidth(resizingColumnLive.current.id, resizingColumnLive.current.width);
      setResizingColumn(null);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizingColumn?.id]);

  // --- Row resize --- (same ref-based pattern as column resize above)
  const resizingRowLive = useRef<{ id: string; height: number } | null>(null);
  const startRowResize = (e: ReactMouseEvent, row: (typeof rows)[number]) => {
    e.preventDefault();
    e.stopPropagation();
    const startHeight = row.height ?? DEFAULT_ROW_HEIGHT;
    resizingRowLive.current = { id: row.id, height: startHeight };
    setResizingRow({ id: row.id, startY: e.clientY, startHeight, liveHeight: startHeight });
  };
  useEffect(() => {
    if (!resizingRow) return;
    // The virtualizer has to be told explicitly whenever a row's real
    // height changes — it caches each row's last-known size (keyed by row
    // id, see rowVirtualizer's getItemKey above) and never re-derives it
    // from estimateSize on its own once cached, so every row below the one
    // being resized would stay frozen at its pre-drag position otherwise.
    // Resolved once per gesture, not per tick, since the row being resized
    // doesn't change identity mid-drag.
    const index = filteredSortedRowsRef.current.findIndex((r) => r.id === resizingRow.id);
    const handleMove = (e: globalThis.MouseEvent) => {
      const delta = e.clientY - resizingRow.startY;
      const liveHeight = Math.max(MIN_ROW_HEIGHT, Math.min(MAX_ROW_HEIGHT, resizingRow.startHeight + delta));
      resizingRowLive.current = { id: resizingRow.id, height: liveHeight };
      if (index >= 0) rowVirtualizer.resizeItem(index, liveHeight);
      setResizingRow((prev) => (prev ? { ...prev, liveHeight } : prev));
    };
    const handleUp = () => {
      if (resizingRowLive.current) setRowHeight(resizingRowLive.current.id, resizingRowLive.current.height);
      setResizingRow(null);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resizingRow?.id]);

  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    // Parsing + building row objects for a large file (tested against a
    // real ~12MB / 14,617-row export) takes on the order of a second —
    // fine on its own, but with zero feedback that briefly reads as "did
    // my click even register?" A quick interim toast (superseded by the
    // real "Imported N rows" one the instant it's ready) is enough to
    // close that gap without needing a real progress bar. Skipped for
    // small files, where it would just flash and disappear pointlessly.
    if (file.size > 1_000_000) showToast(`Importuojama ${(file.size / 1_000_000).toFixed(1)} MB…`);
    try {
      const { headers, rows: dataRows } = await parseCsvFile(file);
      if (headers.length === 0) {
        showToast('Failas tuščias arba nepavyko jo nuskaityti');
        return;
      }
      // Hand off to the CsvImportMapping modal rather than importing
      // immediately — see its own doc comment for why every header needs an
      // explicit column/type decision instead of the old auto-match-or-
      // create-as-text behavior.
      setPendingImport({ headers, dataRows });
    } catch {
      showToast('Nepavyko importuoti failo');
    }
  };

  const handleConfirmImport = (mapping: Record<string, ImportColumnMapping>) => {
    if (!pendingImport) return;
    const { headers, dataRows } = pendingImport;
    setPendingImport(null);
    const result = importCsvRows(headers, dataRows, mapping);
    const parts = [`Importuota eilučių: ${result.createdRows}`];
    if (result.createdColumns > 0) parts.push(`naujų stulpelių: ${result.createdColumns}`);
    if (result.truncatedCells > 0) parts.push(`apkarpytų langelių: ${result.truncatedCells}`);
    showToast(parts.join(' · '));
  };

  const handleExport = () => {
    const csv = exportRowsToCsv(columns, rows);
    const date = new Date().toISOString().slice(0, 10);
    downloadCsv(`companies-${date}.csv`, csv);
  };

  const handleAddRow = () => {
    const id = addRow();
    // The new row only exists in `rows`/`filteredSortedRows` starting next
    // render — rAF to wait for that, then read the ref (always current,
    // unlike a closed-over `filteredSortedRows` from this render) rather
    // than assuming a fixed "it's always the last index" position, since a
    // search/sort can place it anywhere or filter it out entirely.
    requestAnimationFrame(() => scrollToRowId(id));
  };

  const handleDeleteSelected = async () => {
    if (selectedRowIds.size === 0) return;
    const ok = await confirmDialog({ message: `Ištrinti pasirinktas eilutes (${selectedRowIds.size})?`, danger: true });
    if (ok) {
      removeRows(Array.from(selectedRowIds));
      setRowRangeAnchor(null);
      setRowRangeFocus(null);
    }
  };

  const closePopovers = () => {
    setAddColumnAnchor(null);
    setOpenMenu(null);
    setColorPickerAnchor(null);
    setExpandedCell(null);
    setHighlightContactId(null);
    setColumnContextMenu(null);
    setRowContextMenu(null);
    setHiddenColumnsAnchor(null);
    setDateCellPopover(null);
    if (!justFinishedHeaderDragRef.current) {
      setRowRangeAnchor(null);
      setRowRangeFocus(null);
      setColRangeAnchor(null);
      setColRangeFocus(null);
    }
  };

  // A document-level listener, not `.table-view`'s own onClick — clicking
  // the app header (title, Table/Calendar/Calls tabs, "← Workspace") sits
  // *outside* `.table-view`'s DOM subtree, so a click there never bubbled
  // to an onClick scoped to this div, and an open note/contact editor
  // (CellHoverEditor, portaled to document.body) could get stuck open —
  // which, since it's positioned on top of the grid, then intercepted
  // clicks meant for whatever cell was underneath it. Popovers/editors
  // that should survive a click on themselves already call
  // e.stopPropagation() in their own onClick (CellHoverEditor, Popover,
  // DataCell's note/contact open-click) — that still works exactly the
  // same against a document listener, since a stopped SyntheticEvent's
  // underlying native event genuinely stops bubbling before it reaches
  // document, not just within React's own tree.
  useEffect(() => {
    document.addEventListener('click', closePopovers);
    return () => document.removeEventListener('click', closePopovers);
  });

  const virtualRows = rowVirtualizer.getVirtualItems();

  return (
    <div className="table-view">
      <div className="toolbar">
        <input
          className="name-box"
          title="Vardo laukas — įveskite langelio ar srities nuorodą (pvz., C13 arba A1:A10000) ir spauskite Enter, kad ją pasirinktumėte"
          placeholder="A1"
          value={nameBoxDraft}
          onChange={(e) => setNameBoxDraft(e.target.value)}
          onFocus={(e) => {
            nameBoxFocusedRef.current = true;
            e.currentTarget.select();
          }}
          onBlur={() => {
            nameBoxFocusedRef.current = false;
            setNameBoxDraft(activeCell ? formatCellRef(activeCell) : '');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              submitNameBox();
              e.currentTarget.blur();
            }
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
        <input
          ref={searchInputRef}
          className="search-input"
          type="search"
          placeholder="Ieškoti visoje lentelėje… (Ctrl/Cmd+F)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') e.currentTarget.blur();
          }}
        />
        <button type="button" title="Anuliuoti (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
          ↶
        </button>
        <button type="button" title="Grąžinti (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
          ↷
        </button>
        <div className="toolbar-spacer" />
        {selectedRowIds.size > 0 && (
          <button type="button" className="danger" onClick={handleDeleteSelected}>
            Ištrinti pasirinktas ({selectedRowIds.size})
          </button>
        )}
        <button
          type="button"
          disabled={!rangeBounds}
          onClick={(e) => {
            e.stopPropagation();
            const anchor = e.currentTarget;
            setColorPickerAnchor((prev) => (prev ? null : anchor));
          }}
        >
          🎨 Spalva
        </button>
        {colorPickerAnchor && (
          <Popover anchor={colorPickerAnchor} width={200}>
            <div className="color-palette-label">Užpildymo spalva</div>
            <div className="color-palette">
              {PRESET_COLORS.map((c) => (
                <button key={c} type="button" className="color-swatch" style={{ background: c }} onClick={() => applyColor(c)} />
              ))}
              {recentColors.map((c) => (
                <button key={c} type="button" className="color-swatch" style={{ background: c }} onClick={() => applyColor(c)} />
              ))}
              <label className="color-swatch color-swatch-custom" title="Pasirinktinė spalva">
                +
                <ColorInput onCommit={applyColor} />
              </label>
            </div>
            <button type="button" className="color-clear-btn" onClick={() => applyColor(null)}>
              Išvalyti spalvą
            </button>
          </Popover>
        )}
        {addColumnAnchor && <AddColumnPopover anchor={addColumnAnchor} onClose={() => setAddColumnAnchor(null)} />}
        {hiddenColumns.length > 0 && (
          <button
            type="button"
            title="Rodyti paslėptus stulpelius"
            onClick={(e) => {
              e.stopPropagation();
              const anchor = e.currentTarget;
              setHiddenColumnsAnchor((prev) => (prev ? null : anchor));
            }}
          >
            🔒 Paslėpta: {hiddenColumns.length}
          </button>
        )}
        {hiddenColumnsAnchor && (
          <HiddenColumnsPopover anchor={hiddenColumnsAnchor} columns={columns} onClose={() => setHiddenColumnsAnchor(null)} />
        )}
        <button type="button" onClick={handleImportClick}>
          Importuoti CSV
        </button>
        <input ref={fileInputRef} type="file" accept=".csv,text/csv" hidden onChange={handleFileChange} />
        <button type="button" onClick={handleExport}>
          Eksportuoti CSV
        </button>
        {pendingImport && (
          <CsvImportMapping
            headers={pendingImport.headers}
            dataRows={pendingImport.dataRows}
            columns={columns}
            onConfirm={handleConfirmImport}
            onCancel={() => setPendingImport(null)}
          />
        )}
        {columnContextMenu && (
          <ColumnHeaderMenu
            x={columnContextMenu.x}
            y={columnContextMenu.y}
            columns={columns}
            targetIds={columnContextMenu.targetIds}
            onSort={(direction) => commitSort(columnContextMenu.targetIds[0], direction)}
            onCopy={() => copyColumnsToClipboard(columnContextMenu.targetIds)}
            onPaste={() => pasteAtColumns(columnContextMenu.targetIds)}
            onClose={() => setColumnContextMenu(null)}
          />
        )}
        {rowContextMenu && (
          <RowHeaderMenu
            x={rowContextMenu.x}
            y={rowContextMenu.y}
            rows={filteredSortedRows}
            targetIds={rowContextMenu.targetIds}
            insertEnabled={rowInsertEnabled}
            onCopy={() => copyRowsToClipboard(rowContextMenu.targetIds)}
            onPaste={() => pasteAtRows(rowContextMenu.targetIds)}
            onClose={() => setRowContextMenu(null)}
          />
        )}
      </div>

      <FormulaBar selection={selection} columns={columns} rows={rows} />

      {columns.length === 0 ? (
        <div className="empty-state">
          Stulpelių dar nėra —{' '}
          <button
            type="button"
            className="empty-state-add-column"
            onClick={(e) => {
              e.stopPropagation();
              const anchor = e.currentTarget;
              setAddColumnAnchor((prev) => (prev ? null : anchor));
            }}
          >
            + Pridėti stulpelį
          </button>{' '}
          arba importuokite CSV.
        </div>
      ) : (
        <div className="table-scroll" ref={tableScrollRef}>
          <table className="sheet">
            <colgroup>
              <col style={{ width: GUTTER_WIDTH }} />
              {columns.map((col) =>
                col.hidden ? (
                  // visibility: collapse is the purpose-built way to hide a
                  // table column — unlike display:none on individual cells,
                  // it keeps every row's cell count/alignment intact (no
                  // column-counting ambiguity between header and body rows)
                  // while removing the space the column would have taken.
                  <col key={col.id} style={{ visibility: 'collapse' }} />
                ) : (
                  <col
                    key={col.id}
                    style={{ width: resizingColumn?.id === col.id ? resizingColumn.liveWidth : col.width ?? DEFAULT_COLUMN_WIDTH }}
                  />
                ),
              )}
              <col style={{ width: ADD_COLUMN_WIDTH }} />
            </colgroup>
            <thead>
              <tr className="letters-row">
                <th className="gutter-header" />
                {columns.map((col, index) => (
                  <th
                    key={col.id}
                    className={[
                      'letter-cell',
                      selectedColumnIds.has(col.id) && 'letter-cell-selected',
                      dragOverColumnId === col.id && (dragOverColumnAfter ? 'col-drop-after' : 'col-drop-before'),
                      dragColumnIds?.includes(col.id) && 'col-dragging',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onDragOver={(e) => handleColumnDragOver(e, col.id, index)}
                    onDrop={(e) => handleColumnDrop(e, col.id, index)}
                    onContextMenu={(e) => handleColumnContextMenu(e, col, index)}
                  >
                    <div className="letter-cell-inner">
                      <span
                        className="col-grip"
                        draggable
                        onDragStart={(e) => handleColGripDragStart(e, col, index)}
                        onDragEnd={handleColumnDragEnd}
                        title="Vilkite, kad pakeistumėte stulpelių tvarką"
                      >
                        ⠿
                      </span>
                      <span
                        className="col-letter"
                        onMouseDown={(e) => {
                          if (e.button !== 0) return;
                          e.stopPropagation();
                          handleColLetterMouseDown(index, e.shiftKey);
                        }}
                        onMouseEnter={() => handleColLetterMouseEnter(index)}
                        onClick={(e) => e.stopPropagation()}
                        title="Spustelėkite arba shift+spustelėkite / vilkite, kad pasirinktumėte kelis stulpelius — dešiniuoju paspaudimu daugiau veiksmų"
                      >
                        {columnLetter(index)}
                      </span>
                    </div>
                    <div className="col-resize-handle" onMouseDown={(e) => startColumnResize(e, col)} />
                  </th>
                ))}
                <th
                  className="add-column-header"
                  rowSpan={2}
                  title="Pridėti stulpelį"
                  onClick={(e) => {
                    e.stopPropagation();
                    const anchor = e.currentTarget;
                    setAddColumnAnchor((prev) => (prev ? null : anchor));
                  }}
                >
                  +
                </th>
              </tr>
              <tr>
                <th className="gutter-header" />
                {columns.map((col) => (
                  <th key={col.id} onContextMenu={(e) => handleColumnContextMenu(e, col, columns.indexOf(col))}>
                    <div className="th-content">
                      <button type="button" className="th-name" onClick={() => toggleSort(col.id)}>
                        {col.name}
                      </button>
                      <button
                        type="button"
                        className="th-menu-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          const anchor = e.currentTarget;
                          setOpenMenu((prev) => (prev?.columnId === col.id ? null : { columnId: col.id, anchor }));
                        }}
                      >
                        ⋮
                      </button>
                      {openMenu?.columnId === col.id && (
                        <ColumnMenu column={col} anchor={openMenu.anchor} onClose={() => setOpenMenu(null)} />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Top/bottom "phantom" rows reserve the scroll height for
                  every row that *isn't* currently mounted — a real <table>
                  can't absolutely-position individual <tr>s the way a
                  div-based grid can, so the standard (and TanStack's own
                  documented) approach for virtualizing an actual HTML table
                  is padding rows rather than transforms. Only rendered when
                  there's something to skip, so an empty/short table isn't
                  carrying two extra zero-height rows for no reason. */}
              {virtualRows.length > 0 && virtualRows[0].start > 0 && (
                <tr aria-hidden style={{ height: virtualRows[0].start }}>
                  <td colSpan={columns.length + 1} style={{ padding: 0, border: 'none' }} />
                </tr>
              )}
              {virtualRows.map((virtualRow) => {
                const row = filteredSortedRows[virtualRow.index];
                if (!row) return null;
                const index = virtualRow.index;
                return (
                  <tr
                    key={row.id}
                    style={{ height: resizingRow?.id === row.id ? resizingRow.liveHeight : row.height ?? DEFAULT_ROW_HEIGHT }}
                    className={[
                      flashRowId === row.id && 'row-flash',
                      selectedRowIds.has(row.id) && 'row-selected',
                      dragOverRowId === row.id && (dragOverAfter ? 'row-drop-target-after' : 'row-drop-target-before'),
                      dragRowIds?.includes(row.id) && 'row-dragging',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onDragOver={(e) => handleRowDragOver(e, row.id, index)}
                    onDrop={(e) => handleRowDrop(e, row.id, index)}
                  >
                    <td
                      className="row-gutter"
                      title={rowDragEnabled ? undefined : 'Išjunkite paiešką, kad galėtumėte vilkti eilutes'}
                      onContextMenu={(e) => handleRowContextMenu(e, row, index)}
                    >
                      <div className="row-gutter-inner">
                        <span
                          className="row-grip"
                          draggable={rowDragEnabled}
                          onDragStart={(e) => handleRowGripDragStart(e, row.id, index)}
                          onDragEnd={handleRowDragEnd}
                          // draggable={false} means the browser never even
                          // fires dragstart when this is disabled — trying
                          // to drag just silently does nothing, which reads
                          // as "the drag feature doesn't work" rather than
                          // "it's off right now because of the active
                          // search." The row-gutter <td>'s own title
                          // already explains this, but only as a native
                          // hover tooltip — easy to miss when you're
                          // actively trying to drag, not hovering and
                          // waiting. This fires the same explanation as an
                          // immediate toast on the actual attempt.
                          onMouseDown={() => {
                            if (!rowDragEnabled) showToast('Išjunkite paiešką, kad galėtumėte vilkti eilutes');
                          }}
                          title="Vilkite, kad pakeistumėte eilučių tvarką"
                        >
                          ⠿
                        </span>
                        <span
                          className="row-number"
                          onMouseDown={(e) => {
                            if (e.button !== 0) return;
                            e.stopPropagation();
                            handleRowNumberMouseDown(index, e.shiftKey);
                          }}
                          onMouseEnter={() => handleRowNumberMouseEnter(index)}
                          onClick={(e) => e.stopPropagation()}
                          title="Spustelėkite arba shift+spustelėkite / vilkite, kad pasirinktumėte kelias eilutes"
                        >
                          {index + 1}
                        </span>
                      </div>
                      <div className="row-resize-handle" onMouseDown={(e) => startRowResize(e, row)} />
                    </td>
                    {columns.map((col, colIndex) => (
                      <DataCell
                        key={col.id}
                        row={row}
                        column={col}
                        selected={activeCell?.r === index && activeCell?.c === colIndex}
                        editable={
                          activeCell?.r === index &&
                          activeCell?.c === colIndex &&
                          !isRangeDragging &&
                          isSingleCellSelection &&
                          !searchFocused
                        }
                        inRange={
                          !!rangeBounds &&
                          index >= rangeBounds.minR &&
                          index <= rangeBounds.maxR &&
                          colIndex >= rangeBounds.minC &&
                          colIndex <= rangeBounds.maxC
                        }
                        onSelect={(e) => handleCellMouseDown(index, colIndex, false, e)}
                        onExtend={(e) => handleCellMouseEnter(index, colIndex, e)}
                        onOpenEditor={(anchor) => openCellEditor(row.id, col.id, anchor)}
                        highlightQuery={search.trim() || undefined}
                        contactsRaw={contactColumn ? row.cells[contactColumn.id] : undefined}
                        activeDatePopover={
                          dateCellPopover && dateCellPopover.rowId === row.id && dateCellPopover.columnId === col.id
                            ? dateCellPopover.kind
                            : null
                        }
                        onToggleDatePopover={(kind, anchor) => toggleDatePopover(row.id, col.id, kind, anchor)}
                      />
                    ))}
                  </tr>
                );
              })}
              {virtualRows.length > 0 && rowVirtualizer.getTotalSize() > virtualRows[virtualRows.length - 1].end && (
                <tr aria-hidden style={{ height: rowVirtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end }}>
                  <td colSpan={columns.length + 1} style={{ padding: 0, border: 'none' }} />
                </tr>
              )}
              {dragRowIds ? (
                <tr className="row-drop-end" onDragOver={(e) => e.preventDefault()} onDrop={handleRowDropAtEnd}>
                  <td colSpan={columns.length + 1}>Vilkite čia, kad perkeltumėte į pabaigą</td>
                </tr>
              ) : (
                <tr className="row-add-tr" onClick={handleAddRow}>
                  <td colSpan={columns.length + 1}>+ Pridėti eilutę</td>
                </tr>
              )}
            </tbody>
          </table>
          {fillHandlePos && (
            <div
              className="fill-handle"
              title="Vilkite, kad šią reikšmę užpildytumėte į gretimus langelius"
              style={{ top: fillHandlePos.top, left: fillHandlePos.left }}
              onMouseDown={handleFillHandleMouseDown}
            />
          )}
          {fillPreviewRect && (
            <div
              className="fill-preview-rect"
              style={{
                top: fillPreviewRect.top,
                left: fillPreviewRect.left,
                width: fillPreviewRect.width,
                height: fillPreviewRect.height,
              }}
            />
          )}
          {filteredSortedRows.length === 0 && (
            <div className="empty-state">
              {rows.length === 0 ? 'Kol kas nėra įmonių — importuokite CSV arba pridėkite eilutę.' : 'Pagal dabartinę paiešką rezultatų nerasta.'}
            </div>
          )}
        </div>
      )}

      <div className="table-footer">
        Eilučių: {filteredSortedRows.length}
        {filteredSortedRows.length !== rows.length ? ` iš ${rows.length}` : ''}
      </div>

      {expandedCell &&
        (() => {
          const row = rows.find((r) => r.id === expandedCell.rowId);
          const column = columns.find((c) => c.id === expandedCell.columnId);
          if (!row || !column || (column.type !== 'note' && column.type !== 'contact')) return null;
          const rawValue = row.cells[column.id] ?? '';
          const rowCompanyColumn = getColumnByType(columns, 'company');
          const rowCompanyName = rowCompanyColumn ? row.cells[rowCompanyColumn.id] : undefined;
          const rowContactColumn = getColumnByType(columns, 'contact');
          const rowContactsRaw = rowContactColumn ? row.cells[rowContactColumn.id] : undefined;
          return (
            <CellHoverEditor
              anchor={expandedCell.anchor}
              mode={column.type}
              value={rawValue}
              companyName={rowCompanyName}
              contactsRaw={rowContactsRaw}
              highlightEntryId={highlightContactId}
              onAddNoteEntry={(text) => updateCell(row.id, column.id, addNoteEntry(rawValue, text))}
              onUpdateNoteEntry={(id, text) => updateCell(row.id, column.id, updateNoteEntry(rawValue, id, text))}
              onRemoveNoteEntry={(id) => updateCell(row.id, column.id, removeNoteEntry(rawValue, id))}
              onAddContact={(text, id) => updateCell(row.id, column.id, addContact(rawValue, text, id))}
              onUpdateContact={(id, text) => updateCell(row.id, column.id, updateContact(rawValue, id, text))}
              onRemoveContact={(id) => updateCell(row.id, column.id, removeContact(rawValue, id))}
              onSetContactSocialNotFound={(id, platform) =>
                updateCell(row.id, column.id, markSocialLookupNotFound(rawValue, id, platform))
              }
              onClose={() => {
                setExpandedCell(null);
                setHighlightContactId(null);
              }}
            />
          );
        })()}
    </div>
  );
}
