/** Apollo's fixed email-verification statuses for `contact_email_status` —
 * `value` is what's sent to the API (never translate), `label` is the
 * Lithuanian display text. Extracted out of PeopleFilterForm.tsx, same
 * reasoning as seniorities.ts. */
export const EMAIL_STATUSES: Array<{ label: string; value: string }> = [
  { label: 'Patvirtintas', value: 'verified' },
  { label: 'Nepatvirtintas', value: 'unverified' },
  { label: 'Tikėtina, kad atsilieps', value: 'likely_to_engage' },
  { label: 'Nepasiekiamas', value: 'unavailable' },
];
