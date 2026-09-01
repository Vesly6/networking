import { randomUUID } from './uuid';
import type { Column, Row, TableMeta } from '../types';
import { getTable, saveTable, updateTableColumns, loadRowsForTable, saveRows } from '../db/db';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { fetchInstantlyEmails, fetchInstantlyLeads, fetchInstantlyCampaign, INTEREST_STATUS_LABELS, type InstantlyLead } from './instantlyApi';

/** Pulls every *reply* (inbound email, not our own send) for a campaign
 * out of Instantly's Unibox and lands each one as a row in a named CRM
 * table — on explicit request ("чтобы все ответы из instantly падали бы
 * в мне нужную табель"), with the exact column set the user asked for.
 * Manually triggered (a button, not a background job) for now — the
 * request itself scoped this to "for testing, one campaign first," so
 * this doesn't try to be a continuously-running sync yet; re-running it
 * (same or a different campaign) is safe and additive, see the dedup
 * note below. */
// Shared with TableView.tsx (the "is this literally the Visi atsakymai
// table" check that gates the reply-push toolbar button) and
// PushReplyRowsModal.tsx. The server has its own duplicate of this same
// literal (server/src/instantlyReplySync.ts) — no shared module boundary
// between app/ and server/ in this codebase, same duplication pattern
// already used for REPLY_COLUMNS itself.
export const VISI_ATSAKYMAI_TABLE_NAME = 'Visi atsakymai';

export const REPLY_COLUMNS = [
  'reply_snippet',
  'lead_email',
  'first_name',
  'company_name',
  'lead_status',
  'campaign_name',
  'reply_text',
  'sender_email',
  'received_at',
  'reply_subject',
] as const;

const PAGE_SIZE = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Instantly caps this account at 20 requests/minute — confirmed live, hit
// mid-sync on a real campaign ("Rate limit exceeded. Maximum 20 requests
// per minute allowed."), which aborted the whole sync partway through.
// REQUEST_GAP_MS (3.5s ≈ 17/min) paces every paginated call proactively
// rather than relying purely on reacting to the error, since other parts
// of this app (Unibox/Analytics refreshing on their own) already draw
// from the same account-wide budget. withRateLimitRetry is the reactive
// backstop for whenever that still isn't enough — one real, generous wait
// (25s, comfortably past the 60s window resetting) and a single retry,
// not an unbounded loop.
const REQUEST_GAP_MS = 3500;
const RATE_LIMIT_WAIT_MS = 25000;

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/rate limit/i.test(message)) throw err;
    await sleep(RATE_LIMIT_WAIT_MS);
    return fn();
  }
}

/** A reply's own from-address, cross-referenced against the campaign's
 * lead list for first_name/company_name/lead_status — the Unibox email
 * object itself doesn't carry those directly (only i_status, which is
 * ALSO used as a lead_status fallback when the lead lookup itself comes
 * up empty, e.g. a reply from someone not in this campaign's own lead
 * list for whatever reason). Keyed lowercase — email casing isn't
 * guaranteed consistent between the two endpoints. */
async function buildLeadIndex(campaignId: string): Promise<Map<string, InstantlyLead>> {
  const map = new Map<string, InstantlyLead>();
  let cursor: string | undefined;
  let first = true;
  for (;;) {
    if (!first) await sleep(REQUEST_GAP_MS);
    first = false;
    const page = await withRateLimitRetry(() => fetchInstantlyLeads({ campaign: campaignId, limit: PAGE_SIZE, starting_after: cursor }));
    for (const lead of page.items) map.set(lead.email.toLowerCase(), lead);
    if (!page.next_starting_after) break;
    cursor = page.next_starting_after;
  }
  return map;
}

function stripHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').trim();
}

function statusLabel(iStatus: number | null): string {
  return INTEREST_STATUS_LABELS[iStatus === null ? 'null' : String(iStatus)] ?? INTEREST_STATUS_LABELS.null;
}

/** Finds "Visi atsakymai" (or whatever name is passed) among the
 * workspace's existing tables, or creates it fresh with exactly
 * REPLY_COLUMNS — deliberately NOT the usual 1000-row/50-column default
 * seed every other new table gets (see useWorkspaceStore.ts), since this
 * table's schema is fully prescribed by the caller, not a blank slate to
 * paste into.
 *
 * A real, reported bug: an *existing* table with this exact name (the
 * user had already created one by hand, via the normal "+ Nauja lentelė"
 * flow, before this sync ever ran — so it had the generic 50-column
 * default seed, not REPLY_COLUMNS) was found and reused as-is, and the
 * write step below silently wrote into `cells[undefined]` for every
 * column it couldn't find by name. Fixed by checking the found table for
 * every name in REPLY_COLUMNS and adding whichever are missing (a
 * read-modify-write on its columns, same pattern updateTableColumns'
 * every other caller already uses) — never assumes an existing table
 * already has the right shape. */
