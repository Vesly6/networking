import {
  listCampaigns,
  listLeadsForCampaign,
  listSequenceSteps,
  getLastCompletedStepOrder,
  getLastActionTime,
  getLastActionForLeadStep,
  logAction,
  updateLeadStatus,
  type SequenceStep,
} from './db.js';
import {
  getSafetySettings,
  canSendConnect,
  recordConnectSent,
  recordConnectAttempt,
  canSendMessage,
  recordMessageSent,
  setPaused,
} from './safety.js';
import { sendConnectionRequest, sendMessage, withdrawConnectionRequest } from './page.js';

const DAY_MS = 86_400_000;

/** Detects the handful of error conditions that mean "something is
 * actually wrong with the session, not just this one lead" — a checkpoint,
 * a logged-out session, or Chrome being unreachable at all (page.ts/
 * browser.ts's own error messages, matched by content rather than error
 * class, since not every LinkedInPageError deserves this — "no Connect
 * button on this profile" is normal per-lead variance, not a systemic
 * problem). Deliberately narrow: a false positive here (pausing when
 * nothing's actually wrong) just costs a manual un-pause; a false negative
 * (a real checkpoint that doesn't match) is the failure mode that matters,
 * so keep this list in sync with page.ts's/browser.ts's actual thrown
 * messages if either ever changes. */
function isCircuitBreakerCondition(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return /checkpoint|logged into LinkedIn|Could not connect to Chrome/i.test(message);
}

/** Matches page.ts's specific "no Connect button" error text — thrown when
 * sendConnectionRequest() reaches a profile but finds nothing to click,
 * which in practice almost always means the person is already a 1st-degree
 * connection or has a pending invite (LinkedIn shows "Message"/"Pending"
 * there instead). A real, live-reproduced case this session: an imported
 * list turned out to be mostly *existing* connections, not new prospects —
 * every one of them failed this exact way, every single time. Deliberately
 * an exact string match on page.ts's own wording, not a broad "any connect
 * error" — see findDueActions()'s use of this below for why a false
 * positive here (treating a different failure as terminal) is worse than a
 * false negative (retrying a genuinely-terminal one a few more times before
 * it's noticed). */
function isNoConnectButtonError(detail: string | null): boolean {
  return detail === 'No "Connect" button found on this profile — may already be connected/pending, or the page layout changed.';
}

export interface DueAction {
  leadId: string;
  leadUrl: string;
  leadName: string | null;
  leadTitle: string | null;
  leadCompany: string | null;
  campaignId: string;
  campaignName: string;
  stepId: string;
  stepType: SequenceStep['type'];
  messageTemplate: string | null;
}

/** `{{firstName}}`/`{{lastName}}`/`{{title}}`/`{{company}}` substitution —
 * a free, deterministic personalization baseline that runs on *every*
 * sequence-step send, on top of (not instead of) the optional AI
 * personalization below. Splitting `lead.name` on the first space is the
 * same best-effort heuristic this app already uses elsewhere for a single
 * "full name" field with no separate first/last columns (see
 * utils/contacts.ts's contactTextToFields on the frontend) — not exact for
 * every name format, but right often enough to be worth doing
 * unconditionally, and a missing/empty field just substitutes to "". */
export function applyLeadPlaceholders(
  template: string,
  lead: { name: string | null; title: string | null; company: string | null },
): string {
  const parts = (lead.name ?? '').trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] ?? '';
  const lastName = parts.slice(1).join(' ');
  return template
    .replaceAll('{{firstName}}', firstName)
    .replaceAll('{{lastName}}', lastName)
    .replaceAll('{{title}}', lead.title ?? '')
    .replaceAll('{{company}}', lead.company ?? '');
}

/** Walks every *active* campaign's leads and figures out which ones are
 * due for their next sequence step right now — "due" meaning: the
 * previous step (if any) succeeded, and this step's own delayDays has
 * elapsed since then (or this is the lead's first step, which is due
 * immediately once the campaign is active). Read-only — doesn't execute
 * or check the Safety Engine; see executeAction()/runSchedulerTick()
 * below for that. */
