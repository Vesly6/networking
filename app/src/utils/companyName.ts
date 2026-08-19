// Strips Lithuanian legal-entity boilerplate from a company name before it's
// used as an Apollo organization-name search query. Confirmed against the
// live Apollo API (not guessed): a bare abbreviation prefix on its own
// ("UAB "SANITEX"") still resolved fine, but a trailing comma-separated
// abbreviation ("MAXIMA LT, UAB") and a full legal-form phrase combined with
// a quoted brand ("Uždaroji akcinė bendrovė "Vilniaus prekyba"") both
// returned zero results — while the same names with the legal-form noise
// stripped out ("MAXIMA LT", "Vilniaus prekyba") resolved correctly. This is
// what the "🔍 Paieška" button in CellHoverEditor.tsx runs the row's Company
// value through before calling searchCompanies().
const LEGAL_FORM_PHRASES = [
  'uždaroji akcinė bendrovė',
  'akcinė bendrovė',
  'mažoji bendrija',
  'individuali įmonė',
  'viešoji įstaiga',
  'žemės ūkio bendrovė',
  'tikroji ūkinė bendrija',
  'komanditinė ūkinė bendrija',
];

const LEGAL_FORM_TOKENS = new Set([
  'uab', 'ab', 'mb', 'všį', 'vį', 'įį', 'žūb', 'tūb', 'kūb', 'iį',
]);

export function cleanCompanyNameForSearch(raw: string): string {
  // Straight and curly/guillemet quotes — evidence showed these alone don't
  // break a match, but they're noise for a "clean keyword" query either way.
  let s = raw.replace(/["“”„»«]/g, ' ');
  for (const phrase of LEGAL_FORM_PHRASES) {
    const idx = s.toLowerCase().indexOf(phrase);
    if (idx !== -1) s = s.slice(0, idx) + ' ' + s.slice(idx + phrase.length);
  }
  const tokens = s
    .split(/[\s,]+/)
    .filter((t) => t && !LEGAL_FORM_TOKENS.has(t.toLowerCase()));
  const cleaned = tokens.join(' ').trim();
  return cleaned || raw.trim();
}
