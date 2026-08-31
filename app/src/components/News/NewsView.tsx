import { useEffect, useState } from 'react';
import { useNewsStore } from '../../store/useNewsStore';
import { useToastStore } from '../../store/useToastStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { ensureProtocol } from '../../utils/link';
import type { NewsItem } from '../../utils/newsApi';
import { Folder, Check, RefreshCw, Star, Trash2, ExternalLink, X } from 'lucide-react';

/** "Naujienos" — lives on the Workspace screen (App.tsx's workspaceScreen,
 * not an in-table Tab), since it isn't scoped to any particular table.
 * Deliberately links-only: no AI-drafted comment, no auto-posting to
 * LinkedIn — the user reads the source article and comments themselves,
 * manually, same "the app surfaces it, a human acts" boundary this
 * codebase already draws around every other real-world action (LinkedIn
 * sends, SMS sends, ...), just with nothing automated on this side of the
 * boundary at all.
 *
 * Folders are a flat, optional organizing layer over two independent
 * things: which *topics* are grouped together, and which individual
 * *articles* have been bookmarked ("⭐ Išsaugoti") into that folder —
 * confirmed with the user as both, not one or the other. "Visos" (all,
 * currentFolderId === null) is the always-present default view; adding a
 * topic or saving an article while a specific folder tab is selected
 * files it into that folder, matching how the tab you're "in" scopes the
 * action, rather than a separate folder-picker dialog on every save. */
