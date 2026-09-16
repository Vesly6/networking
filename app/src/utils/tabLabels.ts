/** Mirrors App.tsx's own nav labels exactly — extracted here once a third
 * place (WorkersView.tsx, now also AdminView.tsx's Funkcijos panel)
 * needed the same mapping. `news` is included even though it isn't part
 * of App.tsx's own Tab union (it's gated directly off
 * enabledFeatures.includes('news'), bypassing the worker-restrictable
 * allowedTabs machinery — see App.tsx's own note on why) — it's still a
 * real, super-admin-toggleable per-company feature, just not a
 * worker-scopable one, so it belongs here for the Funkcijos checkbox list
 * even though a worker's own visibleTabs picker (WorkersView) never has a
 * reason to offer it. `workers`/`backups` are the same shape as `news` —
 * on explicit request, the super-admin can now hide "Darbuotojai"/
 * "Duomenys" per company too (previously purely role-gated, with no way
 * to turn them off for a specific company at all) — also never offered in
 * a worker's own visibleTabs picker, since a worker never manages other
 * workers or backups regardless. */
// 'linkedin' (the old, retired browser-automation feature — see
// server/src/index.ts's LINKEDIN_AUTOMATION_ENABLED doc comment)
// deliberately has NO entry here right now, on explicit request: while
// it's flag-disabled, it shouldn't appear as an option ANYWHERE an admin
// configures features — not just hidden from a worker's own nav (App.tsx's
// allowedTabs already force-excludes it there independently), but absent
// from AdminView's Funkcijos checkbox list (which iterates ALL_TABS below)
// and workerGrantableTabs' own chip list (see its exclusion there) too.
// Re-add the line (`linkedin: 'LinkedIn'`) if this feature ever comes back.
export const TAB_LABELS: Record<string, string> = {
  table: 'Lentelė',
  calendar: 'Kalendorius',
  calls: 'Skambučiai',
  search: 'Paieška',
  linkedin_planner: 'LinkedIn planuoklis',
  instantly: 'Paštas',
  email: 'DI',
  lessons: 'Pamokos',
  news: 'Naujienos',
  workers: 'Darbuotojai',
  backups: 'Duomenys',
  integrations: 'Integracijos',
};

/** Every value a company's enabledFeatures/a worker's visibleTabs can
 * ever hold — mirrors App.tsx's own Tab union (plus 'news'/'workers'/
 * 'backups', see above) and server/src/index.ts's VALID_FEATURES. */
export const ALL_TABS = Object.keys(TAB_LABELS);

/** `workers`/`backups` are real per-company features (a checkbox in the
 * super-admin's Funkcijos panel), but they are never a *tab a worker can
 * be granted visibility into* — a worker doesn't manage other workers or
 * backups regardless of what their own super_admin has enabled for
 * themselves. WorkersView.tsx's "Matomos skiltys" chip picker renders
 * every entry of whatever companyTabs list it's given with no further
 * filtering, so both call sites (App.tsx, AdminView.tsx) route their own
 * company's enabledFeatures through this before handing it to
 * <WorkersView>, rather than duplicating the exclusion at each site.
 * `linkedin` is excluded here too, temporarily — a real company's stored
 * enabledFeatures can still literally contain "linkedin" from before it
 * was retired (see TAB_LABELS' own doc comment on why it has no entry
 * anymore), and without this filter that raw string would still render as
 * a chip here, just with an ugly unlabeled fallback instead of a proper
 * name. Remove this exclusion in the same pass as re-adding the
 * TAB_LABELS entry, if this feature ever comes back. */
export function workerGrantableTabs(companyTabs: string[]): string[] {
  return companyTabs.filter((t) => t !== 'workers' && t !== 'backups' && t !== 'integrations' && t !== 'linkedin');
}

/** Mirrors server/src/accounts/db.ts's ALWAYS_ON_FEATURES exactly — Table,
 * Calendar, and (on explicit request) LinkedIn planuoklis are the
 * baseline every worker should start with, same as a company itself can
 * never have them disabled. Used to pre-check those chips on a brand-new
 * worker's "Matomos skiltys" picker (WorkersView.tsx) — a real, reported
 * bug had a freshly-created worker start with NO tabs at all (Calendar
 * included) because the create form began from an empty selection and the
 * server defaulted a missing array to `[]`, not this. Filtered against the
 * actual company tabs before use, same as any other chip, in case a table
 * somehow isn't in the list. This is the TAB-visibility half of "on by
 * default" for LinkedIn planuoklis — the other half, its actual data
 * access, is still separately gated by the linkedin_planner.view/.execute
 * PERMISSION keys (see utils/permissions.ts's own
 * DEFAULT_WORKER_PERMISSION_KEYS), which this list doesn't touch. */
export const DEFAULT_WORKER_TABS = ['table', 'calendar', 'linkedin_planner'];
