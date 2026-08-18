/** Excel's real per-cell character limit (not 32,000 or 33,000). */
export const EXCEL_CELL_LIMIT = 32767;

export const DEFAULT_COLUMN_WIDTH = 160;
export const MIN_COLUMN_WIDTH = 70;
export const MAX_COLUMN_WIDTH = 640;

export const DEFAULT_ROW_HEIGHT = 34;
export const MIN_ROW_HEIGHT = 24;
export const MAX_ROW_HEIGHT = 160;

export const GUTTER_WIDTH = 64;
export const ADD_COLUMN_WIDTH = 40;

export const RECENT_COLORS_KEY = 'cold-crm:recent-colors';

/** Prefix for the per-table view-state key (search text, sort column) —
 * see TableView.tsx's loadPersistedViewState/persist effect. Keyed by
 * table id, appended at the call site, so a search left over in one
 * table can never silently filter a different one after a reload. */
export const TABLE_VIEW_STATE_KEY_PREFIX = 'cold-crm:table-view-state:';

export const PRESET_COLORS = [
  '#fecaca',
  '#fed7aa',
  '#fef08a',
  '#bbf7d0',
  '#bfdbfe',
  '#ddd6fe',
  '#fbcfe8',
  '#e5e7eb',
];
