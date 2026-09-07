export type ColumnType = 'text' | 'phone' | 'company' | 'note' | 'contact' | 'dropdown' | 'date' | 'link';

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  /** Only used when type === 'dropdown' */
  options?: string[];
  /** Per-option background color for dropdown badges, keyed by option value. */
  optionColors?: Record<string, string>;
  /** Only one date column at a time drives the calendar/task list */
  isNextActionDate?: boolean;
  /** Only used when type === 'dropdown'. Only one dropdown column at a
   * time is "the" status column (same one-at-a-time rule as
   * isNextActionDate) — every value change on it auto-logs a new entry
   * into the table's note column (see useTableStore.ts's updateCell/
   * updateCells), on explicit request, for a permanent, in-context record
   * of status transitions ("Rejected" → "Accepted") without a separate
   * audit UI. */
  isStatusColumn?: boolean;
  /** Only used when type === 'link'. A table can have several `link`
   * columns (Website, LinkedIn, Facebook…), all structurally identical —
   * this flag is the only way to say "this specific one is the company's
   * actual website," same one-at-a-time convention as isNextActionDate/
   * isStatusColumn above. It's what the "🔍 Paieška" decision-maker search
   * (ApolloContactSearchModal.tsx) reads to get a real domain instead of
   * guessing one from the company name — see utils/row.ts's
   * getWebsiteColumn(). Never auto-set when a column becomes type 'link'
   * (mirroring isStatusColumn's own reasoning: a link column is just as
   * often LinkedIn/Facebook as it is the real website, so guessing would
   * be wrong more often than right) — the user marks it explicitly via
   * ColumnMenu's "Naudoti kaip svetainę" checkbox. */
  isWebsiteColumn?: boolean;
  /** Column width in pixels; falls back to a default when unset. */
  width?: number;
  /** Hidden from the grid (header + data cells) but its data is untouched —
   * still included in CSV export and the CSV import mapping's "existing
   * column" list. Unhidden via the toolbar's hidden-columns indicator. */
  hidden?: boolean;
}

export interface TableMeta {
  id: string;
  name: string;
  columns: Column[];
  /** The Workspace screen's per-table daily-backup toggle (Package icon) — see
   * server/src/tableData/db.ts's own doc comment on why this is explicit
   * opt-in, not automatic for every table. Optional purely because older
   * cached/local shapes may not carry it; the server always sends a real
   * boolean. */
  dailyBackupEnabled?: boolean;
  /** Manual sort order among sibling tables — "siblings" being either "all
   * ungrouped tables" or "all tables in the same folder" (see folderId
   * below), NOT one shared order space across both groups. Sequential,
   * reassigned on every drag-reorder or folder move in SheetTabs, same
   * convention as Row.order. */
  order: number;
  /** Which TableFolder (if any) this table is grouped under in SheetTabs.
   * null/undefined = ungrouped. */
  folderId?: string | null;
  /** Which user (the company's super_admin, or a specific worker) this
   * table is exclusively visible to — see server/src/tableData/db.ts's
   * own migration doc comment for the ownership model, and
   * WorkspaceView.tsx's owner picker for how it's reassigned. The server
   * always derives/overwrites this on create; the client never sets it
   * explicitly. */
  ownerUserId?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A SheetTabs grouping bucket ("PL", "SE energy", ...) — purely an
 * organizational label for a client with many tables (country/sector
 * combinations); has no effect on table data itself. See TableMeta.order's
 * own comment for why folders get their own separate order space rather
 * than sharing one with tables. */
export interface TableFolder {
  id: string;
  name: string;
  order: number;
  createdAt: number;
  updatedAt: number;
}

export interface Row {
  id: string;
  tableId: string;
  cells: Record<string, string>;
  /** Per-cell background color, keyed by column id. */
  colors?: Record<string, string>;
  /** Manual sort order — sequential, reassigned on every drag-reorder. */
  order: number;
  /** Optional — the id of a ContactEntry (utils/contacts.ts) within this
   * row's own `contact`-type column, picked from the next-action-date
   * cell as "who to call" for that date. Row-level, not column-keyed:
   * there's only ever one next-action-date column per table (see
   * isNextActionDate), so there's nothing to disambiguate. Dangling (the
   * contact was since deleted) is handled gracefully wherever this is
   * read — just resolves to no name, never an error. */
  linkedContactId?: string;
  /** Optional free-text note for this row's next-action date — "what to
   * say/do on this call" (e.g. "ask about the budget approval"). Row-level,
   * not column-keyed, same reasoning as linkedContactId above: there's only
   * ever one next-action-date column per table, so nothing to disambiguate.
   * Set via the date cell's 📝 button (DataCell.tsx); shown in the
   * calendar/task-list views, never in the table itself. */
  nextActionNote?: string;
  /** Row height in pixels; falls back to a default when unset. */
  height?: number;
  /** Hidden from the grid but its data is untouched — still included in
   * CSV export. Unhidden via the toolbar's hidden-rows indicator, same
   * pattern as Column.hidden above (RowHeaderMenu's "Hide row" sets this,
   * HiddenRowsPopover is the way back). Unlike a hidden column (which
   * still needs a <col> slot for cell/count alignment across every row —
   * see Column.hidden's own comment), a hidden row is simply excluded
   * from the rendered/virtualized row list entirely; there's no analogous
   * alignment concern for rows. */
  hidden?: boolean;
  createdAt: number;
  updatedAt: number;
}
