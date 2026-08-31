import {
  listCampaigns,
  listLeadsForCampaign,
  getCampaignGraph,
  getLastCompletedNodeId,
  getLastActionTime,
  getLastActionForLeadStep,
  logAction,
  updateLeadStatus,
  type Lead,
  type SequenceNode,
  type SequenceEdge,
  type SequenceNodeType,
} from './db.js';
import {
  getSafetySettings,
  getSafetySnapshot,
  canSendConnect,
  recordConnectSent,
  recordConnectAttempt,
  canSendMessage,
  recordMessageSent,
  setPaused,
  isPaused,
  type SafetySettings,
} from './safety.js';
import { getOrCreateTodaysPlan, nextDueSlot } from './dailyPlan.js';
import { getLinkedInPage } from './browser.js';
import {
  sendConnectionRequest,
  sendMessage,
  withdrawConnectionRequest,
  viewProfile,
  followProfile,
  likeLatestPost,
  ALREADY_CONNECTED_ERROR,
} from './page.js';
import { maybeRunHumanizePass } from './humanize.js';
import { personalizeLinkedInMessage } from '../openai.js';

// The LinkedIn feature is still single-tenant end to end (one shared
// browser/session, no company_id column anywhere in linkedin.sqlite —
// see this codebase's own notes on the deferred multi-company project).
// dailyPlan.ts's persona-bias seeding takes a companyId purely so a
// future multi-tenant version can vary it per account without touching
// dailyPlan.ts itself; today there's only ever one real caller, so a
// fixed constant is the correct, honest value rather than threading a
// real company id through a feature that doesn't have per-company state
// anywhere else yet.
const SINGLE_TENANT_PLAN_ID = 'default';

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
 * it's noticed). Also matches page.ts's ALREADY_CONNECTED_ERROR — the
 * "Remove Connection" seen inside the "···" More menu — the same terminal
 * "already connected" outcome, just detected a different way. */
