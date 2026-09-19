import { useEffect, useMemo, useRef } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Search, Check, X } from 'lucide-react';
import { useEmployeeTasksPanelStore } from '../../store/useEmployeeTasksPanelStore';
import { useDashboardStore } from '../../store/useDashboardStore';
import { DASHBOARD_METRICS, type DashboardDrillDownItem, type DashboardMetric } from '../../utils/dashboardApi';
import { formatHistoryTimestamp } from '../../utils/date';

// Same labels as ActivityDashboard.tsx's own METRIC_LABELS — duplicated
// rather than imported/exported, since that map is a private detail of
// the dashboard cards, not a shared constant, and this panel needs
// exactly the same four (see DASHBOARD_METRICS' own doc comment for why
// 'companies_added' is excluded everywhere in this feature).
const METRIC_LABELS: Record<DashboardMetric, string> = {
  notes: 'Komentarai',
  contacts: 'Pridėta kontaktų',
  calls: 'Skambučiai',
  linkedin_sent: 'LinkedIn užklausos',
};

const MIN_WIDTH = 260;
const MAX_WIDTH = 560;

/** The pinned employee-tasks panel — replaces the old per-click drill-down
 * modal. See useEmployeeTasksPanelStore's own doc comment for the full
 * "why a panel, not a modal" reasoning. Mounted once at App.tsx's root,
 * at the same fixed tree position regardless of Workspace ↔ Table
 * navigation (same reasoning as Softphone/IncomingCallBanner there), so
 * it survives exactly the kind of jump it exists to make cheap. */
