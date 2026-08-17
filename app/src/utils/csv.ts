import Papa from 'papaparse';
import type { Column, ColumnType, Row } from '../types';

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

/** Best-effort guess at a newly-discovered CSV column's real type, based on
 * sampling its actual cell values rather than just the header name — exists
 * so re-importing a Note/Contact column this app itself exported "just
 * works" by default. A note/contact cell's raw stored value is a JSON array
 * (see utils/noteHistory.ts / utils/contacts.ts); defaulting every
 * unmatched header to plain 'text' would store/display that JSON literally,
 * which is exactly the "странные коды" (garbled codes) symptom this
 * sniffing exists to prevent. Checks up to 8 non-empty sample values (a
 * mismatched first row shouldn't doom the whole guess) and looks for the
 * `{ id, text, createdAt? }` shape those two modules serialize — a numeric
 * createdAt on every entry means note, its absence means contact. Only ever
 * a suggested default: the import-mapping modal always lets the user
 * override it. */
export function sniffColumnType(sampleValues: string[]): ColumnType {
  let checked = 0;
  for (const raw of sampleValues) {
    if (!raw || !raw.trim()) continue;
    if (checked >= 8) break;
    checked++;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((e) => e && typeof e.text === 'string')) {
        return parsed.every((e) => typeof e.createdAt === 'number') ? 'note' : 'contact';
      }
    } catch {
      // Not JSON — keep checking other samples rather than giving up on the first oddity.
    }
  }
  return 'text';
}

export function parseCsvFile(file: File): Promise<ParsedCsv> {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      skipEmptyLines: true,
      complete: (result) => {
        const data = result.data as string[][];
        if (data.length === 0) {
          resolve({ headers: [], rows: [] });
          return;
        }
        const [headers, ...rows] = data;
        resolve({ headers, rows });
      },
      error: (err: Error) => reject(err),
    });
  });
}

export function exportRowsToCsv(columns: Column[], rows: Row[]): string {
  const fields = columns.map((c) => c.name);
  const data = rows.map((row) => columns.map((c) => row.cells[c.id] ?? ''));
  return Papa.unparse({ fields, data });
}

export function downloadCsv(filename: string, csvContent: string): void {
  // BOM so Excel opens UTF-8 (Cyrillic) content without mangling it.
  const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
