import { useEffect } from 'react';
import { LOCAL_API_BASE } from './localApi';
import { getAuthToken } from './authToken';
import { getClientId } from './clientId';
import { DEMO_MODE } from './demoMode';
import { playReminderSound } from './notificationSound';
import { useDashboardStore } from '../store/useDashboardStore';
import { useInstantlyInboxStore } from '../store/useInstantlyInboxStore';
import { useAuthStore } from '../store/useAuthStore';
import { can } from './permissions';
import { useToastStore } from '../store/useToastStore';
import { publishCompanyEvent } from './companyEventBus';

/** Company-wide sibling of tableRealtime.ts's per-table sync — same SSE/
 * EventSource transport (see server/src/realtime.ts's own doc comment for
 * why SSE over WebSocket/polling), just subscribed to GET /api/company/
 * events instead of a specific table's stream. Two independent things ride
 * this one connection today:
 *
 * 1. Team Activity Dashboard — a `dashboard_metrics_changed` event means
 *    "some worker's action in this company may have moved the numbers";
 *    the dashboard just silently reloads (cheap, day-bounded queries), so
 *    an open dashboard reflects a colleague's note/contact/LinkedIn send
 *    within moments, not just after a manual refresh.
 * 2. Live Instantly replies — an `instantly_reply` event fires the instant
 *    the server's webhook sync creates a new "Visi atsakymai" row for a
 *    genuinely new reply (never for a duplicate). If the Unibox has been
 *    opened at least once this session (`ready`), it silently refetches so
 *    the new reply appears without a page reload. If the reply's interest
 *    status is one of Lead/Interested/"Not this person" (Instantly's own
 *    closest equivalent is "Wrong person", -2 — see NOTIFY_INTEREST_STATUSES),
 *    the exact same two-tone ding the reminder feature already uses plays,
 *    on explicit request ("такой же звук... для инстантли уведомлений").
 *
 * No catch-up/replay mechanism for missed events while disconnected — deliberately,
 * unlike tableRealtime.ts's `rows/since` mechanism: a missed live reply
 * notification is discovered the next time the Unibox is actually opened
 * (its own mount-time fetch), it's just not RETROACTIVELY announced with a
 * sound after the fact — announcing something "3 hours ago" with an
 * attention-grabbing ding the moment a tab reconnects would be worse than
 * simply not ringing for it. */

// Instantly's own numeric interest-status values (see server/src/
// instantlyReplySync.ts's INTEREST_STATUS_LABELS — duplicated client-side
// the same way every other app/server boundary constant in this codebase
// is), serialized as their JSON form (null stays null, everything else a
// string) to match what the server actually broadcasts. "Not this person"
// per the account owner's own wording maps to Instantly's closest real
// status, "Wrong person" (-2) — there is no literal "Not this person"
// value in Instantly's own enum.
const NOTIFY_INTEREST_STATUSES = new Set<string | null>([null, '1', '-2']);

interface CompanyEventPayload {
  type: string;
  interestStatus?: string | null;
  leadEmail?: string;
  [key: string]: unknown;
}

export function useCompanyRealtimeSync(): void {
  useEffect(() => {
    if (DEMO_MODE) return;
    const token = getAuthToken();
    if (!token) return;

    const url = `${LOCAL_API_BASE}/api/company/events?token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(getClientId())}`;
    const es = new EventSource(url);

    es.onmessage = (event) => {
      if (!event.data) return;
      let payload: CompanyEventPayload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      // Every event also lands on the shared bus, for any feature whose
      // state lives outside a globally-reachable store (e.g. SmsInboxView's
      // own local useState) — see companyEventBus.ts's own doc comment.
      publishCompanyEvent(payload);

      if (payload.type === 'dashboard_metrics_changed') {
        if (useDashboardStore.getState().ready) void useDashboardStore.getState().load();
        return;
      }

      if (payload.type === 'instantly_reply') {
        const inbox = useInstantlyInboxStore.getState();
        if (inbox.ready) {
          void inbox.refresh();
          void inbox.refreshUnreadCount();
          void inbox.refreshInterestedUnreadCount();
        }
        const user = useAuthStore.getState().user;
        const canHearIt = can(user?.permissionKeys, 'integrations.instantly.use');
        if (canHearIt && NOTIFY_INTEREST_STATUSES.has(payload.interestStatus ?? null)) {
          playReminderSound();
          useToastStore.getState().show(payload.leadEmail ? `Naujas atsakymas: ${payload.leadEmail}` : 'Naujas atsakymas gautas');
        }
      }
    };

    es.onerror = () => {};

    return () => {
      es.close();
    };
  }, []);
}
