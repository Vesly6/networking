import Papa from 'papaparse';

/**
 * Parses clipboard text copied from Excel/Google Sheets (or our own copy
 * handler). This is NOT a naive `text.split('\n').map(l => l.split('\t'))`
 * on purpose: real spreadsheet apps quote a cell (RFC4180-style, `"..."`
 * with `""` for an embedded quote) whenever it contains a tab, newline, or
 * quote character — a naive split treats an embedded newline inside a
 * quoted multi-line cell as a row break, silently exploding one pasted row
 * into many. Papa.parse already implements this quoting correctly (it's
 * also what CSV import uses), so reuse it with a tab delimiter instead of
 * hand-rolling a second, buggier parser.
 */
export function parseTsv(text: string): string[][] {
  const result = Papa.parse<string[]>(text, { delimiter: '\t', skipEmptyLines: true });
  return result.data;
}

/** The inverse of parseTsv — quotes any cell that needs it so the output
 * pastes correctly both back into this app and into a real spreadsheet. */
export function buildTsv(grid: string[][]): string {
  return Papa.unparse(grid, { delimiter: '\t' });
}
