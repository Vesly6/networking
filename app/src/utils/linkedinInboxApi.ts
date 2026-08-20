import { localApiRequest } from './localApi';

export interface LinkedInConversation {
  id: string;
  leadId: string | null;
  participantName: string | null;
  participantUrl: string;
  lastMessageAt: number | null;
  lastMessagePreview: string | null;
  unread: boolean;
}

export function fetchConversations(): Promise<{ conversations: LinkedInConversation[] }> {
  return localApiRequest('/api/linkedin/inbox');
}

export interface LinkedInMessage {
  id: string;
  conversationId: string;
  leadId: string | null;
  direction: 'in' | 'out';
  content: string;
  sentAt: number;
}

/** Also marks the conversation read server-side — matches "opening it is
 * what clears the unread badge," the same convention a real messaging
 * inbox already uses. */
export function fetchMessages(conversationId: string): Promise<{ conversation: LinkedInConversation; messages: LinkedInMessage[] }> {
  return localApiRequest(`/api/linkedin/inbox/${encodeURIComponent(conversationId)}/messages`);
}

/** A real, unrecoverable side effect against an actual LinkedIn
 * conversation the instant it succeeds — same category as every other
 * real-world action in this app (sendTestConnectionRequest, sendSms,
 * requestCallback). Only ever call this from an explicit, already-
 * confirmed user action. Also subject to the Safety Engine's message
 * caps/work-hours/pause, same as a sequence step's own message send. */
export function sendReply(conversationId: string, text: string): Promise<{ ok: true }> {
  return localApiRequest(`/api/linkedin/inbox/${encodeURIComponent(conversationId)}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

/** Drafts a suggested reply from this conversation's already-synced
 * message history — never sends anything itself; the result is meant to
 * land in the reply textarea for review/editing before sendReply() above
 * is ever called, same "AI drafts, human reviews" pattern as every other
 * AI feature in this app. */
export function suggestReply(conversationId: string): Promise<{ text: string }> {
  return localApiRequest(`/api/linkedin/inbox/${encodeURIComponent(conversationId)}/suggest-reply`, { method: 'POST' });
}

export interface InboxSyncResult {
  conversationsSynced: number;
  newMessages: number;
  leadsPromoted: number;
  leadsMarkedReplied: number;
}

/** On-demand trigger — the same sync also runs automatically every 10
 * minutes on the server (see index.ts). */
export function syncInbox(): Promise<InboxSyncResult> {
  return localApiRequest('/api/linkedin/inbox/sync', { method: 'POST' });
}
