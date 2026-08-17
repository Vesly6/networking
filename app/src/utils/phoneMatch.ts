/** Strips everything but digits, so "+370 61 818301", "861818301", and
 * "37061818301" can all be compared on equal footing regardless of
 * formatting or a present/absent country code. Takes `string | number`
 * because Zadarma's `destination` field comes back as a bare JSON number
 * (unquoted in the response), not a string, despite CallRecord typing it
 * as `string` — coercing here means every caller doesn't have to remember
 * to do it themselves. */
export function normalizePhoneDigits(value: string | number): string {
  return String(value).replace(/\D/g, '');
}

// A 7-digit trailing match is specific enough to avoid false positives
// (extensions, short internal codes) while being tolerant of whichever
// country-code/leading-zero convention either side happens to use.
const MATCH_SUFFIX_LENGTH = 7;

export function phoneMatchKey(value: string | number): string | null {
  const digits = normalizePhoneDigits(value);
  return digits.length >= MATCH_SUFFIX_LENGTH ? digits.slice(-MATCH_SUFFIX_LENGTH) : null;
}