function isNoConnectButtonError(detail: string | null): boolean {
  return (
    detail === 'No "Connect" button found on this profile — may already be connected/pending, or the page layout changed.' ||
    detail === ALREADY_CONNECTED_ERROR
  );
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
  stepType: SequenceNodeType;
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

// --- Graph traversal (the visual campaign builder) ---
// Replaces the old flat "step_order + 1" logic. A campaign's graph is a
// small set of nodes/edges (see db.ts's own schema comment) walked fresh
// on every findDueActions() call, never cached — personal-scale campaigns
// (a handful of nodes, hundreds of leads at most) make this cheap enough
// that there's no reason to maintain a second, potentially-stale copy of
// "where is this lead right now."

const START_KEY = '__start__';
const MAX_GRAPH_HOPS = 25;

const CONDITION_TYPES = new Set<SequenceNodeType>([
  'condition_connected',
  'condition_replied',
  'condition_followed_back',
  'condition_profile_visited',
  'condition_post_liked',
  'condition_custom',
]);

/** Exported so analytics.ts's per-node breakdown can filter out structural
 * (condition) nodes the same way this file does, without duplicating or
 * drifting from this list. */
export function isConditionNodeType(type: SequenceNodeType): boolean {
  return CONDITION_TYPES.has(type);
}

type ConditionResult = 'yes' | 'no' | 'pending';

/** Only the two condition types with real detection wired up today
 * (lead.status is already tracked via inbox.ts's sync) resolve to
 * anything other than 'pending' — the "coming soon" condition types
 * (followed back / profile visited / post liked / custom) have no
 * detection implemented yet, so a lead standing at one of them just never
 * advances, rather than resolving based on a signal that was never
 * actually checked. The frontend palette keeps those disabled for exactly
 * this reason; this is the belt-and-suspenders backend half of that same
 * guarantee, in case a graph ever contains one some other way. */
function evaluateCondition(node: SequenceNode, lead: Lead, lastActionTime: number | null, now: number): ConditionResult {
  const timeoutElapsed = lastActionTime !== null && now >= lastActionTime + (node.waitDays ?? 0) * DAY_MS;
  if (node.type === 'condition_connected') {
    if (lead.status === 'connected' || lead.status === 'replied') return 'yes';
    return timeoutElapsed ? 'no' : 'pending';
  }
  if (node.type === 'condition_replied') {
    if (lead.status === 'replied') return 'yes';
    return timeoutElapsed ? 'no' : 'pending';
  }
  return 'pending';
}

/** Walks a lead's graph position forward from `lastNodeId` (the id of the
 * most recently *completed* node — see getLastCompletedNodeId — or `null`
 * for a lead that hasn't started at all, in which case the walk begins at
 * the graph's own start edge) until it reaches a real action node (what's
 * actually due right now), an 'end' node (sequence finished for this lead
 * — returns null), or a node whose gate/condition isn't satisfied yet
 * (also null — "not due yet", same meaning as the old model's dueAt-in-
 * the-future case). 'wait' and condition nodes are purely structural —
 * they're never themselves "due," the walk passes straight through them
 * in the same call. Bounded by MAX_GRAPH_HOPS purely as a safety net
 * against a malformed/cyclic hand-authored graph looping forever within
 * one call — a well-formed graph never gets remotely close to that many
 * hops in a single resolution. */
function resolveNextNode(
  nodesById: Map<string, SequenceNode>,
  edgesFrom: Map<string, SequenceEdge[]>,
  lead: Lead,
  lastNodeId: string | null,
  now: number,
): SequenceNode | null {
  const lastActionTime = getLastActionTime(lead.id);
  let fromKey = lastNodeId ?? START_KEY;

  for (let hop = 0; hop < MAX_GRAPH_HOPS; hop++) {
    const candidates = edgesFrom.get(fromKey) ?? [];
    if (candidates.length === 0) return null; // dead end — nothing wired here

    let nextEdge: SequenceEdge | undefined;
    if (fromKey === START_KEY) {
      nextEdge = candidates[0];
    } else {
      const node = nodesById.get(fromKey);
      if (!node) return null;
      if (node.type === 'wait') {
        // A fresh lead (no prior action at all) skips any wait gate
        // unconditionally — matches the old model's own "a lead's first
        // step is due immediately regardless of its configured delay"
        // behavior exactly (getLastActionTime is null in precisely that
        // case, by construction).
        const satisfied = lastActionTime === null || now >= lastActionTime + (node.waitDays ?? 0) * DAY_MS;
        if (!satisfied) return null;
        nextEdge = candidates.find((e) => e.branch === 'default');
      } else if (CONDITION_TYPES.has(node.type)) {
        const result = evaluateCondition(node, lead, lastActionTime, now);
        if (result === 'pending') return null;
        nextEdge = candidates.find((e) => e.branch === result);
      } else {
        // A real action node (or, defensively, 'end' — though 'end' has no
        // outgoing edges by construction) reached as fromKey only happens
        // on the very first hop, when lastNodeId is itself a completed
        // action. Its single outgoing edge is unconditional — any timing
        // gate lives on a 'wait' node between it and whatever's next, not
        // on the action node itself.
        nextEdge = candidates.find((e) => e.branch === 'default') ?? candidates[0];
      }
    }
    if (!nextEdge) return null;
    const nextNode = nodesById.get(nextEdge.toNodeId);
    if (!nextNode) return null;

    if (nextNode.type === 'end') return null; // sequence finished for this lead
    if (nextNode.type !== 'wait' && !CONDITION_TYPES.has(nextNode.type)) {
      return nextNode; // a real action — this is what's due (subject to executeAction's own Safety Engine gating)
    }
    fromKey = nextNode.id; // wait/condition — keep walking transparently in this same call
  }
  console.warn('[linkedin/scheduler] graph walk exceeded', MAX_GRAPH_HOPS, 'hops for lead', lead.id, '— likely a cyclic graph, treating as not due this tick.');
  return null;
}

/** Walks every *active* campaign's leads and figures out which ones are
 * due for their next graph node right now. Read-only — doesn't execute
 * or check the Safety Engine; see executeAction()/runSchedulerTick()
 * below for that. */
export function findDueActions(now = Date.now()): DueAction[] {
  const due: DueAction[] = [];
  const campaigns = listCampaigns().filter((c) => c.status === 'active');

  for (const campaign of campaigns) {
    const { nodes, edges } = getCampaignGraph(campaign.id);
    if (nodes.length === 0) continue;

    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    const edgesFrom = new Map<string, SequenceEdge[]>();
    for (const e of edges) {
      const key = e.fromNodeId ?? START_KEY;
      const arr = edgesFrom.get(key);
      if (arr) arr.push(e);
      else edgesFrom.set(key, [e]);
    }

    // 'withdrawn' (Phase 3): a lead whose invite was pulled back should
    // never come up as due for anything else either — same reasoning as
    // excluding 'replied'/'skipped' here.
    const leads = listLeadsForCampaign(campaign.id).filter(
      (l) => l.status !== 'replied' && l.status !== 'skipped' && l.status !== 'withdrawn',
    );

    for (const lead of leads) {
      const lastNodeId = getLastCompletedNodeId(lead.id);
      const nextNode = resolveNextNode(nodesById, edgesFrom, lead, lastNodeId, now);
      if (!nextNode) continue;

      // Defensive fallback gate — a well-authored graph places a
      // 'condition_connected' node before any 'message' node, but a
      // simple/malformed graph might not; this catches that case
      // regardless of graph shape, same safety net the old model applied
      // unconditionally.
      if (nextNode.type === 'message' && lead.status !== 'connected') continue;

      // A connect node whose most recent attempt for THIS lead already
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
      if (nextNode.type === 'connect') {
        const lastAttempt = getLastActionForLeadStep(lead.id, nextNode.id);
        if (lastAttempt?.status === 'error' && isNoConnectButtonError(lastAttempt.detail)) continue;
      }

      due.push({
        leadId: lead.id,
        leadUrl: lead.linkedinUrl,
        leadName: lead.name,
        leadTitle: lead.title,
        leadCompany: lead.company,
        campaignId: campaign.id,
        campaignName: campaign.name,
        stepId: nextNode.id,
        stepType: nextNode.type,
        messageTemplate: nextNode.messageTemplate,
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

/** Shared "run the Playwright call, log the outcome either way, trip the
 * circuit breaker on a session-level failure" wrapper — every action type
 * below goes through this so that behavior (and the log shape) stays
 * identical regardless of which graph node type triggered it. Pre-checks
 * (Safety Engine caps) and post-success side effects (counters, lead
 * status transitions) that differ per type stay in each type's own call
 * site, not folded in here. */
async function runAndLog(action: DueAction, actionType: string, fn: () => Promise<unknown>): Promise<ExecuteResult> {
  const startedAt = Date.now();
  try {
    const timing = await fn();
    logAction({
      leadId: action.leadId,
      stepId: action.stepId,
      actionType,
      status: 'success',
      targetUrl: action.leadUrl,
      detail: null,
      executedAt: startedAt,
      responseTimeMs: Date.now() - startedAt,
      timingJson: timing ? JSON.stringify(timing) : null,
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : `Failed to execute ${actionType}`;
    logAction({
      leadId: action.leadId,
      stepId: action.stepId,
      actionType,
      status: 'error',
      targetUrl: action.leadUrl,
      detail: message,
      executedAt: startedAt,
      responseTimeMs: Date.now() - startedAt,
    });
    // Auto-pause on a checkpoint/logged-out/unreachable-Chrome condition —
    // this is the durable, server-side circuit breaker: it doesn't depend
    // on anyone (human or AI) watching a dashboard or a chat session
    // staying alive. The next scheduler tick sees `paused` and stops
    // considering anything due at all until a human explicitly resumes.
    if (isCircuitBreakerCondition(err)) {
      setPaused(true);
      return { ok: false, error: message, circuitBreakerTripped: true };
    }
    return { ok: false, error: message };
  }
}

/** Automatic pre-send personalization step — folded directly into
 * executeAction() below now that nothing waits for a human to review a
 * send first (see safety.ts's auto_personalize_enabled doc comment for
 * why this replaced the old Pending Approval panel's manual "🤖
 * Personalizuoti" button). Off (default) or no key configured: returns
 * the plain placeholder-substituted text unchanged. On: asks OpenAI for a
 * light rewrite and uses that instead — but never lets a failed AI call
 * block a send, since the plain-substitution text is always a safe
 * fallback and this step is a nice-to-have, not a requirement. */
async function resolveOutgoingText(
  placeholderText: string,
  action: DueAction,
  settings: SafetySettings,
  openaiApiKey: string | undefined,
  isConnectNote: boolean,
): Promise<string> {
  if (!settings.autoPersonalizeEnabled || !openaiApiKey || !placeholderText) return placeholderText;
  try {
    const nameParts = action.leadName?.trim().split(/\s+/) ?? [];
    const result = await personalizeLinkedInMessage(
      {
        template: action.messageTemplate ?? '',
        firstName: nameParts[0] ?? null,
        lastName: nameParts.slice(1).join(' ') || null,
        title: action.leadTitle,
        company: action.leadCompany,
        isConnectNote,
      },
      openaiApiKey,
    );
    return result.text;
  } catch (err) {
    console.error(
      '[linkedin/personalize] auto-personalize failed for lead',
      action.leadId,
      '— falling back to plain template:',
      err instanceof Error ? err.message : err,
    );
    return placeholderText;
  }
}

/** Actually performs one due action — the Safety Engine check happens
 * here, immediately before the real Playwright call, not earlier in
 * findDueActions() (state can change between "found due" and "about to
 * execute," e.g. another action in the same tick already used up the
 * daily cap). Logs the outcome either way. `openaiApiKey`, when supplied
 * (runSchedulerTick passes the owner company's own configured key — see
 * that function's doc comment on why this file otherwise stays
 * company-agnostic), only ever affects resolveOutgoingText() above. */
export async function executeAction(action: DueAction, openaiApiKey?: string): Promise<ExecuteResult> {
  const settings = getSafetySettings();
  // {{firstName}}/{{title}}/{{company}} substituted from the lead's own
  // fields — a free personalization floor every send gets, independent of
  // resolveOutgoingText()'s optional AI rewrite on top of it.
  const placeholderText = applyLeadPlaceholders(action.messageTemplate ?? '', {
    name: action.leadName,
    title: action.leadTitle,
    company: action.leadCompany,
  }).trim();

  if (action.stepType === 'connect') {
    const check = canSendConnect();
    if (!check.allowed) return { ok: false, error: check.reason };
    // Counted unconditionally, before the outcome is known — this is what
    // actually bounds total profile-page-view activity per day regardless
    // of how many attempts turn out to be duds (already-connected leads).
    // See canSendConnect()'s own doc comment on why the success-only caps
    // alone weren't enough.
    recordConnectAttempt();
    // The connect node's own messageTemplate doubles as the optional
    // "Add a note" text (LinkedIn's connect flow, not a separate DM).
    const resolvedText = await resolveOutgoingText(placeholderText, action, settings, openaiApiKey, true);
    const result = await runAndLog(action, 'connect', () => sendConnectionRequest(action.leadUrl, resolvedText || undefined, action.leadName));
    if (result.ok) {
      recordConnectSent();
      updateLeadStatus(action.leadId, 'pending');
    }
    return result;
  }

  if (action.stepType === 'message') {
    const check = canSendMessage();
    if (!check.allowed) return { ok: false, error: check.reason };
    if (!placeholderText) return { ok: false, error: 'This step has no message template set.' };
    const resolvedText = await resolveOutgoingText(placeholderText, action, settings, openaiApiKey, false);
    const result = await runAndLog(action, 'message', () => sendMessage(action.leadUrl, resolvedText));
    if (result.ok) recordMessageSent();
    return result;
  }

  if (action.stepType === 'withdraw') {
    if (isPaused()) return { ok: false, error: 'Automation is paused (stop switch is on).' };
    const result = await runAndLog(action, 'withdraw', () => withdrawConnectionRequest(action.leadUrl));
    if (result.ok) updateLeadStatus(action.leadId, 'withdrawn');
    return result;
  }

  if (action.stepType === 'view_profile') {
    if (isPaused()) return { ok: false, error: 'Automation is paused (stop switch is on).' };
    return runAndLog(action, 'view_profile', () => viewProfile(action.leadUrl));
  }

  if (action.stepType === 'follow') {
    if (isPaused()) return { ok: false, error: 'Automation is paused (stop switch is on).' };
    return runAndLog(action, 'follow', () => followProfile(action.leadUrl));
  }

  if (action.stepType === 'like_post') {
    if (isPaused()) return { ok: false, error: 'Automation is paused (stop switch is on).' };
    return runAndLog(action, 'like_post', () => likeLatestPost(action.leadUrl));
  }

  // 'wait'/'end'/condition_* node types are never returned as a DueAction
  // by findDueActions() (they're resolved transparently or terminate the
  // walk — see resolveNextNode above), and the "coming soon" action types
  // (inmail/endorse/find_email) have no implementation to call yet — the
  // frontend palette keeps those disabled, so reaching here means either a
  // hand-crafted API call or a genuine bug; fail clearly rather than
  // silently no-opping.
  return { ok: false, error: `No execution handler for node type "${action.stepType}".` };
}

export interface SchedulerTickResult {
  due: number;
  autoExecuted: number;
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
  /** True when there *were* due actions but today's human-paced plan
   * (dailyPlan.ts) says it isn't time for the next one yet, or today's
   * randomized target has already been reached —
   * distinct from `due === 0` (nothing needs doing at all) and from
   * `skippedConcurrent` (a different tick is already running). This is the
   * normal, expected result most ticks return once the plan is wired in —
   * "there's due work, but not right now" is the whole point. */
  waitingForNextSlot?: boolean;
  /** True when an automatic tick found due work and its slot but skipped
   * anyway because no LinkedIn tab is currently open in the automation
   * Chrome — see browser.ts's getLinkedInPage(requireExistingTab) doc
   * comment for the real incident this prevents (auto-recreating a tab
   * the account owner deliberately closed). Never set on a manual tick,
   * which still opens a tab on demand as before. */
  noTabOpen?: boolean;
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

/** The background tick — called on-demand via POST
 * /api/linkedin/scheduler/run (`isAutomatic = false`, the default) and,
 * separately, on index.ts's own background interval (`isAutomatic = true`
 * — see that call site's own doc comment for why the interval was safe to
 * bring back). Manual review was removed from this codebase entirely (on
 * explicit request — "Убрать совсем из кода"): a due action always
 * executes here, gated only by the Safety Engine's own caps/pause/work-
 * hours/warm-up ramp inside executeAction(), the same gate that already
 * governed every send even when manual review was on. There is no queue
 * for a human to review first — this is meant to "work on its own,
 * without stopping."
 *
 * `openaiApiKey`, when supplied by the caller (index.ts resolves the
 * owner company's own configured key), passes straight through to
 * executeAction() for the optional auto-personalize step — see
 * resolveOutgoingText()'s own doc comment. Omitted or no key configured:
 * plain placeholder substitution only, same as always.
 *
 * `isAutomatic` controls two things a *manual* "▶ Vykdyti dabar" click
 * deliberately skips (a human clicking that button is already a
 * supervised, deliberate action — the pacing below exists specifically
 * for the unattended path):
 * - the daily plan gate (dailyPlan.ts) — paces *when* a tick is allowed to
 *   act at all, separate from the existing per-action canSendConnect()
 *   Safety Engine check inside executeAction(), which still governs
 *   *whether* a specific send is allowed once a slot's time has come.
 *   Without this, an automatic tick fired every due lead back-to-back the
 *   instant it found them (confirmed live this session) — functionally
 *   within the caps, but a pattern that reads as scripted rather than a
 *   person working through their day.
 * - the per-tick execution cap: automatic ticks process at most ONE due
 *   action (once the plan says a slot is actually due), not up to
 *   MAX_ATTEMPTS_PER_TICK — the plan's whole premise is one paced action
 *   per due moment, not a burst; a manual click keeps the original
 *   up-to-MAX_ATTEMPTS_PER_TICK behavior, since a human explicitly asking
 *   to "run now" reasonably means "work through what's due," and stops at
 *   the *first* circuit-breaker condition (checkpoint/logged-out/Chrome
 *   unreachable) either way. */
export async function runSchedulerTick(isAutomatic = false, openaiApiKey?: string): Promise<SchedulerTickResult> {
  if (tickInProgress) {
    return { due: 0, autoExecuted: 0, errors: 0, circuitBreakerTripped: false, skippedConcurrent: true };
  }
  tickInProgress = true;
  try {
    // Feed-activity "texture" (humanize.ts) is independent of whether any
    // connect is due — a real person checks their own feed regardless of
    // whether they happen to have someone to connect with today.
    // Automatic ticks only (a manual "run now" click has no business also
    // triggering unrelated feed activity), and only when a LinkedIn tab is
    // already open — same root-cause tab-existence rule every other
    // automatic action in this feature follows, so this can never be the
    // thing that reopens a deliberately-closed Chrome tab.
    // maybeRunHumanizePass() has its own internal pause/work-hours/
    // frequency/probability gates, so most calls here are a no-op.
    if (isAutomatic && (await getLinkedInPage(true)) !== null) {
      const humanizeResult = await maybeRunHumanizePass();
      if (humanizeResult.ran) {
        console.log('[linkedin/humanize] liked', humanizeResult.liked, 'feed post(s) this tick.');
      }
    }

    const due = findDueActions();
    if (due.length === 0) {
      return { due: 0, autoExecuted: 0, errors: 0, circuitBreakerTripped: false };
    }
    const settings = getSafetySettings();

    let actionable = due;
    if (isAutomatic) {
      const snapshot = getSafetySnapshot();
      const plan = await getOrCreateTodaysPlan(settings, snapshot.effectiveDailyCap, SINGLE_TENANT_PLAN_ID);
      const dueSlot = nextDueSlot(plan, Date.now(), snapshot.connectsToday);
      if (dueSlot === null) {
        return { due: due.length, autoExecuted: 0, errors: 0, circuitBreakerTripped: false, waitingForNextSlot: true };
      }
      // Checked here, before calling executeAction() at all — that
      // function's own sendConnectionRequest()/sendMessage() calls
      // getLinkedInPage() with its default (tab-opening) mode, so this is
      // the one place that has to stop an automatic tick from reaching
      // that path when no tab exists, rather than relying on a deeper
      // call site to somehow know it's being run unattended.
      if ((await getLinkedInPage(true)) === null) {
        return { due: due.length, autoExecuted: 0, errors: 0, circuitBreakerTripped: false, noTabOpen: true };
      }
      actionable = due.slice(0, 1);
    } else {
      actionable = due.slice(0, MAX_ATTEMPTS_PER_TICK);
    }

    let autoExecuted = 0;
    let errors = 0;
    for (const action of actionable) {
      const result = await executeAction(action, openaiApiKey);
      if (result.ok) {
        autoExecuted++;
      } else {
        errors++;
        if (result.circuitBreakerTripped) {
          return { due: due.length, autoExecuted, errors, circuitBreakerTripped: true };
        }
      }
    }
    return { due: due.length, autoExecuted, errors, circuitBreakerTripped: false };
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
