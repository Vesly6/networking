import type { Column, Row } from '../types';

export function getPrimaryLabel(row: Row, columns: Column[]): string {
  // Prefer a dedicated Company column if one exists; older tables without
  // one fall back to whatever's in the first column, as before.
  const company = getColumnByType(columns, 'company') ?? columns[0];
  const value = company ? row.cells[company.id] : '';
  return value?.trim() || 'Untitled';
}

export function getNextActionColumn(columns: Column[]): Column | undefined {
  return columns.find((c) => c.type === 'date' && c.isNextActionDate);
}

export function getColumnByType(columns: Column[], type: Column['type']): Column | undefined {
  return columns.find((c) => c.type === type);
}
