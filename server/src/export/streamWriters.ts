import type { Response } from 'express';
import Papa from 'papaparse';
import ExcelJS from 'exceljs';

/** Same Papa.unparse quoting/escaping as tableData/db.ts's backupToCsvText
 * (and app/src/utils/csv.ts's exportRowsToCsv) — a real RFC4180 quoter
 * rather than a hand-rolled join, for the identical reason CLAUDE.md
 * documents against manual CSV splitting (embedded tabs/newlines/quotes in
 * a cell). Built as one string, same as backupToCsvText — at this app's
 * real scale (tens of thousands of rows at most) that string is a few MB,
 * negligible next to the Row[] the server already holds in memory for any
 * table read; the write to `res` itself is a single chunk, so there's
 * nothing to backpressure-guard here the way the XLSX writer below needs. */
export function streamExportCsv(res: Response, filename: string, headerRow: string[], dataRows: string[][]): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  const csv = Papa.unparse({ fields: headerRow, data: dataRows });
  // Leading BOM so Excel opens UTF-8 (Lithuanian/Cyrillic) content without
  // mangling it — same convention as app/src/utils/csv.ts's downloadCsv.
  res.end('﻿' + csv);
}

function computeColumnWidth(header: string, dataRows: string[][], colIndex: number): number {
  let maxLen = header.length;
  const sampleSize = Math.min(dataRows.length, 200);
  for (let i = 0; i < sampleSize; i++) {
    const len = (dataRows[i][colIndex] ?? '').length;
    if (len > maxLen) maxLen = len;
  }
  return Math.min(40, Math.max(10, maxLen + 2));
}

/** Streams an XLSX workbook row-by-row directly to `res` via exceljs's
 * WorkbookWriter — unlike the CSV path above, this genuinely never holds
 * the encoded (zipped XML) file in server memory, only one row at a time,
 * which matters more here since XLSX's XML encoding is far more verbose
 * than CSV for the same data. */
export async function streamExportXlsx(res: Response, filename: string, headerRow: string[], dataRows: string[][]): Promise<void> {
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
  // `views` MUST be passed in addWorksheet()'s options, not assigned after
  // the fact — confirmed by reading exceljs's own streaming
  // WorksheetWriter source (lib/stream/xlsx/worksheet-writer.js): `views`
  // is exposed as a getter over a value only ever set from the
  // constructor's `options.views`, so a post-hoc `worksheet.views = [...]`
  // silently no-ops (verified directly: the frozen pane never made it into
  // the written XML until this was moved here).
  const worksheet = workbook.addWorksheet('Eksportas', { views: [{ state: 'frozen', ySplit: 1 }] });
  worksheet.columns = headerRow.map((header, i) => ({ header, key: String(i), width: computeColumnWidth(header, dataRows, i) }));

  const headerRowObj = worksheet.getRow(1);
  headerRowObj.font = { bold: true };
  headerRowObj.commit();

  for (const dataRow of dataRows) {
    const row = worksheet.addRow(dataRow);
    // Force every cell to text format so a long phone number/ID is never
    // numeric-auto-formatted (and potentially rounded/scientific-notated)
    // by Excel on open — every value this app exports is already a plain
    // string, so this is always safe, never a lossy conversion.
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.numFmt = '@';
    });
    row.commit();
  }

  worksheet.commit();
  await workbook.commit();
}
