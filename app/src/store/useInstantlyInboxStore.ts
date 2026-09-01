import { create } from 'zustand';
import {
  fetchInstantlyEmails,
  fetchInstantlyUnreadCount,
  replyToInstantlyEmail,
  forwardInstantlyEmail,
  markInstantlyThreadRead,
  markInstantlyEmailUnread,
  updateInstantlyLeadInterestStatus,
  type UniboxThreadEmail,
} from '../utils/instantlyApi';

/** One thread = one row in the Unibox list. Instantly's own `thread_id`
 * already groups these server-side (unlike the SMS inbox feature
 * elsewhere in this app, which had to group client-side by phone-number
 * suffix) — this just buckets the flat `items` list by that field and
 * keeps each bucket's messages newest-first. */
export interface UniboxThread {
  threadId: string;
  messages: UniboxThreadEmail[];
  latest: UniboxThreadEmail;
  hasUnread: boolean;
}

/** Mirrors the 5 options in Instantly's own "More" menu (see the
 * reference screenshot this was built from) — "reminders"/"scheduled"
 * pass the matching (confirmed-unreliable, see fetchInstantlyEmails'
 * own doc comment) server query params on a best-effort basis, but
 * "unread"/"sent" are the two this app can also verify/enforce
 * client-side against fields that do come back reliably (is_unread,
 * and isOutgoing() in UniboxPanel.tsx for "sent"). */
export type UniboxViewMode = 'inbox' | 'unread' | 'reminders' | 'scheduled' | 'sent';

// Confirmed live, twice, against the real account: Instantly's own
// /emails/unread/count endpoint can report a nonzero count (e.g. "1")
// while NOT ONE message in /emails — unfiltered, is_unread=true
// filtered, or paginated hundreds deep — actually carries is_unread:
// true. That mismatch was the exact bug reported here: the subnav/
// "Tik neperskaityti" badge kept showing a stale number that clicking
// refresh could never resolve, because there was nothing behind it to
// fetch. countUnread() derives the badge from the SAME thread data the
// list itself renders, so the two can never visibly disagree again —
// the trade-off is this only reflects unread mail within whatever's
// currently loaded/filtered (viewMode/filterMailbox/filterCampaignId),
// not a true account-wide total, which is an acceptable cost for "the
// number always matches what's on screen."
function countUnread(threads: UniboxThread[]): number {
  return threads.filter((t) => t.hasUnread).length;
}

function groupIntoThreads(emails: UniboxThreadEmail[]): UniboxThread[] {
  const byThread = new Map<string, UniboxThreadEmail[]>();
  for (const email of emails) {
    const key = email.thread_id ?? email.id;
    const list = byThread.get(key) ?? [];
    list.push(email);
    byThread.set(key, list);
  }
  const threads: UniboxThread[] = [];
  for (const [threadId, messages] of byThread) {
    const sorted = [...messages].sort((a, b) => b.timestamp_email.localeCompare(a.timestamp_email));
    threads.push({ threadId, messages: sorted, latest: sorted[0], hasUnread: sorted.some((m) => m.is_unread) });
  }
  return threads.sort((a, b) => b.latest.timestamp_email.localeCompare(a.latest.timestamp_email));
}

interface InstantlyInboxState {
  threads: UniboxThread[];
  ready: boolean;
  error: string | null;
  unreadCount: number;
  nextCursor: string | null;
  loadMoreLoading: boolean;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
  refreshUnreadCount: () => Promise<void>;

  // Server-side filters (re-fetch from page 1 when any changes) — a real
  // inbox's most-used filters, modeled on Instantly's own "More" menu
  // (Inbox/Unread only/Reminders only/Scheduled emails/Sent), plus which
  // mailbox and which campaign. Free-text search stays client-side in the
  // panel itself instead (only ever filtering the couple hundred
  // already-loaded threads, same "plain substring filter, no server
  // round trip" pattern the main Table's own search box already uses).
  viewMode: UniboxViewMode;
  setViewMode: (mode: UniboxViewMode) => void;
  filterMailbox: string | null;
  setFilterMailbox: (email: string | null) => void;
  filterCampaignId: string | null;
  setFilterCampaignId: (id: string | null) => void;

  openThreadId: string | null;
  setOpenThreadId: (id: string | null) => void;

  markingThreadIds: Set<string>;
  markThreadRead: (threadId: string) => Promise<void>;
  /** The reverse — "pažymėti kaip neperskaitytą" (on explicit request: "я
   * захочу на его ответить позже, а не сейчас"). Shares markingThreadIds
   * with markThreadRead above (same per-item in-flight-key convention this
   * app already uses everywhere — see CLAUDE.md — one shared key would let
   * clicking one action re-enable a button for a different in-flight one). */
  markThreadUnread: (threadId: string) => Promise<void>;

