import { create } from 'zustand';
import {
  fetchConversations,
  fetchMessages,
  sendReply as apiSendReply,
  syncInbox as apiSyncInbox,
  suggestReply as apiSuggestReply,
  type LinkedInConversation,
  type LinkedInMessage,
} from '../utils/linkedinInboxApi';

interface LinkedInInboxState {
  conversations: LinkedInConversation[];
  conversationsReady: boolean;
  refreshConversations: () => Promise<void>;

  openConversationId: string | null;
  setOpenConversationId: (id: string | null) => void;
  messages: LinkedInMessage[];
  messagesReady: boolean;
  openMessages: (id: string) => Promise<void>;

  sending: boolean;
  sendError: string | null;
  /** Real side effect the instant it resolves — the caller (InboxPanel)
   * must have already shown a confirm dialog. */
  sendReply: (conversationId: string, text: string) => Promise<boolean>;

  syncing: boolean;
  syncNow: () => Promise<void>;

  suggesting: boolean;
  suggestError: string | null;
  /** Drafts a suggested reply from the conversation's message history —
   * never sends anything. Returns the text on success (caller drops it
   * into the reply textarea) or null on failure (suggestError explains
   * why). */
  suggestReplyText: (conversationId: string) => Promise<string | null>;
}

export const useLinkedInInboxStore = create<LinkedInInboxState>((set, get) => ({
  conversations: [],
  conversationsReady: false,
  refreshConversations: async () => {
    try {
      const { conversations } = await fetchConversations();
      set({ conversations, conversationsReady: true });
    } catch {
      set({ conversationsReady: true });
    }
  },

  openConversationId: null,
  setOpenConversationId: (id) => {
    set({ openConversationId: id, messages: [], messagesReady: false });
    if (id) void get().openMessages(id);
  },

  messages: [],
  messagesReady: false,
  openMessages: async (id) => {
    try {
      const { messages } = await fetchMessages(id);
      set({ messages, messagesReady: true });
      // Opening it is what clears the unread badge server-side — mirror
      // that locally too instead of waiting for the next full refresh.
      set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? { ...c, unread: false } : c)) }));
    } catch {
      set({ messagesReady: true });
    }
  },

  sending: false,
  sendError: null,
  sendReply: async (conversationId, text) => {
    set({ sending: true, sendError: null });
    try {
      await apiSendReply(conversationId, text);
      set({ sending: false });
      void get().openMessages(conversationId);
      return true;
    } catch (err) {
      set({ sending: false, sendError: err instanceof Error ? err.message : 'Could not send reply' });
      return false;
    }
  },

  syncing: false,
  syncNow: async () => {
    set({ syncing: true });
    try {
      await apiSyncInbox();
    } finally {
      set({ syncing: false });
      void get().refreshConversations();
    }
  },

  suggesting: false,
  suggestError: null,
  suggestReplyText: async (conversationId) => {
    set({ suggesting: true, suggestError: null });
    try {
      const { text } = await apiSuggestReply(conversationId);
      set({ suggesting: false });
      return text;
    } catch (err) {
      set({ suggesting: false, suggestError: err instanceof Error ? err.message : 'Could not generate a suggestion' });
      return null;
    }
  },
}));
