import { useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useLinkedInPlannerStore } from '../../store/useLinkedInPlannerStore';
import { useWorkspaceStore } from '../../store/useWorkspaceStore';
import { useWorkersStore } from '../../store/useWorkersStore';
import { useAuthStore } from '../../store/useAuthStore';
import { subscribeToCompanyEvents } from '../../utils/companyEventBus';
import { can } from '../../utils/permissions';
import { getColumnByType } from '../../utils/row';
import { DEMO_MODE } from '../../utils/demoMode';
import { useToastStore } from '../../store/useToastStore';
import { PLANNER_VIEW_ALL_WORKERS, type PlannerListFilter, type PlannerTask } from '../../utils/linkedinPlannerApi';
import { HoverTooltip } from '../HoverTooltip';
import { ExternalLink, ArrowRight, Search } from 'lucide-react';

/** LinkedIn Planner — a manual task queue and status tracker, replacing
 * the disabled LinkedIn Automation tab. This screen NEVER sends anything
 * anywhere: "Atidaryti" (below) is a plain link that opens the person's
 * real LinkedIn profile in a new tab, same as any other link in this app
 * — the actual connection request/message is sent by the worker, by
 * hand, in that tab, in their own already-logged-in LinkedIn session.
 * Nothing on this screen (or anywhere in server/src/linkedinPlanner/)
 * can reach linkedin.com on its own.
 *
 * Deliberately just two possible actions per task, on explicit request —
 * no claim step, no assignee, no accepted/declined/no_response/replied/
 * skipped dropdown: "Kvietimas išsiųstas" (Siuntimui -> Išsiųsta) and
 * "Nepatvirtino" (Išsiųsta -> back to Siuntimui, see its own doc comment
 * below). Sending is per-WORKER, not a single shared task status (see
 * PlannerTask.senders' own doc comment in linkedinPlannerApi.ts) — each
 * worker sends from their own LinkedIn account, so worker A having
 * already sent this person a request never hides or blocks worker B's
 * own send; both simply show up as independent senders. This is also
 * exactly how a second worker taking over a table sees precisely what
 * the first one already did, without starting over: the same shared task
 * list, just each worker's own Siuntimui/Išsiųsta bucketing is personal. */

// Just the two tabs matching the two-button flow above, on explicit
// request — 'accepted'/'needs_review'/'all' are still valid filter
// values the API accepts (see index.ts's plannerStatusFilterFor), simply
// no longer surfaced as tabs here.
const FILTER_TABS: { key: PlannerListFilter; label: string }[] = [
  { key: 'queue', label: 'Siuntimui' },
  { key: 'sent', label: 'Išsiųsta' },
];

function notConfirmedTooltip(entries: PlannerTask['notConfirmedBy']): string {
  return ['Nepatvirtino:', ...entries.map((e, i) => `${i + 1}. ${e.workerName}`)].join('\n');
}

// Same numbered-list format as CellHoverEditor's own buildLinkedinBadgeTooltip
// — kept in sync by hand, per this app's usual "no module shared across
// these two surfaces" convention (they're different components, not an
// app/server boundary, but the same short-duplication reasoning applies).
function sendersTooltip(senders: PlannerTask['senders']): string {
  return ['Išsiuntė:', ...senders.map((s, i) => `${i + 1}. ${s.workerName}`)].join('\n');
}

interface TaskRowProps {
  task: PlannerTask;
  /** True while a super_admin/view_all holder is browsing "as" a specific
   * OTHER worker (LinkedInPlannerView's own worker-filter dropdown) —
   * hides the send/not-confirm action buttons entirely in that mode,
   * since /send and /not-confirmed always act as the REAL logged-in actor
   * (never the filtered-to worker), so clicking either here would record
   * the viewer's own action while looking like it belongs to whoever the
   * filter is showing — this is a read-only oversight view, not a way to
   * act on another worker's behalf. */
  viewingAsOtherWorker: boolean;
  onJumpToRow: (tableId: string, rowId: string) => void;
  onJumpToContact: (tableId: string, rowId: string, columnId: string, contactId: string) => void;
}

