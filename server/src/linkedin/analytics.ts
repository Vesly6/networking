import {
  listCampaigns,
  listLeadsForCampaign,
  getCampaign,
  getCampaignGraph,
  getLastCompletedNodeId,
  getActionsForStep,
  getActionsSince,
  type Lead,
  type SequenceNodeType,
} from './db.js';
import { findDueActions, isConditionNodeType } from './scheduler.js';

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
  type: SequenceNodeType;
  /** Leads for whom this exact node is what's actually due right now
   * (findDueActions()'s own output — every gate, including a condition
   * node's timeout, already applied). */
  waiting: number;
  /** For a 'message' node only: leads who've completed the node
   * immediately feeding into it but aren't 'connected' yet, so the
   * message can't fire regardless of graph position — without this
   * split, they'd misleadingly read as "waiting for their follow-up" when
   * nothing will actually happen until they accept the connection. Only
   * computed when this node has exactly one incoming 'default' edge (the
   * overwhelmingly common shape); a message node reached some more exotic
   * way in a hand-built graph just reports 0 here rather than guessing. */
  blocked: number;
  /** Leads who've successfully executed this exact node at least once. */
  completed: number;
  /** Leads whose most recent attempt at this exact node failed and hasn't
   * succeeded since (a real, visible "stuck here" signal a lead-status
   * funnel alone can't show). */
  failing: number;
}

/** Per-node funnel for one campaign's graph — answers "where exactly are
 * leads dropping off," which the overall sent/accepted/replied funnel
 * can't. Only action-type nodes are reported (wait/condition/end nodes
 * are structural, not something a lead visibly "sits at" from a reporting
 * standpoint). `waiting` comes straight from findDueActions() rather than
 * re-deriving graph-position logic a second time here — same single-
 * source-of-truth reasoning the old step_order version already followed,
 * just pointed at the Scheduler's own real traversal instead of a
 * simpler ordinal comparison that no longer applies to an arbitrary
 * graph. */
export function getCampaignStepBreakdown(campaignId: string): StepBreakdown[] {
  const { nodes, edges } = getCampaignGraph(campaignId);
  const actionNodes = nodes.filter((n) => n.type !== 'wait' && n.type !== 'end' && !isConditionNodeType(n.type));
  if (actionNodes.length === 0) return [];

  // 'withdrawn' leads (Phase 3) are excluded the same way 'skipped' ones
  // already are — the sequence has permanently ended for them either
  // way, so counting them anywhere in this breakdown would be wrong
  // (they'll never actually reach anything further).
  const leads = listLeadsForCampaign(campaignId).filter((l) => l.status !== 'skipped' && l.status !== 'withdrawn');
  const lastNodeIdByLead = new Map(leads.map((l) => [l.id, getLastCompletedNodeId(l.id)]));

  const dueHere = new Map<string, number>();
  for (const action of findDueActions()) {
    if (action.campaignId !== campaignId) continue;
    dueHere.set(action.stepId, (dueHere.get(action.stepId) ?? 0) + 1);
  }

  return actionNodes.map((node) => {
    const waiting = dueHere.get(node.id) ?? 0;

    let blocked = 0;
    if (node.type === 'message') {
      const incoming = edges.filter((e) => e.toNodeId === node.id && e.branch === 'default');
      if (incoming.length === 1 && incoming[0].fromNodeId) {
        const priorNodeId = incoming[0].fromNodeId;
        blocked = leads.filter((l) => lastNodeIdByLead.get(l.id) === priorNodeId && l.status !== 'connected').length;
      }
    }

    const actions = getActionsForStep(node.id);
    const succeededLeadIds = new Set(actions.filter((a) => a.status === 'success' && a.leadId).map((a) => a.leadId as string));
    const completed = succeededLeadIds.size;
    const failedLeadIds = new Set(actions.filter((a) => a.status === 'error' && a.leadId).map((a) => a.leadId as string));
    const failing = leads.filter((l) => failedLeadIds.has(l.id) && !succeededLeadIds.has(l.id)).length;

    return { stepId: node.id, type: node.type, waiting, blocked, completed, failing };
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
