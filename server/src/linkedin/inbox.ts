import { upsertConversation, addMessageIfNew, findLeadByLinkedinUrl, updateLeadStatus, logAction, type LeadStatus } from './db.js';
import { listConversationThreads, scrapeThreadMessages } from './page.js';
import { isPaused } from './safety.js';
import { getLinkedInPage } from './browser.js';

export interface InboxSyncResult {
  conversationsSynced: number;
  newMessages: number;
  leadsPromoted: number;
  leadsMarkedReplied: number;
  /** Set instead of actually syncing when the tick was automatic and
   * either the pause switch is on or no LinkedIn tab is currently open —
   * see the two real gaps documented below that let the old background
   * interval "turn the window back on" regardless of pause state. */
  skippedReason?: 'paused' | 'noTabOpen';
}

/** Called from InboxPanel.tsx's "↻ Sinchronizuoti dabar" (POST
 * /api/linkedin/inbox/sync, `isAutomatic = false`) and, separately, from
 * index.ts's own background interval (`isAutomatic = true`). index.ts
 * used to run this on a background setInterval every 10 minutes
 * regardless of any user action or the pause switch — removed after a
 * real, reported problem: this function had **zero** isPaused() check at
 * all (unlike the Scheduler's connect/message paths, which always gated
 * through canSendConnect()/canSendMessage()), and getLinkedInPage()'s old
 * unconditional tab-opening meant a closed tab got silently recreated
 * every 10 minutes too — together, "the LinkedIn window keeps turning
 * itself back on by itself," even with the account paused. Both are fixed
 * directly below (isPaused() check, requireExistingTab on the automatic
 * path) rather than left as reasons to keep this manual-only forever — see
 * index.ts's own interval for why bringing it back is now safe. A manual
 * click skips both checks, same reasoning as scheduler.ts's own
 * isAutomatic split: an explicit human click is already a supervised
 * action. Re-scrapes the
 * conversation list and each thread's messages, and does two things
 * nothing else in this codebase can: (1) promotes a 'pending' lead to
 * 'connected' the moment a real conversation with them exists — LinkedIn
 * only allows messaging a 1st-degree connection, so a conversation
 * existing at all is proof the invite was accepted, which is what
 * unblocks a campaign's 'message' sequence steps for that lead (see
 * scheduler.ts's own note on this being a known gap until this function
 * existed); (2) auto-stops a campaign for a lead the moment a genuine
 * inbound reply is detected, by marking them 'replied' — the same
 * "auto-stop on reply" the TZ calls out as both ethically important and
 * a real signal the lead should be handled by a human from here, not the
 * Scheduler. */
export async function syncInbox(isAutomatic = false): Promise<InboxSyncResult> {
  const result: InboxSyncResult = { conversationsSynced: 0, newMessages: 0, leadsPromoted: 0, leadsMarkedReplied: 0 };

  if (isAutomatic) {
    if (isPaused()) {
      return { ...result, skippedReason: 'paused' };
    }
    // Same reasoning as scheduler.ts's own automatic-tick check: stop
    // *before* calling anything that would open a tab on demand
    // (listConversationThreads()/scrapeThreadMessages() below both call
    // getLinkedInPage() with its default, tab-opening mode internally).
    if ((await getLinkedInPage(true)) === null) {
      return { ...result, skippedReason: 'noTabOpen' };
    }
  }

  const threads = await listConversationThreads();
  for (const thread of threads) {
    const conversation = upsertConversation({
      participantUrl: thread.participantUrl,
      participantName: thread.participantName,
      lastMessageAt: Date.now(),
      lastMessagePreview: thread.preview,
      unread: thread.unread,
    });
    result.conversationsSynced++;

    const lead = findLeadByLinkedinUrl(thread.participantUrl);
    if (lead && lead.status === 'pending') {
      updateLeadStatus(lead.id, 'connected' satisfies LeadStatus);
      // Logged so there's an actual timestamp for "when did this lead
      // accept" — this promotion used to just flip status with no record
      // at all of when, which meant the campaign UI had no way to show or
      // filter leads by the day they connected (a real, explicitly
      // requested need: "I want to see today's additions later").
      // stepId is null since accepting a connection isn't itself a
      // sequence step — it's what the connect step's own outcome gets
      // detected as, asynchronously, by this sync.
      logAction({
        leadId: lead.id,
        stepId: null,
        actionType: 'connection_accepted',
        status: 'success',
        targetUrl: lead.linkedinUrl,
        detail: 'Detected via inbox sync — a conversation now exists, meaning the invite was accepted.',
        executedAt: Date.now(),
        responseTimeMs: null,
      });
      result.leadsPromoted++;
    }

    const messages = await scrapeThreadMessages(thread.threadUrl);
    let sawNewInbound = false;
    for (const msg of messages) {
      const inserted = addMessageIfNew(conversation.id, lead?.id ?? null, msg.direction, msg.content, msg.timestamp);
      if (inserted) {
        result.newMessages++;
        if (msg.direction === 'in') sawNewInbound = true;
      }
    }

    if (sawNewInbound && lead && lead.status !== 'replied' && lead.status !== 'skipped') {
      updateLeadStatus(lead.id, 'replied' satisfies LeadStatus);
      result.leadsMarkedReplied++;
    }
  }

  return result;
}