function TaskRow({ task, viewingAsOtherWorker, onJumpToRow, onJumpToContact }: TaskRowProps) {
  const changingStatusIds = useLinkedInPlannerStore((s) => s.changingStatusIds);
  const sendConnect = useLinkedInPlannerStore((s) => s.sendConnect);
  const markNotConfirmed = useLinkedInPlannerStore((s) => s.markNotConfirmed);
  const tables = useWorkspaceStore((s) => s.tables);
  const currentUser = useAuthStore((s) => s.user);
  const showToast = useToastStore((s) => s.show);
  const [opened, setOpened] = useState(false);
  // Instant hover tooltip for the two badges below — a native `title`
  // attribute has a real ~1s OS-level delay before it shows, reported as
  // "very slow" once these badges started carrying a real per-worker list
  // instead of just a bare count. Same portaled HoverTooltip mechanism
  // CellHoverEditor.tsx's own badges already use.
  const [hoverTooltip, setHoverTooltip] = useState<{ anchor: HTMLElement; text: string } | null>(null);

  const isBusy = changingStatusIds.has(task.id);
  // Whether to show "Kvietimas išsiųstas" vs "Nepatvirtino" now depends on
  // whether THIS specific viewer has sent — not task.status, which no
  // longer changes for the send/not-confirm flow at all (see
  // server/src/linkedinPlanner/db.ts's planner_task_sends doc comment).
  const mineSent = task.senders.some((s) => s.workerId === currentUser?.id);

  const openProfile = (e: ReactMouseEvent) => {
    setOpened(true);
    if (DEMO_MODE) {
      e.preventDefault();
      showToast('Demo režime profilio atidarymas išjungtas');
    }
  };

  // Same cross-table jump WorkersView's activity-history "→" button
  // already uses (App.tsx's jumpToTableRow/jumpToTableContact) — a
  // worker's tasks can span any table they have access to, not just
  // whichever one happens to be open right now, so this switches tables
  // first if needed before flash-highlighting the row (the same
  // highlight the Calls tab/Calendar's own jump-to-row uses). The target
  // table's contact column is resolved from useWorkspaceStore's own
  // cached TableMeta — there's normally only ever one per table (see
  // CLAUDE.md's note on Row.linkedContactId for why that assumption
  // already holds elsewhere in this app).
  const jumpToSource = () => {
    if (task.primaryContactId) {
      const table = tables.find((t) => t.id === task.primaryTableId);
      const contactColumn = table && getColumnByType(table.columns, 'contact');
      if (contactColumn) {
        onJumpToContact(task.primaryTableId, task.primaryRowId, contactColumn.id, task.primaryContactId);
        return;
      }
    }
    onJumpToRow(task.primaryTableId, task.primaryRowId);
  };

  return (
    <div className={`planner-task-row ${opened ? 'planner-task-row-opened' : ''}`} data-tutorial-id="planner-task-row">
      <div className="planner-task-info">
        <div className="planner-task-name">{task.display.name || task.normalizedLinkedinUrl}</div>
        <div className="planner-task-meta">
          {[task.display.jobTitle, task.display.companyName].filter(Boolean).join(' · ') || '—'}
        </div>
        {task.display.sourceTableName && (
          // A worker can have access to several tables at once — this
          // labels which one this specific lead came from, since one
          // shared planner list otherwise gives no hint of source.
          <div className="planner-task-source-table">{task.display.sourceTableName}</div>
        )}
        {task.notConfirmedCount > 0 && (
          // A lead sent back to the queue via "Nepatvirtino" (below)
          // shouldn't silently look brand-new the second time around —
          // this is the one visible trace of that history on the card
          // itself; hovering spells out exactly WHO clicked it and when,
          // on explicit request (not just the bare count).
          <div
            className="planner-task-not-confirmed-badge"
            onMouseEnter={(e) => setHoverTooltip({ anchor: e.currentTarget, text: notConfirmedTooltip(task.notConfirmedBy) })}
            onMouseLeave={() => setHoverTooltip(null)}
          >
            Nepatvirtino × {task.notConfirmedCount}
          </div>
        )}
        {task.senders.length > 0 && (
          // Visible to EVERY worker who can see this task, not just the
          // ones who sent themselves — the whole point is a shared view
          // of "who's already tried this person," on explicit request, so
          // a second worker taking over a table sees exactly what the
          // first one already did instead of starting from scratch.
          <div
            className="planner-task-senders"
            onMouseEnter={(e) => setHoverTooltip({ anchor: e.currentTarget, text: sendersTooltip(task.senders) })}
            onMouseLeave={() => setHoverTooltip(null)}
          >
            Išsiuntė: {task.senders.length}
          </div>
        )}
        {hoverTooltip && <HoverTooltip anchor={hoverTooltip.anchor} text={hoverTooltip.text} />}
      </div>

      <div className="planner-task-links">
        {/* Pure "look at the profile" — no side effect at all. */}
        <a
          href={DEMO_MODE ? undefined : task.display.linkedinUrl}
          target="_blank"
          rel="noreferrer"
          className="planner-open-link"
          data-tutorial-id="planner-open-profile"
          onClick={openProfile}
        >
          <ExternalLink className="icon" size={14} /> Peržiūrėti
        </a>

        {!mineSent && !viewingAsOtherWorker && (
          // The combined action: opens the SAME profile in a new tab (so
          // the actual connect gets sent by hand on LinkedIn, exactly
          // like the plain link above) AND, in the same click, records
          // THIS worker's own send — this is what moves the task out of
          // this worker's "Siuntimui" into their own "Išsiųsta".
          <a
            href={DEMO_MODE ? undefined : task.display.linkedinUrl}
            target="_blank"
            rel="noreferrer"
            className="planner-open-link planner-send-connect-link"
            onClick={(e) => {
              openProfile(e);
              if (!DEMO_MODE) void sendConnect(task.id);
            }}
          >
            <ExternalLink className="icon" size={14} /> {isBusy ? 'Žymima…' : 'Kvietimas išsiųstas'}
          </a>
        )}

        {/* Jumps to this task's real CRM row (and contact, if it has one)
            in the Table tab — the same flash-highlight jumping from a
            missed call or a calendar entry already uses. */}
        <button type="button" className="planner-open-link" title="Rasti šį kontaktą lentelėje" onClick={jumpToSource}>
          <ArrowRight className="icon" size={14} /> Rasti lentelėje
        </button>
      </div>

      {mineSent && !viewingAsOtherWorker && (
        <div className="planner-task-actions" data-tutorial-id="planner-status">
          {/* The only action on a task THIS worker has already sent:
              reverses just their own send, back into their own Siuntimui,
              and bumps the shared notConfirmedCount above. */}
          <button type="button" disabled={isBusy} onClick={() => void markNotConfirmed(task.id)}>
            {isBusy ? 'Žymima…' : 'Nepatvirtino'}
          </button>
        </div>
      )}
    </div>
  );
}

