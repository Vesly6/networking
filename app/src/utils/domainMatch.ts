/** Strips protocol, "www.", path/query, and casing so "https://www.august.lt/",
 * "august.lt", and "AUGUST.LT" all compare equal — same "normalize then match"
 * shape as phoneMatch.ts's normalizePhoneDigits(), just for a website/domain
 * value instead of a phone number. Used by MergeContactsModal.tsx to match an
 * incoming decision-makers CSV's Website column against a table's own
 * `link`-type Website column when company names between the two sources don't
 * match as strings (see rowDomainIndex.ts's own doc comment for the real,
 * reported example this was built to solve). Returns null for an empty value
 * or one that doesn't parse as a URL at all. */
export function normalizeDomain(value: string): string | null {
  if (!value || !value.trim()) return null;
  let v = value.trim().toLowerCase();
  if (!/^https?:\/\//.test(v)) v = 'https://' + v;
  try {
    const host = new URL(v).hostname.replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}
