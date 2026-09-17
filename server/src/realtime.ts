import type { Response } from 'express';

/** Live table sync — on explicit request ("Super Admin меняет что-то...
 * Worker не видит изменение, пока не обновит страницу"). Broadcasts
 * row/column changes over Server-Sent Events to every currently-open
 * viewer of the SAME table (index.ts's GET /api/tables/:id/events), so a
 * super_admin (whether impersonating a worker via "Prisijungti kaip" or
 * just browsing that company's tables directly) and the real worker
 * logged in separately both see each other's writes within moments,
 * without a manual refresh.
 *
 * SSE, not WebSocket: this app had zero existing real-time infrastructure
 * (confirmed — no `ws` dependency, no socket.io) and the actual need is
 * one-directional (server -> client push; every write already goes
 * through a normal REST call) — SSE needs no new dependency, no HTTP
 * upgrade handling, and the browser's native EventSource already retries
 * a dropped connection on its own, which is exactly the "reconnect
 * automatically" requirement below with zero custom code.
 *
 * Payload is always "which rows/columns changed and their new values,"
 * never the whole table — this module knows nothing about Row/Column
 * shapes (kept `unknown`, same "no independent opinion" pattern
 * tableData/db.ts's own TableMeta already uses), it just relays whatever
 * index.ts's route handlers already computed for their own DB write. */

interface Connection {
  res: Response;
  companyId: string;
  /** The writer's own browser-tab id (utils/clientId.ts on the frontend),
   * sent once as a query param when the EventSource connects — broadcasts
   * skip the connection matching the ORIGINATING write's clientId, so a
   * tab doesn't get its own change echoed back to it as a "remote" patch
   * (harmless if it did — applying an identical value is a no-op — but
   * pointless network traffic and a needless extra render). */
  clientId: string | null;
}

export interface RowsUpsertedEvent {
  type: 'rows_upserted';
  tableId: string;
  rows: unknown[];
}
export interface RowsDeletedEvent {
  type: 'rows_deleted';
  tableId: string;
  rowIds: string[];
}
export interface ColumnsUpdatedEvent {
  type: 'columns_updated';
  tableId: string;
  columns: unknown[];
}
export type RealtimeTableEvent = RowsUpsertedEvent | RowsDeletedEvent | ColumnsUpdatedEvent;

// tableId -> connectionId -> Connection. A table with nobody currently
// watching it has no entry at all (cleaned up on the last unsubscribe),
// so broadcasting to an unwatched table is a single Map miss, not a scan.
const subscribersByTable = new Map<string, Map<string, Connection>>();
let nextConnectionId = 0;

// --- Company-wide channel ---------------------------------------------
// A second, parallel channel alongside the per-table one above — added for
// the Team Activity Dashboard (and reused for live Instantly reply
// notifications), neither of which is scoped to one specific table the
// way row/column edits are. Same SSE/heartbeat/clientId-echo-suppression
// machinery, just keyed by companyId instead of tableId. Deliberately a
// SEPARATE Map/route rather than trying to reuse subscribeToTable with a
// synthetic table id — a dashboard viewer has no specific table to prove
// access to (tableAccessibleToRequest doesn't apply), just "is this user
// authenticated into this company," which every request already
// guarantees.

export interface DashboardMetricsChangedEvent {
  type: 'dashboard_metrics_changed';
}
export interface SmsReceivedEvent {
  type: 'sms_received';
}
export interface InstantlyReplyEvent {
  type: 'instantly_reply';
  /** The lead's raw i_status/lt_interest_status value AS A STRING (JSON has
   * no distinct "number or null" union to lean on, and the numeric value
   * itself is meaningful — see instantlyReplySync.ts's INTEREST_STATUS_LABELS
   * for the client's own copy of what each one means), or the literal JSON
   * `null` for a plain "Lead" (Instantly's own convention: no interest
   * value set at all means Lead, not "unknown"). Always present — a new
   * reply always has SOME status, even if that status is "Lead." */
  interestStatus: string | null;
  leadEmail: string;
}
export interface PlannerTaskChangedEvent {
  type: 'planner_task_changed';
}
export type RealtimeCompanyEvent = DashboardMetricsChangedEvent | InstantlyReplyEvent | SmsReceivedEvent | PlannerTaskChangedEvent;

const subscribersByCompany = new Map<string, Map<string, Connection>>();

export function subscribeToCompany(companyId: string, clientId: string | null, res: Response): () => void {
  const connectionId = String(nextConnectionId++);
  let byConnection = subscribersByCompany.get(companyId);
  if (!byConnection) {
    byConnection = new Map();
    subscribersByCompany.set(companyId, byConnection);
  }
  byConnection.set(connectionId, { res, companyId, clientId });
  return () => {
    const map = subscribersByCompany.get(companyId);
    if (!map) return;
    map.delete(connectionId);
    if (map.size === 0) subscribersByCompany.delete(companyId);
  };
}

export function broadcastToCompany(companyId: string, event: RealtimeCompanyEvent, originClientId: string | null): void {
  const byConnection = subscribersByCompany.get(companyId);
  if (!byConnection) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const conn of byConnection.values()) {
    if (originClientId && conn.clientId === originClientId) continue;
    conn.res.write(payload);
  }
}

/** Registers one open SSE response as a subscriber of `tableId`. Returns
 * the unsubscribe function to call from the route's `req.on('close', ...)`
 * — an SSE connection ends when the browser tab closes, navigates away, or
 * drops the connection (including EventSource's own automatic reconnect,
 * which closes the old connection before opening a fresh one). */
export function subscribeToTable(tableId: string, companyId: string, clientId: string | null, res: Response): () => void {
  const connectionId = String(nextConnectionId++);
  let byConnection = subscribersByTable.get(tableId);
  if (!byConnection) {
    byConnection = new Map();
    subscribersByTable.set(tableId, byConnection);
  }
  byConnection.set(connectionId, { res, companyId, clientId });
  return () => {
    const map = subscribersByTable.get(tableId);
    if (!map) return;
    map.delete(connectionId);
    if (map.size === 0) subscribersByTable.delete(tableId);
  };
}

/** `companyId` is checked again here, not just when subscribing —
 * defense in depth for a multi-tenant app: even though a table id is
 * already company-scoped everywhere else (so this should be unreachable
 * in practice), a broadcast must never be able to leak into another
 * company's connection under any future refactor. */
export function broadcastToTable(tableId: string, companyId: string, event: RealtimeTableEvent, originClientId: string | null): void {
  const byConnection = subscribersByTable.get(tableId);
  if (!byConnection) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const conn of byConnection.values()) {
    if (conn.companyId !== companyId) continue;
    if (originClientId && conn.clientId === originClientId) continue;
    conn.res.write(payload);
  }
}

// Keeps intermediary proxies/load balancers (Render's included) from
// treating a quiet-but-healthy SSE connection as idle and silently
// dropping it — a lone comment line (SSE ignores lines starting with
// `:`) is enough to count as traffic without the client ever seeing it
// as a real event.
const HEARTBEAT_MS = 20000;
setInterval(() => {
  for (const byConnection of subscribersByTable.values()) {
    for (const conn of byConnection.values()) conn.res.write(': ping\n\n');
  }
  for (const byConnection of subscribersByCompany.values()) {
    for (const conn of byConnection.values()) conn.res.write(': ping\n\n');
  }
}, HEARTBEAT_MS);
