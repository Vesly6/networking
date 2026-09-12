// Copied verbatim from app/src/utils/spreadsheet.ts — pure functions, no
// dependencies on anything project-specific.

/** 0-based column index → spreadsheet-style letters (0 → A, 25 → Z, 26 → AA…). */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Spreadsheet-style letters → 0-based column index (the inverse of columnLetter). */
export function columnIndexFromLetters(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

export interface CellPos {
  r: number;
  c: number;
}

/** Parses a single Excel-style cell reference like "C13" into 0-based {r, c}. */
export function parseCellRef(ref: string): CellPos | null {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!m) return null;
  const c = columnIndexFromLetters(m[1]);
  const r = parseInt(m[2], 10) - 1;
  if (r < 0 || c < 0) return null;
  return { r, c };
}

/** Formats 0-based {r, c} as an Excel-style reference, e.g. {r:12,c:2} → "C13". */
export function formatCellRef(pos: CellPos): string {
  return `${columnLetter(pos.c)}${pos.r + 1}`;
}
