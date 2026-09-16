import { localApiRequest } from './localApi';

/** Thin wrappers around /api/linkedin-planner/* — see server/src/
 * linkedinPlanner/db.ts's own top-of-file doc comment for the feature's
 * one non-negotiable rule: nothing here ever reaches linkedin.com. Every
 * one of these calls just reads/writes a plain task row; "Atidaryti"
 * (open profile) is a plain `<a target="_blank">` in the UI, not an API
 * call at all. */

export type PlannerTaskStatus =
  | 'planned'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'no_response'
  | 'replied'
  | 'skipped'
  | 'withdrawn'
  | 'needs_review'
  | 'removed';

export interface PlannerTaskDisplay {
  name: string | null;
  jobTitle: string | null;
  companyName: string | null;
  linkedinUrl: string;
  /** The table this task's primary occurrence currently lives in — null
   * only if that table itself no longer exists. Shown as a small label on
   * each task row (LinkedInPlannerView.tsx) so a worker with access to
   * several tables can tell which one a given lead came from, since one
   * shared planner list otherwise gives no hint of source. */
  sourceTableName: string | null;
}

// Shared between LinkedInPlannerView.tsx's dropdown/pill labels and
// CellHoverEditor.tsx's contact-badge tooltip, so a status reads the same
// wherever it's shown — 'sent' is deliberately included here even though
// it's not one of LinkedInPlannerView's manual STATUS_OPTIONS (that one
// has its own dedicated one-click button, see that file's doc comment).
export const PLANNER_STATUS_LABELS: Record<PlannerTaskStatus, string> = {
  planned: 'Suplanuota',
  sent: 'Išsiųsta',
  accepted: 'Priimta',
  declined: 'Atmesta',
  no_response: 'Nėra atsakymo',
  replied: 'Atsakė',
  skipped: 'Praleista',
  withdrawn: 'Atšaukta',
  needs_review: 'Reikia patikrinti',
  removed: 'Pašalinta',
};

// A LinkedIn connect request is sent from each worker's OWN LinkedIn
// account, so "has this task been sent" is inherently per-worker, not a
// single global fact — see server/src/linkedinPlanner/db.ts's
// planner_task_sends table doc comment. One entry per worker who
// currently has an active (not-yet-reversed-via-Nepatvirtino) send.
export interface PlannerTaskSender {
  workerId: string;
  workerName: string;
  sentAt: number;
}

// One entry per "Nepatvirtino" click — who, and when. Same shape family
// as PlannerTaskSender, just a different timestamp field name (matching
// the server's own planner_task_history column), kept as a distinct type
// rather than reusing PlannerTaskSender so a stray sentAt/changedAt mixup
// is a type error, not a silently-undefined field at render time.
export interface PlannerTaskNotConfirmedEntry {
  workerId: string;
  workerName: string;
  changedAt: number;
}

export interface PlannerTask {
  id: string;
  companyId: string;
  normalizedLinkedinUrl: string;
  profileType: 'person' | 'company' | 'unrecognized';
  primaryTableId: string;
  primaryRowId: string;
  primaryContactId: string | null;
  status: PlannerTaskStatus;
  assignedWorkerId: string | null;
  scheduledDate: string | null;
  note: string | null;
  /** How many times ANY worker's send to this specific person has bounced
   * back via "Nepatvirtino" — a tally about the lead, not about one
   * worker (see server's removeTaskSend). Shown as a small badge once >0. */
  notConfirmedCount: number;
  /** Every worker who's currently sent this exact person a connect
   * request, in the order they sent it ("Išsiuntė: 1. X 2. Y"). */
  senders: PlannerTaskSender[];
  /** Every past "Nepatvirtino" click against this task, in order — who
   * clicked it and when ("Nepatvirtino: 1. X 2. Y"), on explicit request
   * so the notConfirmedCount badge's hover isn't just a bare number. */
  notConfirmedBy: PlannerTaskNotConfirmedEntry[];
  createdAt: number;
  updatedAt: number;
  display: PlannerTaskDisplay;
}

export interface PlannerTaskHistoryEntry {
  id: string;
  taskId: string;
  fromStatus: PlannerTaskStatus | null;
  toStatus: PlannerTaskStatus;
  changedByUserId: string;
  changedAt: number;
  note: string | null;
}

