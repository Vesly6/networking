import { useEffect } from 'react';
import type { Column, Row } from '../types';
import { useTableStore } from '../store/useTableStore';
import { LOCAL_API_BASE } from './localApi';
import { getAuthToken } from './authToken';
import { getClientId } from './clientId';
import { DEMO_MODE } from './demoMode';

/** Real-time sync between everyone currently looking at the SAME table —
 * on explicit request ("Super Admin меняет что-то... Worker не видит
 * изменение, пока не обновит страницу"). Concretely: a company's
 * super_admin (whether impersonating a worker via "Prisijungti kaip" or
 * browsing the company's tables directly) and a worker logged in
 * separately can both have the exact same `tableId` open at once — that
 * shared id is the only thing that has to match for this to work; role/
 * impersonation is irrelevant to the sync itself, only to which tables a
 * given session is *allowed* to open in the first place (unchanged,
 * still enforced by the existing tableAccessibleToRequest check, which
 * this feature's SSE route also runs before allowing a subscription).
 *
 * Transport is Server-Sent Events via the browser's native EventSource,
 * not WebSocket or polling — see server/src/realtime.ts's own doc
 * comment for why. EventSource already retries a dropped connection on
 * its own (the "reconnect automatically" requirement needs zero code
 * here), and its `onopen` fires on every such reconnect, which is used
 * below to close the one real gap SSE doesn't handle by itself: catching
 * up on whatever changed while disconnected, via one small `rows/since`
 * query instead of a full table reload.
 *
 * What's deliberately NOT done here: no client-side "resolve this
 * conflict" logic. Writes stay plain last-write-wins at the row level —
 * whichever PUT reaches the server last is what's actually stored — and
 * this hook's job is only to keep every open viewer's local `rows` in
 * sync with that as fast as possible. In practice this makes same-row-
 * different-cell edits behave like a real per-cell merge anyway: by the
 * time a local user commits their own edit, useTableStore.updateCell
 * builds the new cells object from whatever's currently in the store —
 * which, thanks to this hook applying remote patches within milliseconds,
 * almost always already includes the other person's concurrent change to
 * a DIFFERENT cell in that same row, carrying it forward instead of
 * clobbering it. Only a true same-cell, same-instant edit hits the actual
 * last-write-wins edge case, and even then nothing is silently lost — the
 * losing side simply sees the winning value on their own next patch,
 * exactly like reloading would have shown them, just without reloading. */
export function useTableRealtimeSync(tableId: string | null): void {
  const applyRemoteRowsUpserted = useTableStore((s) => s.applyRemoteRowsUpserted);
  const applyRemoteRowsDeleted = useTableStore((s) => s.applyRemoteRowsDeleted);
  const applyRemoteColumnsUpdated = useTableStore((s) => s.applyRemoteColumnsUpdated);

  useEffect(() => {
    // DEMO_MODE has no server at all (see utils/demoMode.ts) — nothing to
    // connect to, and every write already happens purely client-side.
    if (DEMO_MODE || !tableId) return;
    const token = getAuthToken();
    if (!token) return;

    let stopped = false;
    // Seeded from whatever's already loaded for this table right now
    // (loadTable() has already resolved by the time this effect can run,
    // since the caller only ever passes a real tableId once the store's
    // own `ready`/`tableId` confirm it) — never re-fetches the whole
    // table, only ever asks for rows newer than the newest one already
    // applied.
    let sinceTs = 0;
    for (const row of useTableStore.getState().rows) {
      if (row.updatedAt > sinceTs) sinceTs = row.updatedAt;
    }

    const fetchMissed = async () => {
      try {
        const res = await fetch(`${LOCAL_API_BASE}/api/tables/${encodeURIComponent(tableId)}/rows/since?since=${sinceTs}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok || stopped) return;
        const body = (await res.json()) as { rows: Row[] };
        if (body.rows.length === 0) return;
        applyRemoteRowsUpserted(tableId, body.rows);
        for (const row of body.rows) if (row.updatedAt > sinceTs) sinceTs = row.updatedAt;
      } catch {
        // Not fatal — the next reconnect's onopen tries again, and any
        // live event in the meantime still carries the true current value
        // for whatever row it names.
      }
    };

    const url = `${LOCAL_API_BASE}/api/tables/${encodeURIComponent(tableId)}/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(getClientId())}`;
    const es = new EventSource(url);

    // Fires on the very first connect AND on every automatic reconnect —
    // exactly the two moments "did I miss anything" needs checking.
    es.onopen = () => {
      void fetchMissed();
    };

    es.onmessage = (event) => {
      if (!event.data) return;
      let payload: { type: string; tableId: string; rows?: Row[]; rowIds?: string[]; columns?: Column[] };
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (payload.tableId !== tableId) return;
      if (payload.type === 'rows_upserted' && payload.rows) {
        applyRemoteRowsUpserted(tableId, payload.rows);
        for (const row of payload.rows) if (row.updatedAt > sinceTs) sinceTs = row.updatedAt;
      } else if (payload.type === 'rows_deleted' && payload.rowIds) {
        applyRemoteRowsDeleted(tableId, payload.rowIds);
      } else if (payload.type === 'columns_updated' && payload.columns) {
        applyRemoteColumnsUpdated(tableId, payload.columns);
      }
    };

    // EventSource already retries the same URL on its own on any error
    // (network drop, a transient 5xx) — nothing else to do here.
    es.onerror = () => {};

    return () => {
      stopped = true;
      es.close();
    };
  }, [tableId, applyRemoteRowsUpserted, applyRemoteRowsDeleted, applyRemoteColumnsUpdated]);
}
