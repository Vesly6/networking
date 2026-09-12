// Trimmed copy of app/src/utils/row.ts — getPrimaryLabel/getColumnByType/
// getNextActionColumn, which is what the demo's grid/toolbar/Calendar tab
// need (no website-column/linked-contact concepts here).
import type { Column, Row } from '../types';

export function getPrimaryLabel(row: Row, columns: Column[]): string {
  const company = getColumnByType(columns, 'company') ?? columns[0];
  const value = company ? row.cells[company.id] : '';
  return value?.trim() || 'Unnamed';
}

export function getColumnByType(columns: Column[], type: Column['type']): Column | undefined {
  return columns.find((c) => c.type === type);
}

export function getNextActionColumn(columns: Column[]): Column | undefined {
  return columns.find((c) => c.type === 'date' && c.isNextActionDate);
}