  sendingReply: boolean;
  replyError: string | null;
  /** Sends a real email to a real prospect the instant it succeeds — no
   * confirmDialog step before this (removed on explicit request; unlike
   * most other real-send actions in this app, this one is deliberately
   * not gated behind a confirm click). html is the rich-text compose
   * body (see UniboxPanel's ComposePanel); additionalRecipients
   * maps to Instantly's own `additional_recipients` field — the API has
   * no way to override a reply's *primary* recipient (it's implicit in
   * reply_to_uuid, always whoever sent the original message), only to
   * cc-style add extra ones on top. */
  sendReply: (params: {
    replyToUuid: string;
    eaccount: string;
    subject: string;
    html: string;
    additionalRecipients?: string[];
  }) => Promise<boolean>;

  sendingForward: boolean;
  forwardError: string | null;
  /** Same real-side-effect caveat as sendReply above. Unlike reply,
   * forward's recipients are fully explicit (to_address_email_list). */
  sendForward: (params: { replyToUuid: string; eaccount: string; to: string[]; subject: string; html: string }) => Promise<boolean>;

  updatingStatusThreadIds: Set<string>;
  /** Sets every message currently loaded for this thread's own local
   * i_status optimistically (the server only tracks this per-lead, but
   * every message in a thread shares one lead, so this always applies to
   * the whole thread at once) — matches the editable status pill at the
   * top of an open conversation in Instantly's own Unibox. */
  updateThreadInterestStatus: (thread: UniboxThread, leadEmail: string, interestValue: number | null) => Promise<boolean>;
}

