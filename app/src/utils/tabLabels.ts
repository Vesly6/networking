/** Mirrors App.tsx's own nav labels exactly — extracted here once a third
 * place (CompaniesView.tsx) needed the same mapping WorkersView.tsx
 * already had as a local constant; not worth threading through App.tsx
 * itself since neither of these components renders inside it. */
export const TAB_LABELS: Record<string, string> = {
  table: 'Lentelė',
  calendar: 'Kalendorius',
  calls: 'Skambučiai',
  search: 'Paieška',
  linkedin: 'LinkedIn',
  instantly: 'Paštas',
  email: 'DI',
  lessons: 'Pamokos',
};

/** Every value a company's enabledFeatures/a worker's visibleTabs can
 * ever hold — mirrors App.tsx's own Tab union and server/src/index.ts's
 * VALID_FEATURES. */
export const ALL_TABS = Object.keys(TAB_LABELS);
