// Trimmed copy of app/src/utils/row.ts — only getPrimaryLabel/
// getColumnByType, which is all the demo's grid/toolbar needs (no
// next-action-date/website-column/linked-contact concepts here).
import type { Column, Row } from '../types';

export function getPrimaryLabel(row: Row, columns: Column[]): string {
  const company = getColumnByType(columns, 'company') ?? columns[0];
  const value = company ? row.cells[company.id] : '';
  return value?.trim() || 'Unnamed';
}

export function getColumnByType(columns: Column[], type: Column['type']): Column | undefined {
  return columns.find((c) => c.type === type);
}