export const useInstantlyInboxStore = create<InstantlyInboxState>((set, get) => ({
  threads: [],
  ready: false,
  error: null,
  unreadCount: 0,
  nextCursor: null,
  loadMoreLoading: false,

  viewMode: 'inbox',
  setViewMode: (mode) => {
    set({ viewMode: mode });
    void get().refresh();
  },
  filterMailbox: null,
  setFilterMailbox: (email) => {
    set({ filterMailbox: email });
    void get().refresh();
  },
  filterCampaignId: null,
  setFilterCampaignId: (id) => {
    set({ filterCampaignId: id });
    void get().refresh();
  },

  refresh: async () => {
    set({ error: null });
    try {
      const { viewMode, filterMailbox, filterCampaignId } = get();
      const page = await fetchInstantlyEmails({
        limit: 50,
        is_unread: viewMode === 'unread' ? true : undefined,
        has_reminder: viewMode === 'reminders' ? true : undefined,
        scheduled_only: viewMode === 'scheduled' ? true : undefined,
        eaccount: filterMailbox ?? undefined,
        campaign_id: filterCampaignId ?? undefined,
      });
      const threads = groupIntoThreads(page.items);
      set({ threads, nextCursor: page.next_starting_after ?? null, ready: true, unreadCount: countUnread(threads) });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko įkelti pokalbių', ready: true });
    }
  },

  loadMore: async () => {
    const { nextCursor, loadMoreLoading, viewMode, filterMailbox, filterCampaignId } = get();
    if (!nextCursor || loadMoreLoading) return;
    set({ loadMoreLoading: true });
    try {
      const page = await fetchInstantlyEmails({
        limit: 50,
        starting_after: nextCursor,
        is_unread: viewMode === 'unread' ? true : undefined,
        has_reminder: viewMode === 'reminders' ? true : undefined,
        scheduled_only: viewMode === 'scheduled' ? true : undefined,
        eaccount: filterMailbox ?? undefined,
        campaign_id: filterCampaignId ?? undefined,
      });
      // Re-group from scratch over the combined flat list rather than
      // merging thread buckets — a message could belong to a thread whose
      // other messages are still on the not-yet-loaded next page,
      // otherwise producing duplicate thread rows for the same
      // conversation as more pages load.
      const allSoFar = [...get().threads.flatMap((t) => t.messages), ...page.items];
      const threads = groupIntoThreads(allSoFar);
      set({ threads, nextCursor: page.next_starting_after ?? null, unreadCount: countUnread(threads) });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko įkelti daugiau pokalbių' });
    } finally {
      set({ loadMoreLoading: false });
    }
  },

  // A best-effort PEEK only — for showing a rough "you might have new
  // mail" hint on the subnav badge before Unibox has ever loaded any
  // thread data in this session (from InstantlyView.tsx's own mount
  // effect, and its header refresh button while on Analitika/Pašto
  // dėžutės, where there's no thread list to derive a real count from
  // instead). Deliberately NOT called from refresh()/loadMore()/
  // markThreadRead()/markThreadUnread() above anymore — see countUnread's
  // own doc comment for why trusting this endpoint once real thread data
  // exists caused a real, reported bug (the badge and the visible list
  // silently disagreeing, with no way for a refresh click to reconcile
  // them since this endpoint's own number wasn't backed by anything the
  // list endpoint would ever actually return).
  refreshUnreadCount: async () => {
    try {
      const { count } = await fetchInstantlyUnreadCount();
      set({ unreadCount: count });
    } catch {
      // Non-critical — the badge just stays at its last known value.
    }
  },

  openThreadId: null,
  setOpenThreadId: (id) => set({ openThreadId: id }),

  markingThreadIds: new Set(),
  markThreadRead: async (threadId) => {
    set((s) => ({ markingThreadIds: new Set(s.markingThreadIds).add(threadId) }));
    try {
      await markInstantlyThreadRead(threadId);
      set((s) => {
        const threads = s.threads.map((t) =>
          t.threadId === threadId ? { ...t, hasUnread: false, messages: t.messages.map((m) => ({ ...m, is_unread: false })) } : t,
        );
        return { threads, unreadCount: countUnread(threads) };
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko pažymėti kaip perskaityto' });
    } finally {
      set((s) => {
        const next = new Set(s.markingThreadIds);
        next.delete(threadId);
        return { markingThreadIds: next };
      });
    }
  },

  markThreadUnread: async (threadId) => {
    set((s) => ({ markingThreadIds: new Set(s.markingThreadIds).add(threadId) }));
    try {
      const thread = get().threads.find((t) => t.threadId === threadId);
      if (!thread) return;
      // Instantly has no thread-level "mark unread" (see
      // markInstantlyEmailUnread's own doc comment) — flipping the
      // thread's own *latest* message is what actually makes
      // groupIntoThreads' `messages.some(m => m.is_unread)` compute
      // hasUnread: true again for the whole thread.
      await markInstantlyEmailUnread(thread.latest.id);
      set((s) => {
        const threads = s.threads.map((t) =>
          t.threadId === threadId
            ? { ...t, hasUnread: true, messages: t.messages.map((m) => (m.id === t.latest.id ? { ...m, is_unread: true } : m)) }
            : t,
        );
        return { threads, unreadCount: countUnread(threads) };
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko pažymėti kaip neperskaityto' });
    } finally {
      set((s) => {
        const next = new Set(s.markingThreadIds);
        next.delete(threadId);
        return { markingThreadIds: next };
      });
    }
  },

  sendingReply: false,
  replyError: null,
  sendReply: async ({ replyToUuid, eaccount, subject, html, additionalRecipients }) => {
    set({ sendingReply: true, replyError: null });
    try {
      await replyToInstantlyEmail({
        reply_to_uuid: replyToUuid,
        eaccount,
        subject,
        body: { html },
        additional_recipients: additionalRecipients?.length ? additionalRecipients : undefined,
      });
      await get().refresh();
      return true;
    } catch (err) {
      set({ replyError: err instanceof Error ? err.message : 'Nepavyko išsiųsti atsakymo' });
      return false;
    } finally {
      set({ sendingReply: false });
    }
  },

  sendingForward: false,
  forwardError: null,
  sendForward: async ({ replyToUuid, eaccount, to, subject, html }) => {
    set({ sendingForward: true, forwardError: null });
    try {
      await forwardInstantlyEmail({
        reply_to_uuid: replyToUuid,
        eaccount,
        to_address_email_list: to.join(','),
        subject,
        body: { html },
      });
      await get().refresh();
      return true;
    } catch (err) {
      set({ forwardError: err instanceof Error ? err.message : 'Nepavyko persiųsti laiško' });
      return false;
    } finally {
      set({ sendingForward: false });
    }
  },

  updatingStatusThreadIds: new Set(),
  updateThreadInterestStatus: async (thread, leadEmail, interestValue) => {
    set((s) => ({ updatingStatusThreadIds: new Set(s.updatingStatusThreadIds).add(thread.threadId) }));
    try {
      await updateInstantlyLeadInterestStatus({ leadEmail, interestValue, campaignId: thread.latest.campaign_id ?? undefined });
      set((s) => ({
        threads: s.threads.map((t) =>
          t.threadId === thread.threadId
            ? { ...t, messages: t.messages.map((m) => ({ ...m, i_status: interestValue })), latest: { ...t.latest, i_status: interestValue } }
            : t,
        ),
      }));
      return true;
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko atnaujinti statuso' });
      return false;
    } finally {
      set((s) => {
        const next = new Set(s.updatingStatusThreadIds);
        next.delete(thread.threadId);
        return { updatingStatusThreadIds: next };
      });
    }
  },
}));
