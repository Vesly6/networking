import { create } from 'zustand';
import {
  fetchNewsTopics,
  addNewsTopic,
  removeNewsTopic,
  moveNewsTopic,
  fetchNews,
  fetchNewsFolders,
  addNewsFolder,
  removeNewsFolder,
  fetchNewsSavedItems,
  saveNewsItem,
  removeNewsSavedItem,
  moveNewsSavedItem,
  type NewsTopic,
  type NewsItem,
  type NewsFolder,
  type NewsSavedItem,
} from '../utils/newsApi';

interface NewsState {
  topics: NewsTopic[];
  items: NewsItem[];
  folders: NewsFolder[];
  savedItems: NewsSavedItem[];
  /** null = "Visos" (all folders) — the always-present default view. */
  currentFolderId: string | null;
  ready: boolean;
  loading: boolean;
  error: string | null;
  loadTopics: () => Promise<void>;
  addTopic: (query: string, folderId?: string | null) => Promise<void>;
  removeTopic: (id: string) => Promise<void>;
  moveTopic: (id: string, folderId: string | null) => Promise<void>;
  refresh: () => Promise<void>;
  loadFolders: () => Promise<void>;
  addFolder: (name: string) => Promise<void>;
  removeFolder: (id: string) => Promise<void>;
  selectFolder: (id: string | null) => void;
  loadSavedItems: () => Promise<void>;
  saveItem: (item: NewsItem, folderId: string | null) => Promise<void>;
  removeSavedItem: (id: string) => Promise<void>;
  moveSavedItem: (id: string, folderId: string | null) => Promise<void>;
}

// No showToast calls in here — same convention as every other store in
// this app (useCallsStore, useLinkedInStore, ...): stores own data, the
// component (NewsView) owns the side effect of toasting `error`.
export const useNewsStore = create<NewsState>((set, get) => ({
  topics: [],
  items: [],
  folders: [],
  savedItems: [],
  currentFolderId: null,
  ready: false,
  loading: false,
  error: null,

  loadTopics: async () => {
    try {
      const { topics } = await fetchNewsTopics();
      set({ topics, ready: true, error: null });
    } catch (err) {
      set({ ready: true, error: err instanceof Error ? err.message : 'Nepavyko įkelti temų' });
    }
  },

  addTopic: async (query: string, folderId?: string | null) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    try {
      // The server reactivates an existing (possibly soft-deleted) topic
      // with the same query instead of creating a duplicate row — mirror
      // that here by replacing an already-present entry rather than
      // always appending, or re-adding a previously-removed search would
      // show up twice in local state until the next full reload.
      const topic = await addNewsTopic(trimmed, folderId ?? get().currentFolderId);
      const existing = get().topics.some((t) => t.id === topic.id);
      set({
        topics: existing ? get().topics.map((t) => (t.id === topic.id ? topic : t)) : [...get().topics, topic],
      });
      await get().refresh();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko pridėti temos' });
    }
  },

  removeTopic: async (id: string) => {
    const previous = get().topics;
    // Soft delete, mirrored optimistically: the topic stays in `topics`
    // (marked inactive, for the history section) rather than being
    // filtered out entirely — nothing the user has searched for should
    // visibly vanish, only stop being actively searched. Its items *do*
    // drop out of the current feed immediately, since they'll no longer
    // be fetched going forward.
    set({
      topics: previous.map((t) => (t.id === id ? { ...t, active: false } : t)),
      items: get().items.filter((i) => i.topicId !== id),
    });
    try {
      await removeNewsTopic(id);
    } catch (err) {
      set({ topics: previous, error: err instanceof Error ? err.message : 'Nepavyko pašalinti temos' });
    }
  },

  moveTopic: async (id: string, folderId: string | null) => {
    const previous = get().topics;
    set({ topics: previous.map((t) => (t.id === id ? { ...t, folderId } : t)) });
    try {
      await moveNewsTopic(id, folderId);
    } catch (err) {
      set({ topics: previous, error: err instanceof Error ? err.message : 'Nepavyko perkelti temos' });
    }
  },

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const { items } = await fetchNews();
      set({ items, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Nepavyko įkelti naujienų' });
    }
  },

  loadFolders: async () => {
    try {
      const { folders } = await fetchNewsFolders();
      set({ folders });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko įkelti aplankų' });
    }
  },

  addFolder: async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const folder = await addNewsFolder(trimmed);
      set({ folders: [...get().folders, folder] });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko sukurti aplanko' });
    }
  },

  removeFolder: async (id: string) => {
    const previousFolders = get().folders;
    const previousTopics = get().topics;
    const previousSaved = get().savedItems;
    // A real delete server-side (folders aren't user content worth
    // preserving, only their contents are — see deleteNewsFolder's own
    // doc comment) — mirrored by ungrouping anything that pointed at it,
    // same as the server's ON DELETE SET NULL.
    set({
      folders: previousFolders.filter((f) => f.id !== id),
      topics: previousTopics.map((t) => (t.folderId === id ? { ...t, folderId: null } : t)),
      savedItems: previousSaved.map((s) => (s.folderId === id ? { ...s, folderId: null } : s)),
      currentFolderId: get().currentFolderId === id ? null : get().currentFolderId,
    });
    try {
      await removeNewsFolder(id);
    } catch (err) {
      set({
        folders: previousFolders,
        topics: previousTopics,
        savedItems: previousSaved,
        error: err instanceof Error ? err.message : 'Nepavyko ištrinti aplanko',
      });
    }
  },

  selectFolder: (id: string | null) => set({ currentFolderId: id }),

  loadSavedItems: async () => {
    try {
      const { items } = await fetchNewsSavedItems();
      set({ savedItems: items });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko įkelti išsaugotų naujienų' });
    }
  },

  saveItem: async (item: NewsItem, folderId: string | null) => {
    try {
      const saved = await saveNewsItem(item, folderId);
      set({ savedItems: [saved, ...get().savedItems] });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Nepavyko išsaugoti' });
    }
  },

  removeSavedItem: async (id: string) => {
    const previous = get().savedItems;
    set({ savedItems: previous.filter((s) => s.id !== id) });
    try {
      await removeNewsSavedItem(id);
    } catch (err) {
      set({ savedItems: previous, error: err instanceof Error ? err.message : 'Nepavyko pašalinti' });
    }
  },

  moveSavedItem: async (id: string, folderId: string | null) => {
    const previous = get().savedItems;
    set({ savedItems: previous.map((s) => (s.id === id ? { ...s, folderId } : s)) });
    try {
      await moveNewsSavedItem(id, folderId);
    } catch (err) {
      set({ savedItems: previous, error: err instanceof Error ? err.message : 'Nepavyko perkelti' });
    }
  },
}));
