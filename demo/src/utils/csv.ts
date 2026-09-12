// Copied from app/src/utils/csv.ts — same sniffColumnType/parseCsvFile/
// exportRowsToCsv/downloadCsv/sanitizeFilename shape, importing from this
// project's own (trimmed) ../types.ts instead of the production one.
import Papa from 'papaparse';
import type { Column, ColumnType, Row } from '../types';

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

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
      // Not JSON — keep checking other samples.
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

export function sanitizeFilename(name: string): string {
  return name.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'unnamed';
}
