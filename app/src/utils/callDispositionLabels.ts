/** Display-only labels for Zadarma's `disposition` field — never translate
 * the raw value itself, it's compared with `=== 'answered'` elsewhere
 * (CallsView.tsx, callStats.ts). Confirmed against a real account (30-day
 * pull, 313 calls): 'answered', 'no answer', 'busy', 'call failed' are the
 * only values actually observed. Anything not in this map falls back to
 * the raw value rather than guessing a translation for an unconfirmed
 * status. */
const CALL_DISPOSITION_LABELS: Record<string, string> = {
  answered: 'Atsakyta',
  'no answer': 'Neatsakyta',
  busy: 'Užimta',
  'call failed': 'Skambutis nepavyko',
};

export function getCallDispositionLabel(disposition: string): string {
  return CALL_DISPOSITION_LABELS[disposition] ?? disposition;
}
