import {
  listCampaigns,
  listLeadsForCampaign,
  getCampaign,
  listSequenceSteps,
  getLastCompletedStepOrder,
  getActionsForStep,
  getActionsSince,
  type Lead,
} from './db.js';

export interface Funnel {
  totalLeads: number;
  /** A connect was attempted for this lead — everything past the plain
   * 'new' state, regardless of outcome. */
  sent: number;
  /** LinkedIn only allows messaging a 1st-degree connection, so
   * 'connected'/'replied' both imply the invite was accepted — see
   * inbox.ts's syncInbox() for how a lead actually gets promoted here. */
  accepted: number;
  replied: number;
  skipped: number;
  acceptRate: number;
  replyRate: number;
}

function computeFunnel(leads: Lead[]): Funnel {
  const totalLeads = leads.length;
  const sent = leads.filter((l) => l.status !== 'new').length;
  const accepted = leads.filter((l) => l.status === 'connected' || l.status === 'replied').length;
  const replied = leads.filter((l) => l.status === 'replied').length;
  const skipped = leads.filter((l) => l.status === 'skipped').length;
  return {
    totalLeads,
    sent,
    accepted,
    replied,
    skipped,
    acceptRate: sent > 0 ? accepted / sent : 0,
    replyRate: accepted > 0 ? replied / accepted : 0,
  };
}

export interface CampaignFunnel extends Funnel {
  campaignId: string;
  campaignName: string;
}

export function getCampaignFunnel(campaignId: string): CampaignFunnel | null {
  const campaign = getCampaign(campaignId);
  if (!campaign) return null;
  return { campaignId, campaignName: campaign.name, ...computeFunnel(listLeadsForCampaign(campaignId)) };
}

export interface AnalyticsSummary {
  overall: Funnel;
  campaigns: CampaignFunnel[];
}

/** Phase 1's funnel was deliberately "basic" — sent/accepted/replied per
 * campaign, no time-series/trend view. Still cheap to compute directly
 * from current lead statuses (small-scale personal tool, not something
 * aggregating over millions of rows), and still the right *overall*
 * number to lead with — the two Phase 2 additions below (step breakdown,
 * daily activity) are for the two questions this summary alone can't
 * answer: "where exactly in the sequence are leads dropping off" and
 * "how much did I actually send today/this week." */
export function getAnalyticsSummary(): AnalyticsSummary {
  const campaigns = listCampaigns();
  const campaignFunnels = campaigns.map((c) => ({ campaignId: c.id, campaignName: c.name, ...computeFunnel(listLeadsForCampaign(c.id)) }));
  const allLeads = campaigns.flatMap((c) => listLeadsForCampaign(c.id));
  return { overall: computeFunnel(allLeads), campaigns: campaignFunnels };
}

export interface StepBreakdown {
  stepId: string;
  stepOrder: number;
  type: 'connect' | 'message';
  /** Leads whose next due step is this one, AND who are actually eligible
   * for it right now (findDueActions()'s own gate) — haven't reached it
   * yet, but nothing else is blocking it either. */
  waiting: number;
  /** Correctly positioned for this step but NOT yet eligible — currently
   * only possible for a 'message' step whose lead hasn't been promoted to
   * 'connected' yet (findDueActions() requires that; a pending, not-yet-
   * accepted invite means the follow-up simply can't fire regardless of
   * sequencing). Without this split, a message step would misleadingly
   * show these leads as "waiting for their follow-up" when in reality
   * nothing will happen until they accept the connection — a real,
   * found-on-review inaccuracy, not just a naming nicety. */
  blocked: number;
  /** Leads who've successfully completed this step (and moved past it). */
  completed: number;
  /** Leads whose most recent attempt at this exact step failed and hasn't
   * succeeded since (a real, visible "stuck here" signal a lead-status
   * funnel alone can't show — a failed step 2 and a not-yet-attempted
   * step 2 both just look like "hasn't reached step 2" from lead.status). */
  failing: number;
}

/** Per-step funnel for one campaign — answers "where exactly are leads
 * dropping off," which the overall sent/accepted/replied funnel can't:
 * that funnel treats every non-'new' lead as "sent" regardless of which
 * step of a 3-step sequence they actually reached. Computed per-lead
 * (getLastCompletedStepOrder, already used by the Scheduler itself) rather
 * than a new bulk query — personal-scale lead counts (tens to low
 * hundreds per campaign) make the O(leads × steps) cost here negligible,
 * and it keeps this single source of truth for "what step is this lead
 * on" instead of a second, potentially-drifting computation. */
