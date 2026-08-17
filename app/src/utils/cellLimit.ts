import { EXCEL_CELL_LIMIT } from '../constants';

export function clampToLimit(value: string): { value: string; truncated: boolean } {
  if (value.length <= EXCEL_CELL_LIMIT) return { value, truncated: false };
  return { value: value.slice(0, EXCEL_CELL_LIMIT), truncated: true };
}
