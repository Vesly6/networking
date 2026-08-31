import { localApiRequest } from './localApi';

export interface NewsTopic {
  id: string;
  companyId: string;
  query: string;
  /** false = soft-deleted ("×" was clicked) — the row and its search
   * history are never actually removed, only hidden from the active chip
   * row and no longer searched/billed. See server/src/accounts/db.ts's
   * deleteNewsTopic doc comment for why this replaced a hard delete. */
  active: boolean;
  folderId: string | null;
  createdAt: number;
}

export interface NewsItem {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
  source?: string;
  imageUrl?: string;
  topicId: string;
  topicQuery: string;
  /** Server-computed via news_seen_links (accounts/db.ts's
   * markNewsLinkSeen) — false the very first time this exact article link
   * has ever been returned to this company, true on every subsequent
   * sighting. Full history is kept either way (confirmed with the user:
   * seen items stay visible, just marked, not hidden). */
  isNew: boolean;
}

export interface NewsFolder {
  id: string;
  companyId: string;
  name: string;
  createdAt: number;
}

export interface NewsSavedItem {
  id: string;
  companyId: string;
  folderId: string | null;
  link: string;
  title: string | null;
  snippet: string | null;
  source: string | null;
  date: string | null;
  imageUrl: string | null;
  savedAt: number;
}

export function fetchNewsTopics(): Promise<{ topics: NewsTopic[] }> {
  return localApiRequest('/api/news/topics');
}

export function addNewsTopic(query: string, folderId: string | null = null): Promise<NewsTopic> {
  return localApiRequest('/api/news/topics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, folderId }),
  });
}

export function removeNewsTopic(id: string): Promise<{ ok: boolean }> {
  return localApiRequest(`/api/news/topics/${id}`, { method: 'DELETE' });
}

export function moveNewsTopic(id: string, folderId: string | null): Promise<{ ok: boolean }> {
  return localApiRequest(`/api/news/topics/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId }),
  });
}

/** One request fans out server-side into one serper.dev call per saved
 * topic (server/src/index.ts's GET /api/news) — a company with no topics
 * yet just gets back an empty, valid `items` array, not an error. */
export function fetchNews(): Promise<{ items: NewsItem[] }> {
  return localApiRequest('/api/news');
}

export function fetchNewsFolders(): Promise<{ folders: NewsFolder[] }> {
  return localApiRequest('/api/news/folders');
}

export function addNewsFolder(name: string): Promise<NewsFolder> {
  return localApiRequest('/api/news/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function removeNewsFolder(id: string): Promise<{ ok: boolean }> {
  return localApiRequest(`/api/news/folders/${id}`, { method: 'DELETE' });
}

export function fetchNewsSavedItems(): Promise<{ items: NewsSavedItem[] }> {
  return localApiRequest('/api/news/saved');
}

/** Sends a real snapshot of the article's own fields — see
 * server/src/accounts/db.ts's news_saved_items doc comment for why (a
 * re-search later isn't guaranteed to surface the same result again). */
export function saveNewsItem(item: NewsItem, folderId: string | null): Promise<NewsSavedItem> {
  return localApiRequest('/api/news/saved', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      folderId,
      link: item.link,
      title: item.title,
      snippet: item.snippet,
      source: item.source,
      date: item.date,
      imageUrl: item.imageUrl,
    }),
  });
}

export function removeNewsSavedItem(id: string): Promise<{ ok: boolean }> {
  return localApiRequest(`/api/news/saved/${id}`, { method: 'DELETE' });
}

export function moveNewsSavedItem(id: string, folderId: string | null): Promise<{ ok: boolean }> {
  return localApiRequest(`/api/news/saved/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderId }),
  });
}