async function findOrCreateTargetTable(name: string): Promise<TableMeta> {
  const existing = useWorkspaceStore.getState().tables.find((t) => t.name === name);
  if (existing) {
    const fresh = (await getTable(existing.id)) ?? existing;
    const existingNames = new Set(fresh.columns.map((c) => c.name));
    const missing = REPLY_COLUMNS.filter((n) => !existingNames.has(n));
    if (missing.length === 0) return fresh;
    const columns = [...fresh.columns, ...missing.map((n) => ({ id: randomUUID(), name: n, type: 'text' as const }))];
    await updateTableColumns(fresh.id, columns);
    return { ...fresh, columns };
  }

  const now = Date.now();
  const columns: Column[] = REPLY_COLUMNS.map((id) => ({ id: randomUUID(), name: id, type: 'text' }));
  // Appended at the end of the ungrouped tables, same convention every
  // other table-creation path uses (see useWorkspaceStore.ts).
  const order = Math.max(-1, ...useWorkspaceStore.getState().tables.map((t) => t.order)) + 1;
  const table: TableMeta = { id: randomUUID(), name, columns, order, createdAt: now, updatedAt: now };
  await saveTable(table);
  useWorkspaceStore.setState((s) => ({ tables: [...s.tables, table] }));
  return table;
}

export interface ReplySyncResult {
  campaignName: string;
  repliesFound: number;
  created: number;
  skippedDuplicate: number;
  tableId: string;
  tableName: string;
}

/** `campaignId` is required — this pulls one campaign at a time by
 * design (matches the explicit "for testing, this one campaign" scope);
 * looping it over every campaign is a follow-up, not built here. */
export async function syncInstantlyRepliesToTable(campaignId: string, targetTableName: string): Promise<ReplySyncResult> {
  const campaign = await withRateLimitRetry(() => fetchInstantlyCampaign(campaignId));
  await sleep(REQUEST_GAP_MS);
  const leadIndex = await buildLeadIndex(campaignId);

  const replies: Awaited<ReturnType<typeof fetchInstantlyEmails>>['items'] = [];
  let cursor: string | undefined;
  let first = true;
  for (;;) {
    if (!first) await sleep(REQUEST_GAP_MS);
    first = false;
    const page = await withRateLimitRetry(() => fetchInstantlyEmails({ campaign_id: campaignId, limit: PAGE_SIZE, starting_after: cursor }));
    for (const email of page.items) {
      // A reply is anything NOT sent by one of our own connected mailboxes
      // — same isOutgoing() logic UniboxPanel.tsx already established
      // (from_address_email === eaccount means it's ours).
      if (email.from_address_email !== email.eaccount) replies.push(email);
    }
    if (!page.next_starting_after) break;
    cursor = page.next_starting_after;
  }

  const table = await findOrCreateTargetTable(targetTableName);
  const existingRows = await loadRowsForTable(table.id);
  // Dedup key: lead_email + received_at (to the second) — the closest
  // thing to a stable natural key available from the mapped columns
  // alone, so re-running this sync (the same campaign, or after new
  // replies have come in) never creates duplicate rows for a reply
  // already pulled in earlier.
  const colByName = new Map(table.columns.map((c) => [c.name, c.id]));
  const leadEmailColId = colByName.get('lead_email')!;
  const receivedAtColId = colByName.get('received_at')!;
  const existingKeys = new Set(existingRows.map((r) => `${r.cells[leadEmailColId] ?? ''}|${r.cells[receivedAtColId] ?? ''}`));

  const now = Date.now();
  const newRows: Row[] = [];
  for (const email of replies) {
    const key = `${email.from_address_email}|${email.timestamp_email}`;
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    const lead = leadIndex.get(email.from_address_email.toLowerCase());
    const cells: Record<string, string> = {};
    cells[colByName.get('reply_snippet')!] = email.content_preview ?? '';
    cells[colByName.get('lead_email')!] = email.from_address_email;
    cells[colByName.get('first_name')!] = lead?.first_name ?? '';
    cells[colByName.get('company_name')!] = lead?.company_name ?? '';
    cells[colByName.get('lead_status')!] = statusLabel(lead?.lt_interest_status ?? email.i_status ?? null);
    cells[colByName.get('campaign_name')!] = campaign.name;
    cells[colByName.get('reply_text')!] = email.body?.text || (email.body?.html ? stripHtml(email.body.html) : '') || email.content_preview || '';
    cells[colByName.get('sender_email')!] = email.from_address_email;
    cells[colByName.get('received_at')!] = email.timestamp_email;
    cells[colByName.get('reply_subject')!] = email.subject ?? '';

    newRows.push({
      id: randomUUID(),
      tableId: table.id,
      cells,
      order: existingRows.length + newRows.length,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (newRows.length > 0) await saveRows(newRows);

  return {
    campaignName: campaign.name,
    repliesFound: replies.length,
    created: newRows.length,
    skippedDuplicate: replies.length - newRows.length,
    tableId: table.id,
    tableName: table.name,
  };
}