export function EmployeeTasksPanel({
  onJumpToRow,
  onJumpToContact,
}: {
  onJumpToRow: (tableId: string, rowId: string) => void;
  onJumpToContact: (tableId: string, rowId: string, columnId: string, contactId: string) => void;
}) {
  const isOpen = useEmployeeTasksPanelStore((s) => s.isOpen);
  const collapsed = useEmployeeTasksPanelStore((s) => s.collapsed);
  const width = useEmployeeTasksPanelStore((s) => s.width);
  const workerId = useEmployeeTasksPanelStore((s) => s.workerId);
  const metric = useEmployeeTasksPanelStore((s) => s.metric);
  const loading = useEmployeeTasksPanelStore((s) => s.loading);
  const error = useEmployeeTasksPanelStore((s) => s.error);
  const searchText = useEmployeeTasksPanelStore((s) => s.searchText);
  const onlyUnseen = useEmployeeTasksPanelStore((s) => s.onlyUnseen);
  const seenIds = useEmployeeTasksPanelStore((s) => s.seenIds);
  const selectedIndex = useEmployeeTasksPanelStore((s) => s.selectedIndex);
  const items = useEmployeeTasksPanelStore((s) => s.items);
  const close = useEmployeeTasksPanelStore((s) => s.close);
  const toggleCollapsed = useEmployeeTasksPanelStore((s) => s.toggleCollapsed);
  const setWidth = useEmployeeTasksPanelStore((s) => s.setWidth);
  const setWorker = useEmployeeTasksPanelStore((s) => s.setWorker);
  const setMetric = useEmployeeTasksPanelStore((s) => s.setMetric);
  const setSearchText = useEmployeeTasksPanelStore((s) => s.setSearchText);
  const toggleOnlyUnseen = useEmployeeTasksPanelStore((s) => s.toggleOnlyUnseen);
  const markSeen = useEmployeeTasksPanelStore((s) => s.markSeen);
  const setSelectedIndex = useEmployeeTasksPanelStore((s) => s.setSelectedIndex);
  const moveSelection = useEmployeeTasksPanelStore((s) => s.moveSelection);
  const reload = useEmployeeTasksPanelStore((s) => s.reload);

  const workers = useDashboardStore((s) => s.workers);
  const dashboardPeriod = useDashboardStore((s) => s.period);
  const dashboardCustomRange = useDashboardStore((s) => s.customRange);

  // Computed here, not as a store method — see useEmployeeTasksPanelStore's
  // own computeVisibleItems doc comment for why a store method that
  // returns a fresh array on every call is a real infinite-render-loop
  // bug when called from a component selector, not just a style
  // preference.
  const visibleItems = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return items.filter((item) => {
      if (onlyUnseen && seenIds.has(item.id)) return false;
      if (!q) return true;
      return item.detail.toLowerCase().includes(q) || (item.tableName ?? '').toLowerCase().includes(q);
    });
  }, [items, searchText, onlyUnseen, seenIds]);

  // Re-fetch when the SAME period the dashboard cards use changes — this
  // is what guarantees the panel's list and the dashboard's own number
  // can never drift apart (they're always computed from one call with
  // one range, never two independently-tracked ones). setWorker/setMetric
  // already trigger their own reload(); this only needs to react when
  // period/range change out from under an already-open panel.
  useEffect(() => {
    if (isOpen && workerId && metric) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardPeriod, dashboardCustomRange?.from, dashboardCustomRange?.to]);

  const jump = (item: DashboardDrillDownItem, openForEdit: boolean) => {
    if (!item.tableId || !item.rowId) return;
    markSeen(item.id);
    if (openForEdit && item.columnId && item.contactId) {
      onJumpToContact(item.tableId, item.rowId, item.columnId, item.contactId);
    } else {
      onJumpToRow(item.tableId, item.rowId);
    }
  };

  // Keyboard nav — only while the panel is actually open/expanded, and
  // never while the user is typing somewhere else (the panel's own search
  // box included) so arrow keys/Enter don't hijack normal text editing
  // anywhere in the app. This app's table grid has no arrow-key cell
  // navigation of its own (selection is mouse-driven — see CLAUDE.md), so
  // there's nothing here to conflict with.
  useEffect(() => {
    if (!isOpen || collapsed) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const isTyping = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || (active as HTMLElement | null)?.isContentEditable;
      if (e.key === 'Escape') {
        close();
        return;
      }
      if (isTyping) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === 'Enter') {
        const item = visibleItems[selectedIndex];
        if (item) jump(item, true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, collapsed, visibleItems, selectedIndex]);

  // Arrow-key movement alone already jumps/highlights the target row (no
  // Enter needed) — the account owner's own acceptance criterion:
  // "прохожу их стрелками... таблица подсвечивает нужную строку." Enter
  // is the stronger action (also opens the cell/note editor — see jump()
  // above), matching the spec's own split between the two.
  const prevSelectedIndexRef = useRef(selectedIndex);
  useEffect(() => {
    if (prevSelectedIndexRef.current === selectedIndex) return;
    prevSelectedIndexRef.current = selectedIndex;
    const item = visibleItems[selectedIndex];
    if (item) jump(item, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIndex]);

  const resizingRef = useRef(false);
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ev.clientX)));
    };
    const onUp = () => {
      resizingRef.current = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!isOpen) return null;

  if (collapsed) {
    return (
      <div className="employee-tasks-panel employee-tasks-panel-collapsed" data-tutorial-id="employee-tasks-panel">
        <button type="button" onClick={toggleCollapsed} title="Išskleisti" data-tutorial-id="panel-toggle">
          <ChevronRight className="icon" size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="employee-tasks-panel" style={{ width }} data-tutorial-id="employee-tasks-panel">
      <div className="etp-header">
        <select
          className="etp-worker-select"
          value={workerId ?? ''}
          onChange={(e) => {
            const w = workers?.find((x) => x.workerId === e.target.value);
            if (w) setWorker(w.workerId, w.workerName);
          }}
        >
          {(workers ?? []).map((w) => (
            <option key={w.workerId} value={w.workerId}>
              {w.workerName}
            </option>
          ))}
        </select>
        <button type="button" className="etp-icon-btn" onClick={toggleCollapsed} title="Suskleisti" data-tutorial-id="panel-toggle">
          <ChevronLeft className="icon" size={15} />
        </button>
        <button type="button" className="etp-icon-btn" onClick={close} title="Uždaryti (Esc)">
          <X className="icon" size={15} />
        </button>
      </div>

      <div className="etp-metrics" data-tutorial-id="panel-task-type">
        {DASHBOARD_METRICS.map((m) => {
          const count = workers?.find((w) => w.workerId === workerId)?.metrics[m] ?? 0;
          return (
            <button
              key={m}
              type="button"
              className={`etp-metric-btn ${metric === m ? 'etp-metric-btn-active' : ''}`}
              onClick={() => setMetric(m)}
            >
              <span>{METRIC_LABELS[m]}</span>
              <span className="etp-metric-count">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="etp-filters">
        <span className="etp-search">
          <Search className="icon" size={13} />
          <input
            type="text"
            placeholder="Paieška…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </span>
        <label className="etp-unseen-toggle">
          <input type="checkbox" checked={onlyUnseen} onChange={toggleOnlyUnseen} />
          Tik neperžiūrėta
        </label>
      </div>

      {loading && <div className="etp-loading">Kraunama…</div>}
      {!loading && error && <div className="etp-error">{error}</div>}
      {!loading && !error && visibleItems.length === 0 && <div className="etp-empty">Nieko nerasta.</div>}

      {!loading && !error && visibleItems.length > 0 && (
        <ul className="etp-list">
          {visibleItems.map((item, i) => (
            <li
              key={item.id}
              className={`etp-item ${i === selectedIndex ? 'etp-item-active' : ''}`}
              data-tutorial-id="panel-task-item"
              onClick={() => {
                setSelectedIndex(i);
                jump(item, true);
              }}
            >
              <span className="etp-item-index">{i + 1}.</span>
              <span className="etp-item-body">
                <span className="etp-item-detail">{item.detail}</span>
                <span className="etp-item-meta">
                  {item.tableName && <>{item.tableName} · </>}
                  {formatHistoryTimestamp(item.createdAt)}
                </span>
              </span>
              {seenIds.has(item.id) && <Check className="icon etp-item-seen" size={13} />}
            </li>
          ))}
        </ul>
      )}

      <div className="etp-footer">
        <button type="button" onClick={() => moveSelection(-1)} disabled={visibleItems.length === 0} title="Ankstesnis (↑)">
          <ChevronUp className="icon" size={14} />
        </button>
        <span className="etp-footer-count">{visibleItems.length > 0 ? `${selectedIndex + 1} iš ${visibleItems.length}` : '0 iš 0'}</span>
        <button
          type="button"
          onClick={() => moveSelection(1)}
          disabled={visibleItems.length === 0}
          title="Kitas (↓)"
          data-tutorial-id="panel-nav-next"
        >
          <ChevronDown className="icon" size={14} />
        </button>
      </div>

      <div className="etp-resize-handle" onMouseDown={startResize} />
    </div>
  );
}
