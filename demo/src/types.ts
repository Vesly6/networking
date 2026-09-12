// A trimmed copy of app/src/types.ts's Column/Row shape — only the fields
// the demo's own feature set actually uses (dropdown/date/note/contact
// column behavior, cell colors, row order). Deliberately dropped:
// dailyBackupEnabled/folderId/ownerUserId/TableMeta's server-owned fields
// — none of that applies to a stateless, single-session, no-backend demo.
// Kept close enough to the real shape that the copied utils below
// (csv.ts/tsv.ts/row.ts/contacts.ts) work completely unmodified.
export type ColumnType = 'text' | 'phone' | 'company' | 'note' | 'contact' | 'dropdown' | 'date' | 'link';

export interface Column {
  id: string;
  name: string;
  type: ColumnType;
  options?: string[];
  optionColors?: Record<string, string>;
  isStatusColumn?: boolean;
  width?: number;
}

export interface Row {
  id: string;
  tableId: string;
  cells: Record<string, string>;
  colors?: Record<string, string>;
  order: number;
  height?: number;
}

export interface DemoTable {
  id: string;
  name: string;
  columns: Column[];
}
