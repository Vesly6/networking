/** Apollo's fixed seniority levels for `person_seniorities` — `value` is
 * what's sent to the API (never translate), `label` is the Lithuanian
 * display text. Extracted out of PeopleFilterForm.tsx (previously an
 * inline string array whose display label was derived from the value via
 * `.replace('_', ' ')` — that derivation has no Lithuanian equivalent, so
 * this file replaces it, mirroring employeeRanges.ts's existing pattern. */
export const SENIORITIES: Array<{ label: string; value: string }> = [
  { label: 'Savininkas', value: 'owner' },
  { label: 'Įkūrėjas', value: 'founder' },
  { label: 'Aukščiausioji vadovybė', value: 'c_suite' },
  { label: 'Partneris', value: 'partner' },
  { label: 'Viceprezidentas', value: 'vp' },
  { label: 'Padalinio vadovas', value: 'head' },
  { label: 'Direktorius', value: 'director' },
  { label: 'Vadybininkas', value: 'manager' },
  { label: 'Vyresnysis specialistas', value: 'senior' },
  { label: 'Pradedantysis', value: 'entry' },
  { label: 'Stažuotojas', value: 'intern' },
];