export function findDueActions(now = Date.now()): DueAction[] {
  const due: DueAction[] = [];
  const campaigns = listCampaigns().filter((c) => c.status === 'active');

  for (const campaign of campaigns) {
    const steps = listSequenceSteps(campaign.id);
    if (steps.length === 0) continue;

    // 'withdrawn' (Phase 3): a lead whose invite was pulled back should
    // never come up as due for anything else either — same reasoning as
    // excluding 'replied'/'skipped' here.
    const leads = listLeadsForCampaign(campaign.id).filter(
      (l) => l.status !== 'replied' && l.status !== 'skipped' && l.status !== 'withdrawn',
    );

    for (const lead of leads) {
      const lastStepOrder = getLastCompletedStepOrder(lead.id);
      const nextStep = steps.find((s) => s.stepOrder === lastStepOrder + 1);
      if (!nextStep) continue; // sequence finished (or never started with a step 0 that exists) for this lead

      // A message step only makes sense once the lead is actually
      // connected — nothing in this codebase yet detects an accepted
      // invite automatically (that needs the Inbox/reply-watcher piece,
      // not built yet), so a message step simply never becomes due until
      // a lead's status is set to 'connected' some other way (manually,
      // for now). Documented as a known gap rather than silently
      // attempting to message a non-connection.
      if (nextStep.type === 'message' && lead.status !== 'connected') continue;

      // A connect step whose most recent attempt for THIS lead already
      // confirmed "no Connect button" (see isNoConnectButtonError above) is
      // terminal — the person is already connected/pending, and retrying
      // won't change that. Without this, a lead in that state would come
      // back due on every single tick forever, burning through the daily
      // cap on doomed attempts instead of ever reaching the leads further
      // down the list who are genuinely new prospects. Deliberately checked
      // per-lead (getLastActionForLeadStep), not by mutating lead.status —
      // see this function's own doc comment for why overloading status with
      // this meaning was rejected as a real risk if this exact error string
      // ever starts firing for an unrelated reason (a future selector
      // break, which has already happened twice this session for other
      // selectors).
      if (nextStep.type === 'connect') {
        const lastAttempt = getLastActionForLeadStep(lead.id, nextStep.id);
        if (lastAttempt?.status === 'error' && isNoConnectButtonError(lastAttempt.detail)) continue;
      }

      const lastActionTime = getLastActionTime(lead.id);
      const dueAt = lastActionTime === null ? now : lastActionTime + nextStep.delayDays * DAY_MS;
      if (now < dueAt) continue;

      due.push({
        leadId: lead.id,
        leadUrl: lead.linkedinUrl,
        leadName: lead.name,
        leadTitle: lead.title,
        leadCompany: lead.company,
        campaignId: campaign.id,
        campaignName: campaign.name,
        stepId: nextStep.id,
        stepType: nextStep.type,
        messageTemplate: nextStep.messageTemplate,
      });
    }
  }
  return due;
}

export interface ExecuteResult {
  ok: boolean;
  error?: string;
  /** True when this failure tripped the circuit breaker (checkpoint/
   * logged-out/Chrome unreachable) — see isCircuitBreakerCondition() above.
   * The caller (runSchedulerTick) uses this to stop attempting further
   * actions in the same tick rather than burning through the rest of the
   * due list against a session that can't succeed anyway. */
  circuitBreakerTripped?: boolean;
}

/** Actually performs one due action — the Safety Engine check happens
 * here, immediately before the real Playwright call, not earlier in
 * findDueActions() (state can change between "found due" and "about to
 * execute," e.g. another action in the same tick already used up the
 * daily cap). Logs the outcome either way.
 *
 * `overrideMessage`, when given, replaces the step's own (placeholder-
 * substituted) template entirely — this is what lets the Pending Approval
 * panel's "🤖 Personalizuoti" flow (a human reviews/edits an AI-suggested
 * rewrite before approving) actually change what gets sent, rather than
 * only ever being able to preview a suggestion that then gets silently
 * discarded at send time. Without an override, `{{firstName}}` etc. still
 * get substituted from the lead's own fields (applyLeadPlaceholders) even
 * with zero AI involvement — a free personalization floor every send
 * gets, not just the ones someone clicked "personalize" on. */
