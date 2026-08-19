import { useEffect, useMemo, useRef, useState } from 'react';
import { useCallsStore } from '../../store/useCallsStore';
import { useToastStore } from '../../store/useToastStore';
import { useTableStore } from '../../store/useTableStore';
import { phoneMatchKey } from '../../utils/phoneMatch';
import { getPrimaryLabel, getColumnByType } from '../../utils/row';
import { parseContacts, extractPhoneNumber, contactTextToFields } from '../../utils/contacts';
import { CallRow } from './CallRow';
import { CallsStatsView } from './CallsStatsView';

const MAX_RANGE_DAYS = 31;
type ViewMode = 'list' | 'stats';

function toZadarmaDatetime(dateInputValue: string, time: string): string {
  return `${dateInputValue} ${time}`;
}

function defaultDateInput(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function formatTotalDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return h > 0 ? `${h} val. ${m} min.` : `${m} min.`;
}

interface CallsViewProps {
  onJumpToRow: (rowId: string) => void;
  /** Jumps to a row *and* opens its Kontaktai editor with one specific
   * entry highlighted — used by the "🔍 Ieškoti" button below for a call
   * whose number matched a person inside a Contacts-column entry, not the
   * row's own phone column (see phoneToContact below). */
  onJumpToContact: (rowId: string, columnId: string, contactId: string) => void;
}

