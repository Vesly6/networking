// Demo-build export execution — the demo has no backend server at all
// (see app/src/db/demoData.ts's own doc comments), so everything happens
// client-side against the already in-memory demo rows. CSV reuses
// Papa.unparse + downloadCsv directly (already available, no new
// dependency). XLSX dynamically imports `xlsx` (SheetJS) — never bundled
// into a real production build, since this whole module is only ever
// reached behind the compile-time DEMO_MODE flag (see exportFlatten.ts's
// callers) and Vite code-splits a dynamic import into its own chunk.
//
// The npm-registry `xlsx` package is pinned old (0.18.5) with two known
// high-severity advisories (prototype pollution / ReDoS) — both are in the
// *parsing* path (XLSX.read/parse of an untrusted file). This module only
// ever *writes* a workbook built from this app's own locally-seeded demo
// data, never parses anything, so that surface is never reached here.
import Papa from 'papaparse';
import type { Column, Row } from '../types';
import { downloadCsv } from './csv';
import { buildExportRows, type ExportMode } from './exportFlatten';

export interface RunDemoExportParams {
  mode: ExportMode;
  format: 'csv' | 'xlsx';
  columns: Column[]; // full, incl. hidden — caller passes the already-visible-only list
  rows: Row[]; // already scope-resolved by ExportDialog
  contactColumnId: string | null;
  includeCompaniesWithoutContacts: boolean;
  onlyContactsWithEmail: boolean;
  prettyNotes: boolean;
  filename: string;
}

export async function runDemoExport(params: RunDemoExportParams): Promise<void> {
  const { headerRow, dataRows } = buildExportRows({
    columns: params.columns,
    rows: params.rows,
    mode: params.mode,
    contactColumnId: params.contactColumnId,
    includeCompaniesWithoutContacts: params.includeCompaniesWithoutContacts,
    onlyContactsWithEmail: params.onlyContactsWithEmail,
    prettyNotes: params.prettyNotes,
  });

  if (params.format === 'csv') {
    downloadCsv(params.filename, Papa.unparse({ fields: headerRow, data: dataRows }));
    return;
  }

  const XLSX = await import('xlsx');
  const worksheet = XLSX.utils.aoa_to_sheet([headerRow, ...dataRows]);
  worksheet['!cols'] = headerRow.map((h, i) => ({
    wch: Math.min(40, Math.max(10, Math.max(h.length, ...dataRows.slice(0, 200).map((r) => (r[i] ?? '').length)) + 2)),
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Eksportas');
  XLSX.writeFile(workbook, params.filename);
}
