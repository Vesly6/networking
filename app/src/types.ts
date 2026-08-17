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
  /** Row height in pixels; falls back to a default when unset. */
  height?: number;
  createdAt: number;
  updatedAt: number;
}