export function getCampaignStepBreakdown(campaignId: string): StepBreakdown[] {
  const steps = listSequenceSteps(campaignId);
  if (steps.length === 0) return [];
  // 'withdrawn' leads (Phase 3) are excluded the same way 'skipped' ones
  // already are — the sequence has permanently ended for them either
  // way, so counting them as "waiting" for their next step would be
  // wrong (they'll never actually reach it).
  const leads = listLeadsForCampaign(campaignId).filter((l) => l.status !== 'skipped' && l.status !== 'withdrawn');
  const lastStepOrderByLead = new Map(leads.map((l) => [l.id, getLastCompletedStepOrder(l.id)]));

  return steps.map((step) => {
    const positioned = leads.filter((l) => (lastStepOrderByLead.get(l.id) ?? -1) === step.stepOrder - 1);
    // Same eligibility gate findDueActions() itself applies — a message
    // step never becomes due for a lead that isn't 'connected' yet,
    // regardless of sequence position.
    const blocked = step.type === 'message' ? positioned.filter((l) => l.status !== 'connected').length : 0;
    const waiting = positioned.length - blocked;
    const completed = leads.filter((l) => (lastStepOrderByLead.get(l.id) ?? -1) >= step.stepOrder).length;
    // "Failing" = currently sitting right before this step (hasn't
    // completed it) but has at least one logged failed attempt at it —
    // distinguishes "hasn't been tried yet" from "was tried and failed."
    const actions = getActionsForStep(step.id);
    const failedLeadIds = new Set(
      actions.filter((a) => a.status === 'error' && a.leadId).map((a) => a.leadId as string),
    );
    const succeededLeadIds = new Set(
      actions.filter((a) => a.status === 'success' && a.leadId).map((a) => a.leadId as string),
    );
    const failing = leads.filter(
      (l) => (lastStepOrderByLead.get(l.id) ?? -1) === step.stepOrder - 1 && failedLeadIds.has(l.id) && !succeededLeadIds.has(l.id),
    ).length;

    return { stepId: step.id, stepOrder: step.stepOrder, type: step.type, waiting, blocked, completed, failing };
  });
}

export interface DailyActivity {
  date: string;
  connectsSent: number;
  messagesSent: number;
  errors: number;
}

// Anchoring day-bucket math to UTC throughout (construction, arithmetic,
// AND extraction) avoids the exact class of bug documented at length
// elsewhere in this app (utils/callStats.ts's addDays — mixing local-time
// construction with UTC extraction could return the same calendar date
// for "+1 day" in a positive-UTC-offset timezone, not just an off-by-one
// but a loop that never terminates). Nothing here needs to reflect the
// user's own wall-clock day the way, say, "today" in a UI label would.
function dayKeyUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Daily connects/messages/errors across *every* campaign for the last
 * `days` days — the local, permanent activity record this app can offer
 * that LinkedIn's own UI doesn't surface at all. Built from actions_log
 * (every real send attempt, success or fail), not from lead status
 * snapshots, since a lead's current status only reflects its *latest*
 * state, not how many attempts happened on which days. */
export function getDailyActivity(days = 30): DailyActivity[] {
  const since = Date.now() - days * 86_400_000;
  const actions = getActionsSince(since);
  const byDay = new Map<string, DailyActivity>();
  for (const a of actions) {
    const key = dayKeyUtc(a.executedAt);
    let entry = byDay.get(key);
    if (!entry) {
      entry = { date: key, connectsSent: 0, messagesSent: 0, errors: 0 };
      byDay.set(key, entry);
    }
    if (a.status === 'error') entry.errors++;
    else if (a.actionType === 'connect') entry.connectsSent++;
    else if (a.actionType === 'message') entry.messagesSent++;
  }
  // Filled forward so the chart has one point per day even for a day with
  // zero activity — matches CallsStatsView's own bucketByDay convention
  // (a real gap should read as "quiet," not be missing from the axis).
  const result: DailyActivity[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKeyUtc(Date.now() - i * 86_400_000);
    result.push(byDay.get(key) ?? { date: key, connectsSent: 0, messagesSent: 0, errors: 0 });
  }
  return result;
}
