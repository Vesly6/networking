import { randomUUID } from 'node:crypto';
import { getCampaign, listEmails, listLeads, type InstantlyLead } from './instantly.js';
import { loadTables, getTable, saveTable, updateTableColumns, loadRowsForTable, saveRows, type TableMeta, type Row } from './tableData/db.js';

/** Server-side port of app/src/utils/instantlyReplySync.ts, for the
 * automatic webhook path (server/src/index.ts's POST /api/instantly/webhook)
 * — see that route's own doc comment for why this had to move server-side
 * at all (has to work whether or not a browser tab is open). Same
 * algorithm, same REPLY_COLUMNS, same dedup key, same rate-limit pacing;
 * only the storage layer differs (company-scoped tableData/db.ts functions
 * instead of the client's IndexedDB-backed db/db.ts, no useWorkspaceStore).
 * The client-side manual button (UniboxPanel.tsx's "Eksportuoti atsakymus į
 * lentelę") is untouched and keeps working exactly as before — both paths
 * write into the same table by name, so either one's dedup covers rows the
 * other already added. */

// Shared with server/src/index.ts (the webhook path and, now, the
// auto-create-on-API-key-save hook) so the literal exists in exactly one
// place server-side. The client has its own duplicate of this same
// literal (app/src/utils/instantlyReplySync.ts) — no shared module
// boundary between app/ and server/ in this codebase, same duplication
// pattern already used for REPLY_COLUMNS/INTEREST_STATUS_LABELS.
export const VISI_ATSAKYMAI_TABLE_NAME = 'Visi atsakymai';

