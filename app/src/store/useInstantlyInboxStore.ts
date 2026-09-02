import { create } from 'zustand';
import {
  fetchInstantlyEmails,
  replyToInstantlyEmail,
  forwardInstantlyEmail,
  markInstantlyThreadRead,
  markInstantlyEmailUnread,
  updateInstantlyLeadInterestStatus,
  isOutgoingInstantlyEmail,
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

/** Originally mirrored all 5 options in Instantly's own "More" menu
 * (Inbox/Unread only/Reminders only/Scheduled emails/Sent); "reminders"
 * and "sent" were dropped on explicit request — not needed day to day,
 * and each click into either was one more avoidable request against the
 * account's shared 20 req/min Instantly budget (a real, current concern —
 * see index.ts's instantlyWebhookState doc comment for the contention
 * incident that made this budget worth protecting more carefully). Sent
 * mail itself is untouched — a thread's own outgoing messages still show
 * inline for context wherever a thread is open, this only removes the
 * dedicated "just show me what I sent" filter and its own fetch. */
export type UniboxViewMode = 'inbox' | 'unread' | 'scheduled';

// A thread only counts as "unread" if it has an unread *incoming*
// message — a message we sent ourselves can apparently also carry
// is_unread: true in Instantly's data (confirmed live: purely-outbound
// threads with zero replies were showing up as unread), which isn't a
// meaningful "you have something to read" signal for a cold-outreach
// tool. isOutgoingInstantlyEmail is the same from_address_email===
// eaccount check this app already uses server-side (instantlyReplySync.ts)
// to tell a genuine inbound reply apart from our own sent mail.
function hasUnreadIncoming(messages: UniboxThreadEmail[]): boolean {
  return messages.some((m) => m.is_unread && !isOutgoingInstantlyEmail(m));
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
    threads.push({ threadId, messages: sorted, latest: sorted[0], hasUnread: hasUnreadIncoming(sorted) });
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

  /** The green "Paštas" nav-tab badge (App.tsx) — how many *unread*
   * threads currently have i_status === 1 ("Interested"), account-wide,
   * regardless of whatever viewMode/filters Unibox itself happens to be
   * showing right now (unlike `unreadCount` above, which is deliberately
   * scoped to just the currently-loaded/filtered thread list). Paginates
   * through every is_unread:true page itself and derives the count from
   * that real data — same "never trust a separate count endpoint" lesson
   * as refreshUnreadCount's own doc comment above (the real,
   * reported /emails/unread/count mismatch bug), just applied to a fresh,
   * dedicated fetch instead of one already sitting in `threads`. */
  interestedUnreadCount: number;
  refreshInterestedUnreadCount: () => Promise<void>;

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
        scheduled_only: viewMode === 'scheduled' ? true : undefined,
        eaccount: filterMailbox ?? undefined,
        campaign_id: filterCampaignId ?? undefined,
      });
      const threads = groupIntoThreads(page.items);
      set({ threads, nextCursor: page.next_starting_after ?? null, ready: true });
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
      set({ threads, nextCursor: page.next_starting_after ?? null });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko įkelti daugiau pokalbių' });
    } finally {
      set({ loadMoreLoading: false });
    }
  },

  // The subnav "Unibox {unreadCount}" badge's one source of truth — a
  // real, reported bug (twice over) forced this into its current shape:
  //
  // 1. Trusting Instantly's own /emails/unread/count endpoint directly
  //    (confirmed live: it could report a nonzero count while not one
  //    message in /emails — unfiltered, is_unread=true filtered, or
  //    paginated hundreds deep — actually carried is_unread: true).
  // 2. The fix for that swapped in deriving the badge from whichever
  //    thread page happened to be currently loaded (countUnread(threads),
  //    called from refresh()/loadMore()) — better, but still wrong: while
  //    viewing "Inbox" (viewMode 'inbox', page 1 of 50, unfiltered by read
  //    state), the badge only reflected unread threads *within that one
  //    page*. Confirmed live: badge showed "1" while sitting in Inbox, but
  //    clicking "Neperskaityti" — a dedicated is_unread:true server fetch,
  //    unbounded by whatever Inbox's own page 1 contained — showed 6. The
  //    two were never actually the same query, so there was no reason to
  //    expect them to agree.
  //
  // Fixed by making this the *only* place unreadCount is ever set,
  // computed the same mode/filter-independent way refreshInterestedUnreadCount
  // below already does: paginate every is_unread:true page directly (not
  // trust a separate count endpoint), group into threads, and count only
  // those with a genuine unread *incoming* message (hasUnreadIncoming —
  // see its own doc comment for why an outgoing message can't count).
  // Called on mount, after refresh()/markThreadRead()/markThreadUnread(),
  // and via the manual refresh button — never derived from whatever page
  // the Inbox/Sent/Reminders view currently happens to have loaded, so it
  // can no longer disagree with what clicking "Neperskaityti" shows.
  refreshUnreadCount: async () => {
    try {
      const emails: UniboxThreadEmail[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await fetchInstantlyEmails({ limit: 100, is_unread: true, starting_after: cursor });
        emails.push(...page.items);
        if (!page.next_starting_after) break;
        cursor = page.next_starting_after;
      }
      const threads = groupIntoThreads(emails);
      set({ unreadCount: threads.filter((t) => t.hasUnread).length });
    } catch {
      // Non-critical — the badge just stays at its last known value.
    }
  },

  interestedUnreadCount: 0,
  refreshInterestedUnreadCount: async () => {
    try {
      const emails: UniboxThreadEmail[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await fetchInstantlyEmails({ limit: 100, is_unread: true, starting_after: cursor });
        emails.push(...page.items);
        if (!page.next_starting_after) break;
        cursor = page.next_starting_after;
      }
      const threads = groupIntoThreads(emails);
      const count = threads.filter((t) => t.hasUnread && t.latest.i_status === 1).length;
      set({ interestedUnreadCount: count });
    } catch {
      // Non-critical — same "badge just stays at its last known value"
      // fallback as refreshUnreadCount above (a transient network blip
      // shouldn't flash the nav badge to 0).
    }
  },

  openThreadId: null,
  setOpenThreadId: (id) => set({ openThreadId: id }),

  markingThreadIds: new Set(),
  markThreadRead: async (threadId) => {
    set((s) => ({ markingThreadIds: new Set(s.markingThreadIds).add(threadId) }));
    try {
      await markInstantlyThreadRead(threadId);
      set((s) => ({
        threads: s.threads.map((t) =>
          t.threadId === threadId ? { ...t, hasUnread: false, messages: t.messages.map((m) => ({ ...m, is_unread: false })) } : t,
        ),
      }));
      // Fire-and-forget, both of them — keeps the subnav badge and the
      // nav badge (App.tsx) from sitting stale until their next periodic
      // poll. Real fetches rather than a local decrement, same "never
      // trust a shortcut over real data" reasoning refreshUnreadCount's
      // own doc comment already explains — this thread's local update
      // above and what a fresh account-wide count would say aren't
      // guaranteed to match (e.g. another unread message could exist in
      // this same thread beyond what's currently loaded).
      void get().refreshUnreadCount();
      void get().refreshInterestedUnreadCount();
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
      set((s) => ({
        threads: s.threads.map((t) => {
          if (t.threadId !== threadId) return t;
          const messages = t.messages.map((m) => (m.id === t.latest.id ? { ...m, is_unread: true } : m));
          return { ...t, messages, hasUnread: hasUnreadIncoming(messages) };
        }),
      }));
      void get().refreshUnreadCount();
      void get().refreshInterestedUnreadCount();
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
      void get().refreshInterestedUnreadCount();
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
