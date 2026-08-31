import Papa from 'papaparse';
import { localApiRequest } from './localApi';
import { downloadCsv } from './csv';

export type LinkedInCampaignStatus = 'draft' | 'active' | 'paused' | 'completed';

export interface LinkedInCampaign {
  id: string;
  name: string;
  status: LinkedInCampaignStatus;
  dailyCap: number | null;
  weeklyCap: number | null;
  workHoursStart: string | null;
  workHoursEnd: string | null;
  createdAt: number;
  leadCount: number;
}

export function fetchCampaigns(): Promise<{ campaigns: LinkedInCampaign[] }> {
  return localApiRequest('/api/linkedin/campaigns');
}

export function createCampaign(name: string): Promise<LinkedInCampaign> {
  return localApiRequest('/api/linkedin/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function fetchCampaign(id: string): Promise<LinkedInCampaign> {
  return localApiRequest(`/api/linkedin/campaigns/${encodeURIComponent(id)}`);
}

export function updateCampaignStatus(id: string, status: LinkedInCampaignStatus): Promise<LinkedInCampaign> {
  return localApiRequest(`/api/linkedin/campaigns/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

/** Local-data-only — removes the campaign and its leads from this app's
 * own SQLite store, no LinkedIn side effect at all (nothing here touches
 * a real profile). Same "safe, reversible, local delete" category as
 * deleting a table in the main Table view — still worth a confirm
 * dialog client-side (real work can be lost), just not a real-world one. */
export function deleteCampaign(id: string): Promise<{ ok: true }> {
  return localApiRequest(`/api/linkedin/campaigns/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export type LinkedInLeadStatus = 'new' | 'connected' | 'pending' | 'replied' | 'skipped' | 'withdrawn';

export interface LinkedInLead {
  id: string;
  campaignId: string;
  linkedinUrl: string;
  name: string | null;
  title: string | null;
  company: string | null;
  status: LinkedInLeadStatus;
  source: string | null;
  /** When the connect request was sent, when the lead was detected as
   * accepted, and when the sequence's message step last sent to them — any
   * of these can be null if that hasn't happened yet. Powers the
   * Sent/Connected/Messaged panels and their date filters in
   * CampaignDetail.tsx, on explicit request ("I want to see today's
   * additions later"). */
  connectSentAt: number | null;
  connectedAt: number | null;
  messageSentAt: number | null;
}

export function fetchLeads(campaignId: string): Promise<{ leads: LinkedInLead[] }> {
  return localApiRequest(`/api/linkedin/campaigns/${encodeURIComponent(campaignId)}/leads`);
}

/** Local-only — the leads are already loaded client-side (the campaign
 * detail view's own store state), so this needs no server round-trip,
 * same "export what's already in memory" shape as the main Table's own
 * exportRowsToCsv. Phase 3's "CRM export" item, in the narrow, concrete
 * form this app actually needs: a plain CSV a human can open in Excel or
 * hand to another tool, not a live CRM API integration this project has
 * no specific target for. */
export function exportLeadsToCsv(campaignName: string, leads: LinkedInLead[]): void {
  const csv = Papa.unparse({
    fields: ['Name', 'Title', 'Company', 'LinkedIn URL', 'Status', 'Source'],
    data: leads.map((l) => [l.name ?? '', l.title ?? '', l.company ?? '', l.linkedinUrl, l.status, l.source ?? '']),
  });
  const safeName = campaignName.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'campaign';
  downloadCsv(`linkedin-leads-${safeName}.csv`, csv);
}

export interface NewLead {
  linkedinUrl: string;
  name?: string;
  title?: string;
  company?: string;
  source?: string;
}

/** The CSV file itself is parsed and mapped entirely client-side (see
 * LeadCsvImport.tsx) — this just sends the already-resolved lead objects.
 * No re-parsing happens server-side. */
export function addLeads(campaignId: string, leads: NewLead[]): Promise<{ inserted: number }> {
  return localApiRequest(`/api/linkedin/campaigns/${encodeURIComponent(campaignId)}/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leads }),
  });
}

export function deleteLead(id: string): Promise<{ ok: true }> {
  return localApiRequest(`/api/linkedin/leads/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface SearchedLead {
  linkedinUrl: string;
  name: string | null;
  title: string | null;
  company: string | null;
}

/** Read-only — a LinkedIn people-search query (free text, or a raw
 * linkedin.com/search/... URL copy-pasted from a manually-filtered
 * search), returning candidate leads for LeadSearchImport.tsx's own
 * review step. Nothing is added to any campaign by this call alone —
 * see addLeads() above for the actual (explicit, reviewed) import. */
export function searchLeads(query: string): Promise<{ results: SearchedLead[] }> {
  return localApiRequest('/api/linkedin/search-leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
}

/** "Skip" from the Pending Approval panel goes through this — it doesn't
 * delete the lead, just marks it 'skipped' so findDueActions() (server
 * side) permanently stops considering it for further sequence steps.
 * Local-data-only, no LinkedIn side effect. */
export function updateLeadStatus(id: string, status: LinkedInLeadStatus): Promise<{ ok: true }> {
  return localApiRequest(`/api/linkedin/leads/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

// The campaign builder graph — replaces the old flat sequence_steps list.
// "Coming soon" types are real, valid values (the frontend palette just
// renders them disabled) so a graph containing one doesn't get silently
// dropped by anything that round-trips it — see server/src/linkedin/db.ts's
// own SequenceNodeType for the authoritative list/reasoning.
export type LinkedInSequenceNodeType =
  | 'connect'
  | 'message'
  | 'withdraw'
  | 'view_profile'
  | 'follow'
  | 'like_post'
  | 'wait'
  | 'end'
  | 'condition_connected'
  | 'condition_replied'
  | 'condition_followed_back'
  | 'condition_profile_visited'
  | 'condition_post_liked'
  | 'condition_custom'
  | 'inmail'
  | 'endorse'
  | 'find_email';

export interface LinkedInSequenceNode {
  id: string;
  campaignId: string;
  type: LinkedInSequenceNodeType;
  messageTemplate: string | null;
  waitDays: number | null;
  posX: number;
  posY: number;
}

export type LinkedInEdgeBranch = 'default' | 'yes' | 'no';

export interface LinkedInSequenceEdge {
  id: string;
  campaignId: string;
  fromNodeId: string | null;
  toNodeId: string;
  branch: LinkedInEdgeBranch;
}

export interface LinkedInCampaignGraph {
  nodes: LinkedInSequenceNode[];
  edges: LinkedInSequenceEdge[];
}

export function fetchGraph(campaignId: string): Promise<LinkedInCampaignGraph> {
  return localApiRequest(`/api/linkedin/campaigns/${encodeURIComponent(campaignId)}/graph`);
}

export interface GraphNodeInput {
  id: string;
  type: LinkedInSequenceNodeType;
  messageTemplate: string | null;
  waitDays: number | null;
  posX: number;
  posY: number;
}

export interface GraphEdgeInput {
  fromNodeId: string | null;
  toNodeId: string;
  branch: LinkedInEdgeBranch;
}

/** Bulk replace, one request — an editor session naturally touches many
 * nodes/edges at once (add a few, rewire a few, drag several into new
 * positions), same reasoning as this app's other bulk-save endpoints
 * (PUT /api/rows). */
export function saveGraph(campaignId: string, nodes: GraphNodeInput[], edges: GraphEdgeInput[]): Promise<{ ok: true }> {
  return localApiRequest(`/api/linkedin/campaigns/${encodeURIComponent(campaignId)}/graph`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, edges }),
  });
}

export interface LinkedInFunnel {
  totalLeads: number;
  sent: number;
  accepted: number;
  replied: number;
  skipped: number;
  acceptRate: number;
  replyRate: number;
}

export interface LinkedInCampaignFunnel extends LinkedInFunnel {
  campaignId: string;
  campaignName: string;
}

export interface LinkedInAnalyticsSummary {
  overall: LinkedInFunnel;
  campaigns: LinkedInCampaignFunnel[];
}

export function fetchAnalytics(): Promise<LinkedInAnalyticsSummary> {
  return localApiRequest('/api/linkedin/analytics');
}

export interface LinkedInStepBreakdown {
  stepId: string;
  type: LinkedInSequenceNodeType;
  waiting: number;
  /** For a 'message' node only: leads positioned right before it but not
   * yet eligible (haven't accepted the connection). See
   * server/src/linkedin/analytics.ts's own doc comment for why this needed
   * splitting out of `waiting`. */
  blocked: number;
  completed: number;
  failing: number;
}

/** Per-step funnel for one campaign — where the plain sent/accepted/
 * replied funnel above can't distinguish "hasn't reached step 2 yet" from
 * "reached it and failed," this can. */
export function fetchCampaignStepBreakdown(campaignId: string): Promise<{ steps: LinkedInStepBreakdown[] }> {
  return localApiRequest(`/api/linkedin/campaigns/${encodeURIComponent(campaignId)}/analytics/steps`);
}

export interface LinkedInDailyActivity {
  date: string;
  connectsSent: number;
  messagesSent: number;
  errors: number;
}

export function fetchDailyActivity(days = 30): Promise<{ days: LinkedInDailyActivity[] }> {
  return localApiRequest(`/api/linkedin/analytics/daily?days=${days}`);
}

export interface LinkedInStaleInvite {
  leadId: string;
  leadUrl: string;
  leadName: string | null;
  campaignId: string;
  campaignName: string;
  sentAt: number;
  daysSince: number;
}

/** Every still-'pending' invite (sent, not yet accepted/replied) at least
 * `days` old, across every campaign — Phase 3's "auto-withdraw stale
 * invites" (TZ_LinkedIn_Automation.md section 3), surfaced here as a
 * review list rather than something that fires on its own; see
 * withdrawStaleInvite() below. */
export function fetchStaleInvites(days = 14): Promise<{ stale: LinkedInStaleInvite[] }> {
  return localApiRequest(`/api/linkedin/stale-invites?days=${days}`);
}

/** Withdraws one pending connection request — a real, unrecoverable side
 * effect against an actual LinkedIn invitation the instant it succeeds.
 * The caller must have already shown a confirm dialog, same rule as every
 * other real-world action in this app. The server re-verifies the lead is
 * still pending right before acting. */
export function withdrawStaleInvite(leadId: string): Promise<{ ok: boolean; error?: string }> {
  return localApiRequest('/api/linkedin/withdraw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leadId }),
  });
}