const REPLY_COLUMNS = [
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

// Same 20-req/min Instantly cap and pacing this app's own client-side
// version already established for real (see its own doc comment) — this
// server-side path draws from the identical account-wide budget, so it
// paces itself the same way rather than assuming it has the limit to
// itself.
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

// Local copy of app/src/utils/instantlyApi.ts's INTEREST_STATUS_LABELS —
// app/ and server/ are separate TS projects with no shared module boundary
// in this codebase, so small lookup tables used on both sides are
// duplicated rather than cross-imported (same as every other server/app
// split here).
const INTEREST_STATUS_LABELS: Record<string, string> = {
  null: 'Lead',
  '0': 'Out of office',
  '1': 'Interested',
  '2': 'Meeting booked',
  '3': 'Meeting completed',
  '4': 'Won',
  '-1': 'Not interested',
  '-2': 'Wrong person',
  '-3': 'Lost',
  '-4': 'No show',
};

function statusLabel(iStatus: number | null): string {
  return INTEREST_STATUS_LABELS[iStatus === null ? 'null' : String(iStatus)] ?? INTEREST_STATUS_LABELS.null;
}

// No DOM here (unlike the client version's document.createElement) — a
// plain regex strip is good enough for a reply body/preview field.
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function buildLeadIndex(campaignId: string, apiKey: string): Promise<Map<string, InstantlyLead>> {
  const map = new Map<string, InstantlyLead>();
  let cursor: string | undefined;
  let first = true;
  for (;;) {
    if (!first) await sleep(REQUEST_GAP_MS);
    first = false;
    const page = await withRateLimitRetry(() => listLeads({ campaign: campaignId, limit: PAGE_SIZE, starting_after: cursor }, apiKey));
    for (const lead of page.items) map.set(lead.email.toLowerCase(), lead);
    if (!page.next_starting_after) break;
    cursor = page.next_starting_after;
  }
  return map;
}

interface SyncColumn {
  id: string;
  name: string;
  type: string;
}

/** Finds "Visi atsakymai" (or whatever name is passed) among the company's
 * existing tables, or creates it fresh with exactly REPLY_COLUMNS — same
 * "don't assume an existing same-named table already has the right shape"
 * fix the client version's own doc comment describes (a table created by
 * hand via the normal "+ Nauja lentelė" flow before this ever ran would
 * have the generic seed columns, not REPLY_COLUMNS). */
function findOrCreateTargetTable(companyId: string, name: string): TableMeta {
  const existing = loadTables(companyId).find((t) => t.name === name);
  if (existing) {
    const fresh = getTable(existing.id, companyId) ?? existing;
    const columns = fresh.columns as SyncColumn[];
    const existingNames = new Set(columns.map((c) => c.name));
    const missing = REPLY_COLUMNS.filter((n) => !existingNames.has(n));
    if (missing.length === 0) return fresh;
    const nextColumns = [...columns, ...missing.map((n) => ({ id: randomUUID(), name: n, type: 'text' }))];
    updateTableColumns(fresh.id, nextColumns, companyId);
    return { ...fresh, columns: nextColumns };
  }

  const now = Date.now();
  const columns: SyncColumn[] = REPLY_COLUMNS.map((id) => ({ id: randomUUID(), name: id, type: 'text' }));
  // Appended at the end of the company's ungrouped tables, same convention
  // as every other table-creation path (see tableData/db.ts's
  // restoreBackupAsNewTable for the identical query).
  const nextOrder = loadTables(companyId).reduce((max, t) => Math.max(max, t.order), -1) + 1;
  const table: TableMeta = { id: randomUUID(), name, columns, dailyBackupEnabled: false, order: nextOrder, createdAt: now, updatedAt: now };
  saveTable(table, companyId);
  return table;
}

/** Called right after a company's Instantly API key is first saved (see
 * index.ts's PATCH /api/admin/companies/:id/integrations), so "Visi
 * atsakymai" exists immediately rather than waiting on the first real
 * webhook reply to lazily create it via findOrCreateTargetTable above. */
export function ensureVisiAtsakymaiTable(companyId: string): void {
  findOrCreateTargetTable(companyId, VISI_ATSAKYMAI_TABLE_NAME);
}

export interface ReplySyncResult {
  campaignName: string;
  repliesFound: number;
  created: number;
  skippedDuplicate: number;
  tableId: string;
  tableName: string;
}

/** `campaignId` is required — one campaign at a time, same as the client
 * version and the webhook route above (each event names its own
 * campaign_id). */
export async function syncInstantlyCampaignReplies(
  companyId: string,
  apiKey: string,
  campaignId: string,
  targetTableName: string,
): Promise<ReplySyncResult> {
  const campaign = await withRateLimitRetry(() => getCampaign(campaignId, apiKey));
  await sleep(REQUEST_GAP_MS);
  const leadIndex = await buildLeadIndex(campaignId, apiKey);

  const replies: Awaited<ReturnType<typeof listEmails>>['items'] = [];
  let cursor: string | undefined;
  let first = true;
  for (;;) {
    if (!first) await sleep(REQUEST_GAP_MS);
    first = false;
    const page = await withRateLimitRetry(() => listEmails({ campaign_id: campaignId, limit: PAGE_SIZE, starting_after: cursor }, apiKey));
    for (const email of page.items) {
      if (email.from_address_email !== email.eaccount) replies.push(email);
    }
    if (!page.next_starting_after) break;
    cursor = page.next_starting_after;
  }

  const table = findOrCreateTargetTable(companyId, targetTableName);
  const existingRows = loadRowsForTable(table.id, companyId);
  const columns = table.columns as SyncColumn[];
  const colByName = new Map(columns.map((c) => [c.name, c.id]));
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
    // A real, reported bug: this used to duplicate lead_email
    // (email.from_address_email again) — sender_email is meant to be
    // *our* mailbox this thread is attached to, which is email.eaccount
    // (see InstantlyEmail's own doc comment, and the from_address_email
    // !== eaccount filter above that already relies on this exact
    // distinction to find genuine inbound replies in the first place).
    cells[colByName.get('sender_email')!] = email.eaccount;
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

  if (newRows.length > 0) saveRows(newRows, companyId);

  return {
    campaignName: campaign.name,
    repliesFound: replies.length,
    created: newRows.length,
    skippedDuplicate: replies.length - newRows.length,
    tableId: table.id,
    tableName: table.name,
  };
}