interface LinkedInPlannerViewProps {
  onJumpToRow: (tableId: string, rowId: string) => void;
  onJumpToContact: (tableId: string, rowId: string, columnId: string, contactId: string) => void;
}

export function LinkedInPlannerView({ onJumpToRow, onJumpToContact }: LinkedInPlannerViewProps) {
  const tasks = useLinkedInPlannerStore((s) => s.tasks);
  const ready = useLinkedInPlannerStore((s) => s.ready);
  const error = useLinkedInPlannerStore((s) => s.error);
  const filter = useLinkedInPlannerStore((s) => s.filter);
  const setFilter = useLinkedInPlannerStore((s) => s.setFilter);
  const search = useLinkedInPlannerStore((s) => s.search);
  const setSearch = useLinkedInPlannerStore((s) => s.setSearch);
  const tableFilter = useLinkedInPlannerStore((s) => s.tableFilter);
  const setTableFilter = useLinkedInPlannerStore((s) => s.setTableFilter);
  const workerFilter = useLinkedInPlannerStore((s) => s.workerFilter);
  const setWorkerFilter = useLinkedInPlannerStore((s) => s.setWorkerFilter);
  const tables = useWorkspaceStore((s) => s.tables);
  const refresh = useLinkedInPlannerStore((s) => s.refresh);
  const total = useLinkedInPlannerStore((s) => s.total);
  const hasMore = useLinkedInPlannerStore((s) => s.hasMore);
  const loadingMore = useLinkedInPlannerStore((s) => s.loadingMore);
  const loadMore = useLinkedInPlannerStore((s) => s.loadMore);
  const sentToday = useLinkedInPlannerStore((s) => s.sentToday);
  const dailyLimit = useLinkedInPlannerStore((s) => s.dailyLimit);
  const refreshTodayCount = useLinkedInPlannerStore((s) => s.refreshTodayCount);
  const showToast = useToastStore((s) => s.show);

  const currentUser = useAuthStore((s) => s.user);
  // Same real-admin-bypass rule as every other company-wide-oversight
  // check in this app (server's own accessibleTableIdsForPlanner) —
  // gates the "Žiūrėti kaip darbuotoją" filter below, since an ordinary
  // worker's own queue/sent is already personal to them and "view as
  // someone else" would only leak another worker's activity to them.
  const canViewAll =
    (currentUser?.role === 'super_admin' && !currentUser.impersonating) || can(currentUser?.permissionKeys, 'linkedin_planner.view_all');
  const workers = useWorkersStore((s) => s.workers);
  const loadWorkers = useWorkersStore((s) => s.load);

  useEffect(() => {
    void refresh();
    void refreshTodayCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live update — another worker claiming/sending/changing a task's status
  // used to be invisible here until a manual refresh/re-filter, a real
  // collision risk during active outreach (two people not realizing a
  // lead was already taken). refresh()/refreshTodayCount() re-run with
  // whatever filter/search/page is currently active, so this doesn't reset
  // the view, just refreshes it in place.
  useEffect(() => {
    return subscribeToCompanyEvents((event) => {
      if (event.type === 'planner_task_changed') {
        void refresh();
        void refreshTodayCount();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // GET /api/workers itself requires workers.manage, a stricter gate
    // than linkedin_planner.view_all — this can silently fail (empty
    // dropdown) for a hypothetical holder of the latter without the
    // former; not fetched at all otherwise since it's real, if narrow,
    // exposure of the company's worker roster.
    if (canViewAll && workers.length === 0) void loadWorkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canViewAll]);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);

  return (
    <div className="linkedin-planner-view" data-tutorial-id="linkedin-planner">
      <div className="linkedin-planner-header">
        <h2>LinkedIn planuoklis</h2>
        <span
          className={`linkedin-planner-counter ${sentToday >= dailyLimit ? 'linkedin-planner-counter-limit' : ''}`}
          data-tutorial-id="planner-limit-counter"
        >
          Šiandien: {sentToday} iš {dailyLimit}
        </span>
      </div>
      {sentToday >= dailyLimit && (
        <p className="instantly-hint linkedin-planner-limit-warning">
          Dienos limitas pasiektas. Rekomenduojame tęsti rytoj — LinkedIn gali apriboti paskyrą už per didelį kiekį
          kvietimų per dieną.
        </p>
      )}

      <p className="instantly-hint">
        Šis planuoklis niekada nieko nesiunčia pats — jis tik rodo, ką reikia padaryti. Paspaudę „Atidaryti“, patys
        nusiųskite kvietimą LinkedIn savo naršyklėje, tada grįžę pažymėkite, kas įvyko.
      </p>

      <div className="linkedin-planner-tabs">
        {FILTER_TABS.map((tab) => (
          <button key={tab.key} type="button" className={filter === tab.key ? 'primary' : undefined} onClick={() => setFilter(tab.key)}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Which table to work — on explicit request, since without this a
          super_admin (who sees every table's people at once) has no way
          to focus on just one at a time. */}
      <div className="linkedin-planner-table-filter">
        <select value={tableFilter ?? ''} onChange={(e) => setTableFilter(e.target.value || null)}>
          <option value="">Visos lentelės</option>
          {[...tables]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
      </div>

      {/* "Žiūrėti kaip darbuotoją" — super_admin/view_all only, on explicit
          request: check exactly which contacts a SPECIFIC worker still
          hasn't sent to (Siuntimui) or already has (Išsiųsta), instead of
          only ever seeing your own personal split. A read-only oversight
          mode — see TaskRow's own viewingAsOtherWorker doc comment for
          why the send/not-confirm buttons hide while this is active. */}
      {canViewAll && (
        <div className="linkedin-planner-worker-filter">
          <select value={workerFilter ?? ''} onChange={(e) => setWorkerFilter(e.target.value || null)}>
            <option value="">Mano (aš)</option>
            {/* "Visi" — widens Siuntimui to "niekas dar neišsiuntė" (nobody
                at all has sent yet) and Išsiųsta to "bent vienas jau
                išsiuntė" (at least one worker already has), instead of
                one specific person's own split. */}
            <option value={PLANNER_VIEW_ALL_WORKERS}>Visi</option>
            {[...workers]
              .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`))
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.firstName} {w.lastName}
                </option>
              ))}
          </select>
        </div>
      )}

      <div className="search-filter-field">
        <Search className="icon" size={14} />
        <input placeholder="Ieškoti pagal vardą ar įmonę…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {!ready && <p className="instantly-hint">Kraunama…</p>}
      {ready && tasks.length === 0 && <p className="instantly-hint">Užduočių nėra.</p>}
      {ready && tasks.length > 0 && (
        <p className="instantly-hint">
          Rodoma {tasks.length} iš {total}
        </p>
      )}

      <div className="planner-task-list">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            viewingAsOtherWorker={!!workerFilter}
            onJumpToRow={onJumpToRow}
            onJumpToContact={onJumpToContact}
          />
        ))}
      </div>

      {hasMore && (
        <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? 'Kraunama…' : 'Rodyti daugiau'}
        </button>
      )}
    </div>
  );
}