export function NewsView() {
  const topics = useNewsStore((s) => s.topics);
  const items = useNewsStore((s) => s.items);
  const folders = useNewsStore((s) => s.folders);
  const savedItems = useNewsStore((s) => s.savedItems);
  const currentFolderId = useNewsStore((s) => s.currentFolderId);
  const ready = useNewsStore((s) => s.ready);
  const loading = useNewsStore((s) => s.loading);
  const error = useNewsStore((s) => s.error);
  const loadTopics = useNewsStore((s) => s.loadTopics);
  const addTopic = useNewsStore((s) => s.addTopic);
  const removeTopic = useNewsStore((s) => s.removeTopic);
  const refresh = useNewsStore((s) => s.refresh);
  const loadFolders = useNewsStore((s) => s.loadFolders);
  const addFolder = useNewsStore((s) => s.addFolder);
  const removeFolder = useNewsStore((s) => s.removeFolder);
  const selectFolder = useNewsStore((s) => s.selectFolder);
  const loadSavedItems = useNewsStore((s) => s.loadSavedItems);
  const saveItem = useNewsStore((s) => s.saveItem);
  const removeSavedItem = useNewsStore((s) => s.removeSavedItem);
  const moveSavedItem = useNewsStore((s) => s.moveSavedItem);
  const showToast = useToastStore((s) => s.show);

  const [newTopic, setNewTopic] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [addingFolder, setAddingFolder] = useState(false);
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  // Which item's inline "pick a folder" picker is currently open — only
  // ever needed while viewing "Visos" with 2+ folders to choose from (see
  // handleSaveClick below for the other cases, which skip the picker
  // entirely).
  const [pickingFolderKey, setPickingFolderKey] = useState<string | null>(null);

  useEffect(() => {
    void loadTopics();
    void loadFolders();
    void loadSavedItems();
  }, [loadTopics, loadFolders, loadSavedItems]);

  // Fires once topics finish loading (not per-topic-change) — refresh()
  // itself re-reads whatever *active* topics exist server-side via GET
  // /api/news (every folder's, not just the currently-selected one — the
  // folder filter below is purely a display-time client-side filter), so
  // this only needs `ready` as its trigger.
  useEffect(() => {
    if (ready) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);

  // Closes the inline folder picker on any click outside it — the picker
  // itself and the save button that opens it both stopPropagation their
  // own clicks, so this only ever fires for a genuine "click elsewhere".
  useEffect(() => {
    if (pickingFolderKey === null) return;
    const close = () => setPickingFolderKey(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [pickingFolderKey]);

  const inFolder = <T extends { folderId: string | null }>(list: T[]): T[] =>
    currentFolderId === null ? list : list.filter((x) => x.folderId === currentFolderId);

  const activeTopics = inFolder(topics.filter((t) => t.active));
  const inactiveTopics = inFolder(topics.filter((t) => !t.active));
  // A folder's feed only shows items from *that folder's* topics — items
  // is the full cross-topic list from the server (every active topic
  // across every folder), filtered here by whether each item's own topic
  // is filed into the currently-selected folder.
  const visibleItems =
    currentFolderId === null ? items : items.filter((i) => topics.find((t) => t.id === i.topicId)?.folderId === currentFolderId);
  const visibleSaved = inFolder(savedItems);

  const handleAddTopic = () => {
    const trimmed = newTopic.trim();
    if (!trimmed) return;
    void addTopic(trimmed);
    setNewTopic('');
  };

  const handleAddFolder = () => {
    const trimmed = newFolder.trim();
    if (!trimmed) return;
    void addFolder(trimmed);
    setNewFolder('');
    setAddingFolder(false);
  };

  const handleRemoveFolder = async (id: string, name: string) => {
    // Saved items only exist *as* belonging to a folder (confirmed with
    // the user) — deleting a folder deletes them too, not just ungroups
    // them the way topics are. Worth naming the actual count so this
    // reads as the real, permanent loss it is, not a vague warning.
    const savedCount = savedItems.filter((s) => s.folderId === id).length;
    const ok = await confirmDialog({
      message:
        `Ištrinti aplanką „${name}"?\n\n` +
        (savedCount > 0
          ? `${savedCount} išsaugota(-os) naujiena(-os) šiame aplanke bus ištrinta(-os) negrįžtamai. `
          : '') +
        'Temos liks, tik nebebus priskirtos šiam aplankui.',
      confirmLabel: 'Ištrinti aplanką',
      danger: savedCount > 0,
    });
    if (!ok) return;
    void removeFolder(id);
  };

  const saveKey = (item: NewsItem) => item.link ?? `${item.topicId}-${item.title}`;

  const doSave = async (item: NewsItem, folderId: string) => {
    if (!item.link) return;
    const key = saveKey(item);
    setSavingKeys((prev) => new Set(prev).add(key));
    setPickingFolderKey(null);
    await saveItem(item, folderId);
    setSavingKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    showToast('Išsaugota');
  };

  // A saved article only exists *as* belonging to a folder (confirmed
  // with the user) — there's no "save with no folder" option. While
  // already viewing a specific folder, that folder *is* the destination,
  // same "the tab you're in scopes the action" principle the topic-add
  // input already follows. On "Visos" there's no implicit destination, so:
  // zero folders → nothing to save into yet; exactly one → skip asking,
  // it's the only real choice; two or more → show the inline picker.
  const handleSaveClick = (item: NewsItem) => {
    if (currentFolderId !== null) {
      void doSave(item, currentFolderId);
      return;
    }
    if (folders.length === 0) {
      showToast('Pirmiausia sukurkite aplanką, kad galėtumėte išsaugoti naujieną');
      return;
    }
    if (folders.length === 1) {
      void doSave(item, folders[0].id);
      return;
    }
    setPickingFolderKey(saveKey(item));
  };

  const openArticle = (link?: string) => {
    if (link) window.open(ensureProtocol(link), '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="news-view">
      <div className="news-folders-row">
        <button type="button" className={`news-folder-tab${currentFolderId === null ? ' active' : ''}`} onClick={() => selectFolder(null)}>
          Visos
        </button>
        {folders.map((f) => (
          <span key={f.id} className={`news-folder-tab-wrap${currentFolderId === f.id ? ' active' : ''}`}>
            <button type="button" className="news-folder-tab" onClick={() => selectFolder(f.id)}>
              <Folder className="icon" size={14} /> {f.name}
            </button>
            <button type="button" className="news-folder-remove" title="Ištrinti aplanką" onClick={() => void handleRemoveFolder(f.id, f.name)}>
              <X className="icon" size={12} />
            </button>
          </span>
        ))}
        {addingFolder ? (
          <span className="news-topic-add">
            <input
              autoFocus
              type="text"
              placeholder="Aplanko pavadinimas"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddFolder();
                if (e.key === 'Escape') setAddingFolder(false);
              }}
              onBlur={() => !newFolder.trim() && setAddingFolder(false)}
            />
            <button type="button" onClick={handleAddFolder}>
              <Check className="icon" size={14} />
            </button>
          </span>
        ) : (
          <button type="button" className="news-folder-tab news-folder-new" onClick={() => setAddingFolder(true)}>
            + Naujas aplankas
          </button>
        )}
      </div>

      <div className="news-topics-row">
        {activeTopics.length > 0 && (
          <div className="search-tags-row">
            {activeTopics.map((t) => (
              <span key={t.id} className="search-tag">
                {t.query}
                <button
                  type="button"
                  className="search-tag-remove"
                  title="Pašalinti temą (išsaugoma istorijoje)"
                  onClick={() => void removeTopic(t.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="news-topic-add">
          <input
            type="text"
            placeholder="Pridėti temą, pvz. AI"
            value={newTopic}
            onChange={(e) => setNewTopic(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddTopic();
            }}
          />
          <button type="button" onClick={handleAddTopic}>
            + Pridėti
          </button>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading}>
          {loading ? 'Atnaujinama…' : <><RefreshCw className="icon" size={16} /> Atnaujinti</>}
        </button>
      </div>

      {inactiveTopics.length > 0 && (
        <div className="news-history-row">
          <span className="news-history-label">Istorija:</span>
          {inactiveTopics.map((t) => (
            <button
              type="button"
              key={t.id}
              className="news-history-chip"
              title="Vėl įtraukti į aktyvias temas"
              onClick={() => void addTopic(t.query, t.folderId)}
            >
              + {t.query}
            </button>
          ))}
        </div>
      )}

      {/* Deliberately no "Išsaugota" section at all on "Visos" — confirmed
          with the user: a saved article only exists *as* belonging to a
          folder, not as a separate always-visible list sitting on the main
          view. It only ever renders while a specific folder is selected. */}
      {currentFolderId !== null && visibleSaved.length > 0 && (
        <div className="news-saved-section">
          <h4><Star className="icon" size={16} /> Išsaugota šiame aplanke</h4>
          <div className="news-list">
            {visibleSaved.map((s) => (
              <div key={s.id} className="news-card news-saved-card" onClick={() => openArticle(s.link)}>
                {s.imageUrl && <img className="news-card-image" src={s.imageUrl} alt="" />}
                <div className="news-card-body">
                  <div className="news-card-title">{s.title}</div>
                  <div className="news-card-meta">
                    {s.source}
                    {s.source && s.date ? ' · ' : ''}
                    {s.date}
                  </div>
                  <div className="news-card-footer">
                    {folders.length > 1 && (
                      <select
                        className="news-saved-folder-select"
                        title="Perkelti į kitą aplanką"
                        value={s.folderId ?? ''}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => void moveSavedItem(s.id, e.target.value)}
                      >
                        {folders.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.name}
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      className="news-card-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeSavedItem(s.id);
                      }}
                    >
                      <Trash2 className="icon" size={14} /> Pašalinti
                    </button>
                    <span className="news-card-link">
                      <ExternalLink className="icon" size={13} /> Skaityti
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {ready && activeTopics.length === 0 && (
        <p className="linkedin-hint">Temų dar nėra — pridėkite bent vieną, kad pamatytumėte naujienas.</p>
      )}
      {ready && activeTopics.length > 0 && !loading && visibleItems.length === 0 && (
        <p className="linkedin-hint">Naujienų nerasta.</p>
      )}

      <div className="news-list">
        {visibleItems.map((item, i) => {
          const key = saveKey(item);
          const alreadySaved = savedItems.some((s) => s.link === item.link);
          return (
            <div
              key={item.link ?? `${item.topicId}-${i}`}
              className={`news-card${item.isNew ? '' : ' news-card-seen'}`}
              onClick={() => openArticle(item.link)}
            >
              {item.imageUrl && <img className="news-card-image" src={item.imageUrl} alt="" />}
              <div className="news-card-body">
                <div className="news-card-title">{item.title}</div>
                <div className="news-card-meta">
                  {item.source}
                  {item.source && item.date ? ' · ' : ''}
                  {item.date}
                </div>
                {item.snippet && <div className="news-card-snippet">{item.snippet}</div>}
                <div className="news-card-footer">
                  <span className="news-card-topic">{item.topicQuery}</span>
                  {!item.isNew && <span className="news-card-seen-badge">Matyta</span>}
                  <span className="news-card-save-wrap">
                    <button
                      type="button"
                      className="news-card-save"
                      disabled={alreadySaved || savingKeys.has(key)}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSaveClick(item);
                      }}
                    >
                      {alreadySaved ? (
                        <><Star className="icon" size={14} fill="currentColor" /> Išsaugota</>
                      ) : savingKeys.has(key) ? (
                        'Saugoma…'
                      ) : (
                        <><Star className="icon" size={14} /> Išsaugoti</>
                      )}
                    </button>
                    {pickingFolderKey === key && (
                      <div className="news-folder-picker" onClick={(e) => e.stopPropagation()}>
                        {folders.map((f) => (
                          <button type="button" key={f.id} onClick={() => void doSave(item, f.id)}>
                            <Folder className="icon" size={14} /> {f.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </span>
                  <span className="news-card-link">
                    <ExternalLink className="icon" size={13} /> Skaityti
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
