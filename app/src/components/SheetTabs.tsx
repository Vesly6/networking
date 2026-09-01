import {
  useEffect,
  useMemo,
  useRef,
  useState,
  Fragment,
  type MouseEvent as ReactMouseEvent,
  type DragEvent as ReactDragEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import type { TableMeta } from '../types';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import { useAuthStore } from '../store/useAuthStore';
import { confirmDialog } from '../store/useConfirmStore';
import { confirmDeleteTable } from '../utils/confirmDeleteTable';
import { countRowsForTable } from '../db/db';
import { ContextMenu } from './ContextMenu';
import { Popover } from './Popover';

interface TableMenuState {
  x: number;
  y: number;
  id: string;
  name: string;
  folderId: string | null;
}

interface FolderMenuState {
  x: number;
  y: number;
  id: string;
  name: string;
}

/** Excel-style sheet tabs along the bottom of the window — lets you switch
 * between the workspace's other tables without leaving the current one to
 * go back to the Workspace screen. No new data relationship between tables
 * is introduced here; this is purely a faster way to reach
 * useWorkspaceStore's existing table list/setActiveTable, which the
 * Workspace screen already exposes as cards.
 *
 * Two organizational layers were added on top of that original flat list,
 * both purely presentational (they don't touch table data itself):
 * drag-reorder (a table's own `order`) and folders (`folderId`) — a client
 * onboarding many tables at once (country x sector combinations) needed a
 * way to group and arrange dozens of tabs instead of scanning one long
 * flat row. See useWorkspaceStore.ts's moveTable/moveFolder for the actual
 * persistence. */
export function SheetTabs() {
  const tables = useWorkspaceStore((s) => s.tables);
  const folders = useWorkspaceStore((s) => s.folders);
  const activeTableId = useWorkspaceStore((s) => s.activeTableId);
  const setActiveTable = useWorkspaceStore((s) => s.setActiveTable);
  const createTable = useWorkspaceStore((s) => s.createTable);
  const duplicateTable = useWorkspaceStore((s) => s.duplicateTable);
  const renameTable = useWorkspaceStore((s) => s.renameTable);
  const deleteTable = useWorkspaceStore((s) => s.deleteTable);
  const moveTable = useWorkspaceStore((s) => s.moveTable);
  const moveFolder = useWorkspaceStore((s) => s.moveFolder);
  const createFolder = useWorkspaceStore((s) => s.createFolder);
  const renameFolder = useWorkspaceStore((s) => s.renameFolder);
  const deleteFolder = useWorkspaceStore((s) => s.deleteFolder);
  const currentUser = useAuthStore((s) => s.user);
  // Same hard block as WorkspaceView.tsx's own table cards, and for the
  // identical reason — this is a second, faster entry point to the exact
  // same four actions (rename/new/duplicate/delete), so it needs the same
  // gate or a worker could just use this row instead. See WorkspaceView's
  // own doc comment for the full reasoning; server/src/index.ts's
  // requireNotWorker on all four routes (plus the new folder/reorder ones)
  // is what actually enforces it.
  const canManageTables = currentUser?.role !== 'worker';

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [menu, setMenu] = useState<TableMenuState | null>(null);
  const [menuView, setMenuView] = useState<'main' | 'folder-picker'>('main');

  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState('');
  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string>>(new Set());
  const [creatingFolder, setCreatingFolder] = useState<{ assignTableId: string } | null>(null);
  const [newFolderName, setNewFolderName] = useState('');

  // Table drag-reorder. dragTableFolderId is the GROUP the dragged table
  // currently belongs to (null = ungrouped) — a drop is only honored
  // against a sibling target in that same group; moving a table between
  // groups by dragging is deliberately not supported (see the plan doc /
  // CLAUDE.md-style reasoning: right-click "Priskirti aplankui" is the one,
  // unambiguous way to change a table's folder).
  const [dragTableId, setDragTableId] = useState<string | null>(null);
  const [dragTableFolderId, setDragTableFolderId] = useState<string | null>(null);
  const [dragOverTableId, setDragOverTableId] = useState<string | null>(null);
  const [dragOverTableAfter, setDragOverTableAfter] = useState(false);

  // Folder drag-reorder — folders are always one flat group, so this is
  // simpler than the table version above (no group-matching guard needed).
  const [dragFolderId, setDragFolderId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [dragOverFolderAfter, setDragOverFolderAfter] = useState(false);

  const [jumpAnchor, setJumpAnchor] = useState<HTMLElement | null>(null);
  const [jumpFilter, setJumpFilter] = useState('');

  const stripRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState({ canLeft: false, canRight: false });

  const ungroupedTables = useMemo(
    () => tables.filter((t) => !t.folderId).sort((a, b) => a.order - b.order),
    [tables],
  );
  const tablesByFolder = useMemo(() => {
    const map = new Map<string, TableMeta[]>();
    for (const folder of folders) {
      map.set(
        folder.id,
        tables.filter((t) => t.folderId === folder.id).sort((a, b) => a.order - b.order),
      );
    }
    return map;
  }, [tables, folders]);

  const commitRename = () => {
    if (editingId) renameTable(editingId, editingName);
    setEditingId(null);
  };

  const startRename = (id: string, name: string) => {
    setEditingId(id);
    setEditingName(name);
  };

  const commitFolderRename = () => {
    if (editingFolderId) renameFolder(editingFolderId, editingFolderName);
    setEditingFolderId(null);
  };

  const commitNewFolder = async () => {
    const name = newFolderName.trim();
    const assignTableId = creatingFolder?.assignTableId;
    setCreatingFolder(null);
    setNewFolderName('');
    if (!name) return;
    const folder = await createFolder(name);
    if (folder && assignTableId) moveTable(assignTableId, { folderId: folder.id, beforeTableId: null });
  };

  const handleNewTable = async () => {
    const id = await createTable(`Lentelė ${tables.length + 1}`);
    // On failure, stay on the current table (whose error toast App.tsx
    // already shows) rather than getting bounced out to the Workspace
    // screen — createTable() itself returns null instead of throwing on
    // failure specifically so callers can make this call, see
    // useWorkspaceStore's own actionError doc comment.
    if (id) setActiveTable(id);
  };

  const handleContextMenu = (e: ReactMouseEvent, t: TableMeta) => {
    e.preventDefault();
    if (!canManageTables) return;
    setMenuView('main');
    setMenu({ x: e.clientX, y: e.clientY, id: t.id, name: t.name, folderId: t.folderId ?? null });
  };

  const handleFolderContextMenu = (e: ReactMouseEvent, id: string, name: string) => {
    e.preventDefault();
    if (!canManageTables) return;
    setFolderMenu({ x: e.clientX, y: e.clientY, id, name });
  };

  const toggleExpanded = (folderId: string) => {
    setExpandedFolderIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  // ContextMenu/Popover only stop their own click from bubbling (so
  // clicking an item inside doesn't also trigger this) — closing on a
  // click anywhere else is the caller's job, same as every other popover
  // in the app (TableView's closePopovers does this for the column/row
  // header menus).
  useEffect(() => {
    if (!menu && !folderMenu && !jumpAnchor) return;
    const close = () => {
      setMenu(null);
      setFolderMenu(null);
      setJumpAnchor(null);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menu, folderMenu, jumpAnchor]);

  // Scroll-arrow visibility — re-checked on scroll, on resize (via
  // ResizeObserver), and whenever the tab/folder list or an expand/collapse
  // toggle could plausibly have changed the strip's overflow.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const update = () => {
      setScrollState({
        canLeft: el.scrollLeft > 4,
        canRight: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
      });
    };
    update();
    el.addEventListener('scroll', update);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [tables.length, folders.length, expandedFolderIds]);

  const scrollByChunk = (dir: 1 | -1) => stripRef.current?.scrollBy({ left: dir * 240, behavior: 'smooth' });

  // Plain mice don't pan a horizontal strip on wheel by default (trackpads
  // already do, via native two-finger/shift gestures) — this makes a
  // regular vertical wheel scroll the tab strip instead of doing nothing,
  // once there's actually something to scroll to.
  const handleWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    const el = stripRef.current;
    if (!el || e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft += e.deltaY;
    e.preventDefault();
  };

  const jumpMatches = useMemo(() => {
    const q = jumpFilter.trim().toLowerCase();
    const matches: { table: TableMeta; folderName: string | null }[] = [];
    for (const folder of folders) {
      for (const t of tablesByFolder.get(folder.id) ?? []) {
        if (!q || t.name.toLowerCase().includes(q)) matches.push({ table: t, folderName: folder.name });
      }
    }
    for (const t of ungroupedTables) {
      if (!q || t.name.toLowerCase().includes(q)) matches.push({ table: t, folderName: null });
    }
    return matches;
  }, [folders, tablesByFolder, ungroupedTables, jumpFilter]);

  const renderTableTab = (t: TableMeta, groupTables: TableMeta[], groupFolderId: string | null) => {
    if (editingId === t.id) {
      return (
        <input
          key={t.id}
          autoFocus
          className="sheet-tab-input"
          value={editingName}
          onChange={(e) => setEditingName(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setEditingId(null);
          }}
        />
      );
    }
    const isDragOver = dragOverTableId === t.id;
    return (
      <button
        key={t.id}
        type="button"
        draggable
        className={[
          'sheet-tab',
          t.id === activeTableId && 'sheet-tab-active',
          dragTableId === t.id && 'sheet-tab-dragging',
          isDragOver && (dragOverTableAfter ? 'sheet-tab-drop-after' : 'sheet-tab-drop-before'),
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => setActiveTable(t.id)}
        onContextMenu={(e) => handleContextMenu(e, t)}
        onDragStart={(e: ReactDragEvent<HTMLButtonElement>) => {
          setDragTableId(t.id);
          setDragTableFolderId(groupFolderId);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e: ReactDragEvent<HTMLButtonElement>) => {
          if (!dragTableId || dragTableId === t.id || dragTableFolderId !== groupFolderId) return;
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          setDragOverTableId(t.id);
          setDragOverTableAfter(e.clientX > rect.left + rect.width / 2);
        }}
        onDrop={(e: ReactDragEvent<HTMLButtonElement>) => {
          e.preventDefault();
          if (dragTableId && dragTableId !== t.id && dragTableFolderId === groupFolderId) {
            const rect = e.currentTarget.getBoundingClientRect();
            const after = e.clientX > rect.left + rect.width / 2;
            const idx = groupTables.findIndex((x) => x.id === t.id);
            const beforeTableId = after ? (groupTables[idx + 1]?.id ?? null) : t.id;
            moveTable(dragTableId, { folderId: groupFolderId, beforeTableId });
          }
          setDragTableId(null);
          setDragTableFolderId(null);
          setDragOverTableId(null);
        }}
        onDragEnd={() => {
          setDragTableId(null);
          setDragTableFolderId(null);
          setDragOverTableId(null);
        }}
        title={
          canManageTables
            ? 'Spustelėkite, kad perjungtumėte lenteles — vilkite, kad pakeistumėte tvarką, dešiniuoju paspaudimu pervadinkite, pridėkite, dubliuokite ar ištrinkite'
            : 'Spustelėkite, kad perjungtumėte lenteles'
        }
      >
        {t.name}
      </button>
    );
  };

  return (
    <div className="sheet-tabs-bar">
      {scrollState.canLeft && (
        <button type="button" className="sheet-tabs-scroll-btn" onClick={() => scrollByChunk(-1)} title="Slinkti kairėn">
          ◀
        </button>
      )}
      <div className="sheet-tabs" ref={stripRef} onWheel={handleWheel}>
        {creatingFolder && (
          <input
            autoFocus
            className="sheet-tab-input"
            placeholder="Aplanko pavadinimas"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onBlur={() => void commitNewFolder()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                setCreatingFolder(null);
                setNewFolderName('');
              }
            }}
          />
        )}
        {folders.map((folder) => {
          const folderTables = tablesByFolder.get(folder.id) ?? [];
          const containsActive = folderTables.some((t) => t.id === activeTableId);
          const isExpanded = expandedFolderIds.has(folder.id);
          const isDragOver = dragOverFolderId === folder.id;
          return (
            <Fragment key={folder.id}>
              {editingFolderId === folder.id ? (
                <input
                  autoFocus
                  className="sheet-tab-input"
                  value={editingFolderName}
                  onChange={(e) => setEditingFolderName(e.target.value)}
                  onBlur={commitFolderRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    if (e.key === 'Escape') setEditingFolderId(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  draggable
                  className={[
                    'sheet-tab',
                    'sheet-tab-folder',
                    containsActive && 'sheet-tab-folder-active',
                    dragFolderId === folder.id && 'sheet-tab-dragging',
                    isDragOver && (dragOverFolderAfter ? 'sheet-tab-drop-after' : 'sheet-tab-drop-before'),
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => toggleExpanded(folder.id)}
                  onContextMenu={(e) => handleFolderContextMenu(e, folder.id, folder.name)}
                  onDragStart={(e) => {
                    setDragFolderId(folder.id);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragOver={(e) => {
                    if (!dragFolderId || dragFolderId === folder.id) return;
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    setDragOverFolderId(folder.id);
                    setDragOverFolderAfter(e.clientX > rect.left + rect.width / 2);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragFolderId && dragFolderId !== folder.id) {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const after = e.clientX > rect.left + rect.width / 2;
                      const idx = folders.findIndex((f) => f.id === folder.id);
                      const beforeFolderId = after ? (folders[idx + 1]?.id ?? null) : folder.id;
                      moveFolder(dragFolderId, beforeFolderId);
                    }
                    setDragFolderId(null);
                    setDragOverFolderId(null);
                  }}
                  onDragEnd={() => {
                    setDragFolderId(null);
                    setDragOverFolderId(null);
                  }}
                  title="Spustelėkite, kad išskleistumėte/suskleistumėte — vilkite, kad pakeistumėte tvarką, dešiniuoju paspaudimu pervadinkite ar ištrinkite"
                >
                  📁 {folder.name} ({folderTables.length})
                </button>
              )}
              {isExpanded && (
                <span className="sheet-tab-folder-group">
                  {folderTables.map((t) => renderTableTab(t, folderTables, folder.id))}
                </span>
              )}
            </Fragment>
          );
        })}
        {ungroupedTables.map((t) => renderTableTab(t, ungroupedTables, null))}
        {canManageTables && (
          <button type="button" className="sheet-tab-add" title="Nauja lentelė" onClick={handleNewTable}>
            +
          </button>
        )}
      </div>
      {scrollState.canRight && (
        <button type="button" className="sheet-tabs-scroll-btn" onClick={() => scrollByChunk(1)} title="Slinkti dešinėn">
          ▶
        </button>
      )}
      <button
        type="button"
        className="sheet-tabs-jump-btn"
        title="Visos lentelės"
        onClick={(e) => {
          e.stopPropagation();
          setJumpFilter('');
          setJumpAnchor(e.currentTarget);
        }}
      >
        🔍
      </button>
      {jumpAnchor && (
        <Popover anchor={jumpAnchor} width={280}>
          <input
            autoFocus
            className="sheet-tabs-jump-filter"
            placeholder="Ieškoti lentelės…"
            value={jumpFilter}
            onChange={(e) => setJumpFilter(e.target.value)}
          />
          <div className="sheet-tabs-jump-list">
            {jumpMatches.length === 0 && <div className="sheet-tabs-jump-empty">Nerasta</div>}
            {jumpMatches.map(({ table, folderName }) => (
              <button
                key={table.id}
                type="button"
                className={`sheet-tabs-jump-item ${table.id === activeTableId ? 'sheet-tabs-jump-item-active' : ''}`}
                onClick={() => {
                  setActiveTable(table.id);
                  setJumpAnchor(null);
                }}
              >
                {folderName && <span className="sheet-tabs-jump-item-folder">📁 {folderName}</span>}
                {table.name}
              </button>
            ))}
          </div>
        </Popover>
      )}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y}>
          {menuView === 'main' ? (
            <>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  startRename(menu.id, menu.name);
                  setMenu(null);
                }}
              >
                Pervadinti
              </button>
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  setMenu(null);
                  void handleNewTable();
                }}
              >
                Nauja lentelė
              </button>
              <button
                type="button"
                className="context-menu-item"
                onClick={async () => {
                  const newId = await duplicateTable(menu.id);
                  setMenu(null);
                  if (newId) setActiveTable(newId);
                }}
              >
                Dubliuoti lentelę
              </button>
              <button type="button" className="context-menu-item" onClick={() => setMenuView('folder-picker')}>
                Priskirti aplankui ▸
              </button>
              {menu.folderId && (
                <button
                  type="button"
                  className="context-menu-item"
                  onClick={() => {
                    moveTable(menu.id, { folderId: null, beforeTableId: null });
                    setMenu(null);
                  }}
                >
                  Išimti iš aplanko
                </button>
              )}
              <button
                type="button"
                className="context-menu-item context-menu-danger"
                onClick={async () => {
                  const id = menu.id;
                  const name = menu.name;
                  setMenu(null);
                  const rows = await countRowsForTable(id);
                  if (await confirmDeleteTable(name, rows)) deleteTable(id);
                }}
              >
                Ištrinti lentelę
              </button>
            </>
          ) : (
            <>
              <button type="button" className="context-menu-item" onClick={() => setMenuView('main')}>
                ← Atgal
              </button>
              {folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className="context-menu-item"
                  onClick={() => {
                    moveTable(menu.id, { folderId: f.id, beforeTableId: null });
                    setMenu(null);
                  }}
                >
                  📁 {f.name}
                </button>
              ))}
              <button
                type="button"
                className="context-menu-item"
                onClick={() => {
                  setCreatingFolder({ assignTableId: menu.id });
                  setNewFolderName('');
                  setMenu(null);
                }}
              >
                + Naujas aplankas
              </button>
            </>
          )}
        </ContextMenu>
      )}
      {folderMenu && (
        <ContextMenu x={folderMenu.x} y={folderMenu.y}>
          <button
            type="button"
            className="context-menu-item"
            onClick={() => {
              setEditingFolderId(folderMenu.id);
              setEditingFolderName(folderMenu.name);
              setFolderMenu(null);
            }}
          >
            Pervadinti aplanką
          </button>
          <button
            type="button"
            className="context-menu-item context-menu-danger"
            onClick={async () => {
              const id = folderMenu.id;
              const name = folderMenu.name;
              setFolderMenu(null);
              if (await confirmDialog(`Ištrinti aplanką „${name}“? Lentelės liks, tik nebebus priskirtos jokiam aplankui.`)) deleteFolder(id);
            }}
          >
            Ištrinti aplanką
          </button>
        </ContextMenu>
      )}
    </div>
  );
}