export function CallsView({ onJumpToRow, onJumpToContact }: CallsViewProps) {
  const calls = useCallsStore((s) => s.calls);
  const ready = useCallsStore((s) => s.ready);
  const error = useCallsStore((s) => s.error);
  const fetchCalls = useCallsStore((s) => s.fetchCalls);
  const syncCallHistory = useCallsStore((s) => s.syncCallHistory);
  const showToast = useToastStore((s) => s.show);

  const columns = useTableStore((s) => s.columns);
  const rows = useTableStore((s) => s.rows);

  const [view, setView] = useState<ViewMode>('list');

  // Today only by default — checking in on today's calls is the actual
  // common case, and it's one fewer thing to reset before every "Load
  // calls" click; widen the range manually when looking further back.
  const [startDate, setStartDate] = useState(() => defaultDateInput(0));
  const [endDate, setEndDate] = useState(() => defaultDateInput(0));

  // Zadarma caps /v1/statistics/pbx/ at 10 requests/minute — a real limit
  // hit in practice while adjusting the date range and re-clicking "Load
  // calls" a few times in quick succession. A ~7s cooldown between loads
  // keeps normal use comfortably under that (< 9/min) without being
  // annoying for a tab that's "load once, work with it" by nature.
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const rangeDays = Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000);
  const rangeTooLong = rangeDays > MAX_RANGE_DAYS;

  const load = () => {
    if (rangeTooLong || cooldown > 0) return;
    void fetchCalls(toZadarmaDatetime(startDate, '00:00:00'), toZadarmaDatetime(endDate, '23:59:59'));
    setCooldown(7);
  };

  // load() fires a fetch synchronously the instant the effect body runs —
  // not deferred behind a promise the way syncCallHistory below is — so
  // React StrictMode's dev-only mount→cleanup→mount double-invoke (done
  // deliberately, to help surface missing-cleanup bugs) calls it *twice*
  // in the same synchronous tick, before the first call's setCooldown(7)
  // has actually re-rendered. Both invocations see the same stale
  // cooldown === 0 and both fire — two real requests, not one. A ref
  // survives StrictMode's simulated unmount/remount (it doesn't tear down
  // the fiber, just re-invokes the effect callbacks), but correctly resets
  // on a genuine remount later (leaving the Calls tab and coming back,
  // which really does unmount CallsView — see the tab switch in App.tsx),
  // so this guard only suppresses the fake double-fire, not a real re-open.
  const hasAutoLoadedRef = useRef(false);
  useEffect(() => {
    if (!hasAutoLoadedRef.current) {
      hasAutoLoadedRef.current = true;
      load();
    }
    // Independent of the list load above — grows the persistent local
    // history (Statistics view) in the background, separate from whatever
    // date range happens to be picked here. Deliberately delayed by the
    // same 7s cooldown used everywhere else in this file, NOT fired in the
    // same instant as load() — both hit the same 10-req/min-capped Zadarma
    // endpoint, and starting them simultaneously on every Calls-tab mount
    // was, on its own, enough to trip the rate limit before any manual
    // interaction at all (a real, reported bug: the "wait a moment" toast
    // showing up on a tab that had just been opened, nothing clicked yet).
    // This one doesn't need the ref guard above — setTimeout + the
    // cleanup's clearTimeout already make it StrictMode-safe on their own,
    // since the throwaway invocation's cleanup cancels its own timer
    // before it ever fires.
    const timer = setTimeout(() => void syncCallHistory(), 7000);
    return () => clearTimeout(timer);
    // Auto-load the default window once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);

  // Maps a phone-number match key (see utils/phoneMatch.ts) to the row it
  // came from, built from every `phone`-type column across the active
  // table — so a call's destination can be linked back to "the" company
  // row without needing an explicit, user-maintained link anywhere. Carries
  // the company label alongside the id so CallRow doesn't need its own
  // useTableStore lookup just to show which company matched.
  const phoneToRow = useMemo(() => {
    const map = new Map<string, { rowId: string; label: string }>();
    const phoneColumns = columns.filter((c) => c.type === 'phone');
    if (phoneColumns.length === 0) return map;
    for (const row of rows) {
      for (const col of phoneColumns) {
        const key = phoneMatchKey(row.cells[col.id] ?? '');
        if (key) map.set(key, { rowId: row.id, label: getPrimaryLabel(row, columns) });
      }
    }
    return map;
  }, [columns, rows]);

  // Same idea as phoneToRow above, but one level more specific: a missed
  // call's number often belongs to a *person*, not the row's own Phone
  // column (a company usually has one Phone field but a Contacts column
  // can hold several people, each with their own number embedded in
  // freeform text) — added on explicit request ("я хочу быстро найти в
  // моих контактах, о кого именно я пропустил звонок"). Scans every entry
  // of the table's one contact-type column (see CLAUDE.md: at most one in
  // practice), pulling a phone-shaped number out of each entry's freeform
  // text via extractPhoneNumber() — the same regex the click-to-call
  // buttons in CellHoverEditor already use for this exact purpose.
  const phoneToContact = useMemo(() => {
    const map = new Map<string, { rowId: string; columnId: string; contactId: string; label: string }>();
    const contactColumn = getColumnByType(columns, 'contact');
    if (!contactColumn) return map;
    for (const row of rows) {
      const raw = row.cells[contactColumn.id];
      if (!raw) continue;
      for (const entry of parseContacts(raw)) {
        const phone = extractPhoneNumber(entry.text);
        if (!phone) continue;
        const key = phoneMatchKey(phone);
        if (!key) continue;
        const { firstName, lastName } = contactTextToFields(entry.text);
        const label = [firstName, lastName].filter(Boolean).join(' ') || entry.text;
        map.set(key, { rowId: row.id, columnId: contactColumn.id, contactId: entry.id, label });
      }
    }
    return map;
  }, [columns, rows]);

  const summary = useMemo(() => {
    if (calls.length === 0) return null;
    const totalSeconds = calls.reduce((sum, c) => sum + c.seconds, 0);
    const answered = calls.filter((c) => c.disposition === 'answered').length; // raw API value — never translate
    const recorded = calls.filter((c) => c.is_recorded).length;
    return { count: calls.length, totalSeconds, answered, recorded };
  }, [calls]);

  return (
    <div className="calls-view">
      <div className="calls-mode-switch">
        <button type="button" className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
          Skambučiai
        </button>
        <button type="button" className={view === 'stats' ? 'active' : ''} onClick={() => setView('stats')}>
          Statistika
        </button>
      </div>

      {view === 'stats' ? (
        <CallsStatsView />
      ) : (
        <>
      <div className="calls-toolbar">
        <label>
          Nuo{' '}
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label>
          Iki <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </label>
        <button type="button" onClick={load} disabled={rangeTooLong || cooldown > 0}>
          {cooldown > 0 ? `Palaukite ${cooldown} s…` : 'Įkelti skambučius'}
        </button>
        {rangeTooLong && <span className="calls-range-error">Laikotarpis negali viršyti {MAX_RANGE_DAYS} dienų.</span>}
        {summary && (
          <span className="calls-summary">
            Skambučių: {summary.count} · Trukmė: {formatTotalDuration(summary.totalSeconds)} · Atsakyta:{' '}
            {summary.answered} · Įrašyta: {summary.recorded}
          </span>
        )}
      </div>

      {!ready ? (
        <div className="app-loading">
          <span>Kraunama…</span>
        </div>
      ) : calls.length === 0 ? (
        <div className="empty-state">{error ? error : 'Šiuo laikotarpiu skambučių nerasta.'}</div>
      ) : (
        <table className="calls-table">
          <thead>
            <tr>
              <th>Data / laikas</th>
              <th>Vidinis numeris</th>
              <th>Numeris</th>
              <th>Trukmė</th>
              <th>Būsena</th>
              <th>Veiksmai</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => {
              const key = phoneMatchKey(call.otherParty);
              const matched = key ? phoneToRow.get(key) : undefined;
              const matchedContact = key ? phoneToContact.get(key) : undefined;
              return (
                <CallRow
                  key={call.call_id}
                  call={call}
                  matchedRow={matched}
                  matchedContact={matchedContact}
                  onJumpToRow={onJumpToRow}
                  onJumpToContact={onJumpToContact}
                />
              );
            })}
          </tbody>
        </table>
      )}
        </>
      )}
    </div>
  );
}