export interface PlannerTemplate {
  id: string;
  companyId: string;
  name: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

export type PlannerListFilter = 'queue' | 'needs_review' | 'all' | PlannerTaskStatus;

// Must match server/src/index.ts's own PLANNER_PAGE_SIZE exactly — used
// client-side only to compute which page number "load more" asks for
// next (tasks.length / this), not to size anything itself.
export const PLANNER_PAGE_SIZE = 100;

// Must match server/src/index.ts's own PLANNER_VIEW_ALL_WORKERS_SENTINEL
// exactly — the "Žiūrėti kaip darbuotoją" filter's third option ("Visi"),
// alongside "my own" (null) and one specific worker's real id.
export const PLANNER_VIEW_ALL_WORKERS = '__all__';

export interface PlannerTaskPage {
  tasks: PlannerTask[];
  total: number;
  hasMore: boolean;
}

// Server-paginated, not a client-side "load everything then filter" list
// — real scale here is already in the thousands per company (see
// server/src/linkedinPlanner/db.ts's own doc comment), so the backend
// only ever resolves display data for one page's worth of tasks at a
// time, never the whole company.
// tableId narrows the list to one table (LinkedInPlannerView.tsx's
// table-filter dropdown) — omitted/undefined means "every accessible
// table," matching the server's own default. viewAsWorkerId ("Žiūrėti
// kaip darbuotoją") is the super_admin/view_all-only worker filter — the
// server 403s it for anyone else, so it's simply never sent by a plain
// worker's own UI.
export function fetchPlannerTasks(filter: PlannerListFilter, search: string, page: number, tableId?: string | null, viewAsWorkerId?: string | null) {
  const q = new URLSearchParams({ filter, page: String(page) });
  if (search.trim()) q.set('search', search.trim());
  if (tableId) q.set('tableId', tableId);
  if (viewAsWorkerId) q.set('viewAsWorkerId', viewAsWorkerId);
  return localApiRequest<PlannerTaskPage>(`/api/linkedin-planner/tasks?${q.toString()}`);
}

// The contact-card badge (CellHoverEditor.tsx) — one call per row, only
// when that row's contact editor actually opens. taskId lets the card's
// own "confirm sent" action (see CellHoverEditor's LinkedIn social-icon
// row) call sendPlannerTask directly, without a second round trip.
export function fetchPlannerTaskStatusesForRow(tableId: string, rowId: string) {
  const q = new URLSearchParams({ tableId, rowId });
  return localApiRequest<{ statuses: { contactId: string; taskId: string; notConfirmedCount: number; senders: PlannerTaskSender[] }[] }>(
    `/api/linkedin-planner/tasks/by-row?${q.toString()}`,
  );
}

export function fetchPlannerTaskHistory(taskId: string) {
  return localApiRequest<{ history: PlannerTaskHistoryEntry[] }>(`/api/linkedin-planner/tasks/${encodeURIComponent(taskId)}/history`);
}

export function claimPlannerTask(taskId: string) {
  return localApiRequest<{ ok: true }>(`/api/linkedin-planner/tasks/${encodeURIComponent(taskId)}/claim`, { method: 'POST' });
}

export function reassignPlannerTask(taskId: string, workerId: string | null) {
  return localApiRequest<{ ok: true }>(`/api/linkedin-planner/tasks/${encodeURIComponent(taskId)}/reassign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workerId }),
  });
}

// "Kvietimas išsiųstas" — records THAT THIS WORKER personally sent a
// connect request. Idempotent and per-worker (see PlannerTaskSender's own
// doc comment): calling it again, or a different worker calling it on
// the same task, never overwrites anyone else's send.
export function sendPlannerTask(taskId: string) {
  return localApiRequest<{ task: PlannerTask }>(`/api/linkedin-planner/tasks/${encodeURIComponent(taskId)}/send`, { method: 'POST' });
}

// "Nepatvirtino" — reverses only THIS worker's own send, back into their
// own Siuntimui queue; every other worker's send on the same task is
// untouched. Also bumps the task's shared not_confirmed_count.
export function markPlannerTaskNotConfirmed(taskId: string) {
  return localApiRequest<{ task: PlannerTask }>(`/api/linkedin-planner/tasks/${encodeURIComponent(taskId)}/not-confirmed`, { method: 'POST' });
}

export function schedulePlannerTask(taskId: string, scheduledDate: string | null) {
  return localApiRequest<{ ok: true }>(`/api/linkedin-planner/tasks/${encodeURIComponent(taskId)}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scheduledDate }),
  });
}

export function setPlannerTaskNote(taskId: string, note: string | null) {
  return localApiRequest<{ ok: true }>(`/api/linkedin-planner/tasks/${encodeURIComponent(taskId)}/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
}

// tzOffsetMinutes is the browser's own new Date().getTimezoneOffset() —
// see server/src/index.ts's route for why this is what makes the
// midnight reset happen in the viewer's own timezone, not the server's.
export function fetchPlannerTodayCount() {
  const q = new URLSearchParams({ tzOffsetMinutes: String(new Date().getTimezoneOffset()) });
  return localApiRequest<{ sentToday: number; dailyLimit: number }>(`/api/linkedin-planner/today-count?${q.toString()}`);
}

export function fetchPlannerTemplates() {
  return localApiRequest<{ templates: PlannerTemplate[] }>('/api/linkedin-planner/templates');
}

export function createPlannerTemplate(name: string, body: string) {
  return localApiRequest<PlannerTemplate>('/api/linkedin-planner/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, body }),
  });
}

export function updatePlannerTemplate(id: string, name: string, body: string) {
  return localApiRequest<{ ok: true }>(`/api/linkedin-planner/templates/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, body }),
  });
}

export function deletePlannerTemplate(id: string) {
  return localApiRequest<{ ok: true }>(`/api/linkedin-planner/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
