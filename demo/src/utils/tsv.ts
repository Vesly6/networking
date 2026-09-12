// Copied as-is from app/src/utils/tsv.ts — pure Papa.parse/unparse
// wrappers, no type or store dependency at all.
import Papa from 'papaparse';

export function parseTsv(text: string): string[][] {
  const result = Papa.parse<string[]>(text, { delimiter: '\t', skipEmptyLines: true });
  return result.data;
}

export function buildTsv(grid: string[][]): string {
  return Papa.unparse(grid, { delimiter: '\t' });
}
