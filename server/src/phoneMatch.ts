/** Server-side copy of app/src/utils/phoneMatch.ts's own last-7-digit
 * suffix match — a fresh, undependent duplicate rather than a shared
 * import, matching this codebase's established convention across the
 * client/server boundary (see linkedinPlanner/contactParsing.ts's own
 * LINKEDIN_PATTERN duplicate). Used by the Team Activity Dashboard's
 * "Atverti" drill-down for the calls metric, which needs to resolve a
 * Zadarma call's `otherParty` number to a CRM row — a cross-table lookup
 * the client-side original was never built for (it only ever indexes the
 * one table currently open; the dashboard lives on the Workspace screen,
 * before any table is open at all). */
export function normalizePhoneDigits(value: string | number): string {
  return String(value).replace(/\D/g, '');
}

const MATCH_SUFFIX_LENGTH = 7;

export function phoneMatchKey(value: string | number): string | null {
  const digits = normalizePhoneDigits(value);
  return digits.length >= MATCH_SUFFIX_LENGTH ? digits.slice(-MATCH_SUFFIX_LENGTH) : null;
}