export async function executeAction(action: DueAction, overrideMessage?: string): Promise<ExecuteResult> {
  const startedAt = Date.now();
  const resolvedText = (
    overrideMessage?.trim() ||
    applyLeadPlaceholders(action.messageTemplate ?? '', { name: action.leadName, title: action.leadTitle, company: action.leadCompany })
  ).trim();

  if (action.stepType === 'connect') {
    const check = canSendConnect();
    if (!check.allowed) return { ok: false, error: check.reason };
    // Counted unconditionally, before the outcome is known — this is what
    // actually bounds total profile-page-view activity per day regardless
    // of how many attempts turn out to be duds (already-connected leads).
    // See canSendConnect()'s own doc comment on why the success-only caps
    // alone weren't enough.
    recordConnectAttempt();
    try {
      // The connect step's own messageTemplate doubles as the optional
      // "Add a note" text (LinkedIn's connect flow, not a separate DM) —
      // an earlier version of this call passed no note at all, so every
      // connection request went out blank regardless of what a connect
      // step's template field held.
      await sendConnectionRequest(action.leadUrl, resolvedText || undefined);
      recordConnectSent();
      logAction({
        leadId: action.leadId,
        stepId: action.stepId,
        actionType: 'connect',
        status: 'success',
        targetUrl: action.leadUrl,
        detail: null,
        executedAt: startedAt,
        responseTimeMs: Date.now() - startedAt,
      });
      updateLeadStatus(action.leadId, 'pending');
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to send connection request';
      logAction({
        leadId: action.leadId,
        stepId: action.stepId,
        actionType: 'connect',
        status: 'error',
        targetUrl: action.leadUrl,
        detail: message,
        executedAt: startedAt,
        responseTimeMs: Date.now() - startedAt,
      });
      // Auto-pause on a checkpoint/logged-out/unreachable-Chrome condition
      // — this is the durable, server-side circuit breaker: it doesn't
      // depend on anyone (human or AI) watching a dashboard or a chat
      // session staying alive. The next scheduler tick sees `paused` and
      // stops considering anything due at all (canSendConnect/
      // canSendMessage's own pause check) until a human explicitly resumes.
      if (isCircuitBreakerCondition(err)) {
        setPaused(true);
        return { ok: false, error: message, circuitBreakerTripped: true };
      }
      return { ok: false, error: message };
    }
  }

  // message
  const check = canSendMessage();
  if (!check.allowed) return { ok: false, error: check.reason };
  const text = resolvedText;
  if (!text) return { ok: false, error: 'This step has no message template set.' };
  try {
    await sendMessage(action.leadUrl, text);
    recordMessageSent();
    logAction({
      leadId: action.leadId,
      stepId: action.stepId,
      actionType: 'message',
      status: 'success',
      targetUrl: action.leadUrl,
      detail: null,
      executedAt: startedAt,
      responseTimeMs: Date.now() - startedAt,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to send message';
    logAction({
      leadId: action.leadId,
      stepId: action.stepId,
      actionType: 'message',
      status: 'error',
      targetUrl: action.leadUrl,
      detail: message,
      executedAt: startedAt,
      responseTimeMs: Date.now() - startedAt,
    });
    if (isCircuitBreakerCondition(err)) {
      setPaused(true);
      return { ok: false, error: message, circuitBreakerTripped: true };
    }
    return { ok: false, error: message };
  }
}

/** Re-verifies the action is *still* due right now before executing it —
 * the frontend's Pending Approval list was built from a possibly-stale
 * findDueActions() snapshot (another tab, a background tick, or another
 * approval in the same batch could have already changed things), so this
 * never trusts a client-supplied action payload directly. `overrideMessage`
 * (optional — the Pending Approval panel's edited/AI-personalized text, if
 * the user used it) passes straight through to executeAction(); omitted,
 * this sends the plain placeholder-substituted template exactly as before. */
export async function approveAction(leadId: string, stepId: string, overrideMessage?: string): Promise<ExecuteResult> {
  const match = findDueActions().find((a) => a.leadId === leadId && a.stepId === stepId);
  if (!match) return { ok: false, error: 'This action is no longer due (already handled, or conditions changed).' };
  return executeAction(match, overrideMessage);
}

/** Resolves one due action's lead/step details for the personalize route —
 * re-checks it's still due for the same stale-snapshot reason
 * approveAction() does, so a personalize request against a lead that just
 * got skipped (or whose sequence moved on) fails clearly instead of
 * quietly generating a suggestion for an action that will be rejected the
 * moment it's actually approved. */
export function findDueAction(leadId: string, stepId: string): DueAction | null {
  return findDueActions().find((a) => a.leadId === leadId && a.stepId === stepId) ?? null;
}

export interface SchedulerTickResult {
  due: number;
  autoExecuted: number;
  pendingApproval: number;
  errors: number;
  /** True when this tick stopped early because a checkpoint/logged-out/
   * unreachable-Chrome condition tripped the circuit breaker — the
   * remaining due actions in this tick were never attempted, and every
   * future tick will no-op until a human resumes (see canSendConnect/
   * canSendMessage's pause check). index.ts's background interval logs
   * this loudly so it's visible even with nobody watching the UI. */
  circuitBreakerTripped: boolean;
  /** True when this call was a no-op because another tick was already
   * running — see the module-level lock below. */
  skippedConcurrent?: boolean;
}

// Real, live-reproduced race found this session: the background interval
// (index.ts, every 5 minutes) and a manual POST /api/linkedin/scheduler/run
// call landed close enough together that BOTH ran runSchedulerTick() at
// once, each independently computing its own findDueActions() snapshot
// before either had recorded any result — so both attempted several of the
// same leads. In this instance the collision was harmless (both got the
// same "no Connect button" error), but the same interleaving could just as
// easily let two overlapping ticks both pass canSendConnect()'s cap check
// before either call recordConnectSent(), momentarily exceeding the daily
// cap, or — worse — both fire a real connect at the same person in quick
// succession. A single in-process boolean lock is enough here (this is one
// Node process, not a multi-worker deployment): a tick that finds one
// already running just no-ops instead of queueing or blocking, since the
// next tick 5 minutes later (or the next manual trigger) picks up whatever
// was actually due anyway.
let tickInProgress = false;

// A real, live-reproduced gap found this session: canSendConnect()/
// canSendMessage()'s daily/weekly caps only count SUCCESSFUL sends
// (recordConnectSent()/recordMessageSent() are only called after a real
// send succeeds) — so a *failed* attempt never counts against the cap at
// all. That's correct when failures are rare, but a list dominated by
// leads who are already connected (see the doc comment on this exact
// scenario further down this file) turns that into a real problem: none of
// those failed attempts ever trip the daily cap, so nothing stopped this
// loop from working through dozens of leads in a single tick — confirmed
// live, 41 attempts in under 3 minutes from one automatic 5-minute tick,
// every one a real profile page-view on a real account regardless of the
// outcome. MAX_ATTEMPTS_PER_TICK puts a hard ceiling on total *attempts*
// (success or fail) per tick, independent of the success-only caps above —
// this is what actually bounds real-world LinkedIn activity per unit time
// when a chunk of a list turns out to be duds, spreading a dud-heavy list
// out across many ticks (hours) instead of burning through it in minutes.
const MAX_ATTEMPTS_PER_TICK = 5;

/** The background tick (called on an interval from index.ts, and
 * on-demand via POST /api/linkedin/scheduler/run). When manual review is
 * ON (the default — see safety.ts's manualReviewEnabled), this never
 * executes anything itself: it just leaves the due actions for
 * findDueActions() to report, and the frontend's Pending Approval list
 * is what actually triggers executeAction() per item, one explicit click
 * at a time. Manual review OFF is what makes this genuinely autonomous —
 * a deliberate, understood step down from the safer default, not
 * something that happens by accident.
 *
 * With manual review off, this loop is the only thing standing between
 * "rate-limited autonomous sending" (the intended behavior, same operating
 * model as commercial LinkedIn automation tools) and "kept hammering a
 * broken session for however long nobody noticed" — so it stops at the
 * *first* circuit-breaker condition (checkpoint/logged-out/Chrome
 * unreachable), or after MAX_ATTEMPTS_PER_TICK attempts total, rather than
 * working through the rest of `due` in one go. */
export async function runSchedulerTick(): Promise<SchedulerTickResult> {
  if (tickInProgress) {
    return { due: 0, autoExecuted: 0, pendingApproval: 0, errors: 0, circuitBreakerTripped: false, skippedConcurrent: true };
  }
  tickInProgress = true;
  try {
    const due = findDueActions();
    const manualReview = getSafetySettings().manualReviewEnabled;
    if (manualReview || due.length === 0) {
      return { due: due.length, autoExecuted: 0, pendingApproval: manualReview ? due.length : 0, errors: 0, circuitBreakerTripped: false };
    }
    let autoExecuted = 0;
    let errors = 0;
    for (const action of due.slice(0, MAX_ATTEMPTS_PER_TICK)) {
      const result = await executeAction(action);
      if (result.ok) {
        autoExecuted++;
      } else {
        errors++;
        if (result.circuitBreakerTripped) {
          return { due: due.length, autoExecuted, pendingApproval: 0, errors, circuitBreakerTripped: true };
        }
      }
    }
    return { due: due.length, autoExecuted, pendingApproval: 0, errors, circuitBreakerTripped: false };
  } finally {
    tickInProgress = false;
  }
}

// --- Stale invite cleanup (Phase 3 — "Auto-withdraw зависших инвайтов",
// TZ_LinkedIn_Automation.md section 3) — a real gap Phase 1 left open: a
// lead that never accepts a connection request just sat 'pending'
// forever, with nothing in this codebase tracking or offering to clean it
// up. Deliberately NOT wired into runSchedulerTick()'s auto-execute path
// above, even with manual review off: withdrawing is a real LinkedIn
// action with its own risk profile (this app has never fired it, so
// there's no field experience yet with how LinkedIn's UI actually behaves
// here — see withdrawConnectionRequest()'s own doc comment on why it's a
// best-effort implementation against a page this feature has never
// actually exercised), and turning "manual review off" already means for
// *outreach* actions shouldn't silently also start firing a category of
// action the user never separately opted into. findStaleInvites/
// withdrawInvite are only ever called from an explicit per-lead button
// click (StaleInvitesPanel.tsx), same "review a list, approve one item at
// a time" shape as the Pending Approval panel.

export interface StaleInvite {
  leadId: string;
  leadUrl: string;
  leadName: string | null;
  campaignId: string;
  campaignName: string;
  sentAt: number;
  daysSince: number;
}

/** Every lead still 'pending' (invite sent, not yet accepted or replied)
 * whose connect was sent at least `minDays` ago, across *every* campaign
 * regardless of its own status — a paused or completed campaign can still
 * have real pending invites worth cleaning up, unlike findDueActions()
 * (which only looks at 'active' campaigns, since nothing new should be
 * *sent* for an inactive one, but an already-sent invite still exists on
 * LinkedIn's side either way). */
export function findStaleInvites(minDays = 14): StaleInvite[] {
  const now = Date.now();
  const stale: StaleInvite[] = [];
  for (const campaign of listCampaigns()) {
    const leads = listLeadsForCampaign(campaign.id).filter((l) => l.status === 'pending');
    for (const lead of leads) {
      const sentAt = getLastActionTime(lead.id);
      if (sentAt === null) continue;
      const daysSince = Math.floor((now - sentAt) / DAY_MS);
      if (daysSince < minDays) continue;
      stale.push({
        leadId: lead.id,
        leadUrl: lead.linkedinUrl,
        leadName: lead.name,
        campaignId: campaign.id,
        campaignName: campaign.name,
        sentAt,
        daysSince,
      });
    }
  }
  return stale;
}

/** Withdraws one stale invite — re-verifies the lead is still 'pending'
 * right before acting (same stale-snapshot caution as approveAction；
 * inbox sync could have promoted it to 'connected' since the list was
 * fetched), then marks it 'withdrawn' on success so it stops showing up
 * here and in any future due-action consideration. */
export async function withdrawInvite(leadId: string): Promise<ExecuteResult> {
  const match = findStaleInvites(0).find((s) => s.leadId === leadId);
  if (!match) return { ok: false, error: 'This lead is no longer a pending invite (already accepted, replied, or withdrawn).' };
  const startedAt = Date.now();
  try {
    await withdrawConnectionRequest(match.leadUrl);
    logAction({
      leadId,
      stepId: null,
      actionType: 'withdraw',
      status: 'success',
      targetUrl: match.leadUrl,
      detail: null,
      executedAt: startedAt,
      responseTimeMs: Date.now() - startedAt,
    });
    updateLeadStatus(leadId, 'withdrawn');
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to withdraw invitation';
    logAction({
      leadId,
      stepId: null,
      actionType: 'withdraw',
      status: 'error',
      targetUrl: match.leadUrl,
      detail: message,
      executedAt: startedAt,
      responseTimeMs: Date.now() - startedAt,
    });
    return { ok: false, error: message };
  }
}
