export interface NumericRangeFilter {
  min?: number;
  max?: number;
}

/** Cell values are always plain strings regardless of column type (see
 * types.ts) — there's no dedicated "number" column type, so a column like
 * "Darbuotojai"/"Apyvarta" is really just a text column whose values
 * happen to look numeric. This parses a best-effort number out of common
 * real-world formats: a plain integer, a space-thousands-separated one
 * ("1 500 000"), a comma-thousands one ("1,500,000"), or a European
 * decimal comma ("150,5") — distinguished by shape, since a bare comma is
 * genuinely ambiguous between "thousands separator" and "decimal point"
 * without knowing which convention the data uses. Returns null for
 * anything that doesn't parse as a real number (empty cell, actual text) —
 * the range filter below treats null as "doesn't match" rather than
 * "equal to zero", so a blank/non-numeric cell never accidentally
 * satisfies a range that happens to include 0. */
export function parseNumericCellValue(raw: string): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let normalized = trimmed.replace(/\s/g, '');
  if (/^-?\d{1,3}(,\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/,/g, '');
  } else if (/^-?\d+,\d{1,2}$/.test(normalized)) {
    normalized = normalized.replace(',', '.');
  } else {
    normalized = normalized.replace(/,/g, '');
  }
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

/** True when a cell's parsed value falls within [min, max] — either bound
 * left unset means "no lower/upper limit", matching a plain spreadsheet
 * "from–to" filter (only one side needs to be filled in). A cell that
 * doesn't parse as a number never matches an active filter. */
export function matchesNumericRange(raw: string, filter: NumericRangeFilter): boolean {
  const value = parseNumericCellValue(raw);
  if (value === null) return false;
  if (filter.min !== undefined && value < filter.min) return false;
  if (filter.max !== undefined && value > filter.max) return false;
  return true;
}
