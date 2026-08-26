import { useEffect, useMemo, useRef, useState } from 'react';
import { useCallsStore } from '../../store/useCallsStore';
import { useToastStore } from '../../store/useToastStore';
import { useTableStore } from '../../store/useTableStore';
import { phoneMatchKey } from '../../utils/phoneMatch';
import { buildPhoneIndex } from '../../utils/rowPhoneIndex';
import { CallRow } from './CallRow';
import { CallsStatsView } from './CallsStatsView';
import { SmsInboxView } from './SmsInboxView';

const MAX_RANGE_DAYS = 31;
type ViewMode = 'list' | 'stats' | 'sms';

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
  const balance = useCallsStore((s) => s.balance);
  const fetchBalance = useCallsStore((s) => s.fetchBalance);
  const costs = useCallsStore((s) => s.costs);
  const costsLoading = useCallsStore((s) => s.costsLoading);
  const costsError = useCallsStore((s) => s.costsError);
  const fetchCosts = useCallsStore((s) => s.fetchCosts);
  const showToast = useToastStore((s) => s.show);

  const columns = useTableStore((s) => s.columns);
  const rows = useTableStore((s) => s.rows);

  const [view, setView] = useState<ViewMode>('list');

  // Today only by default — checking in on today's calls is the actual
  // common case, and it's one fewer thing to reset before every "Load
  // calls" click; widen the range manually when looking further back.
  const [startDate, setStartDate] = useState(() => defaultDateInput(0));
  const [endDate, setEndDate] = useState(() => defaultDateInput(0));

  const rangeDays = Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86_400_000);
  const rangeTooLong = rangeDays > MAX_RANGE_DAYS;

  // Loads the call list and its costs together — on explicit request, one
  // button doing both rather than a separate "Rodyti kainas" step. costs
  // fetch is sequenced *after* calls resolves (fetchCosts reads the
  // store's freshly-updated `calls` to know what to correlate against —
  // see useCallsStore's own fetchCosts), not fired in parallel.
  //
  // No forced cooldown on this button — removed on explicit request ("aš
  // pats galiu palaukti", i.e. the user prefers to pace their own clicks
  // rather than have the UI force a wait). Zadarma's 10 req/min cap on
  // /v1/statistics/(pbx)/ is unchanged and still enforced server-side —
  // clicking faster than that just surfaces the existing rate-limit toast
  // (see fetchCalls's error handling in useCallsStore.ts), it doesn't skip
  // the limit, only the client-side nag about it.
  const load = async () => {
    if (rangeTooLong) return;
    const start = toZadarmaDatetime(startDate, '00:00:00');
    const end = toZadarmaDatetime(endDate, '23:59:59');
    await fetchCalls(start, end);
    void fetchCosts(start, end);
  };

  // load() fires a fetch synchronously the instant the effect body runs
  // (the `await` inside it doesn't change that) — so React StrictMode's
  // dev-only mount→cleanup→mount double-invoke (done deliberately, to help
  // surface missing-cleanup bugs) calls it *twice* in the same synchronous
  // tick. A ref survives StrictMode's simulated unmount/remount (it
  // doesn't tear down the fiber, just re-invokes the effect callbacks),
  // but correctly resets on a genuine remount later (leaving the Calls tab
  // and coming back, which really does unmount CallsView — see the tab
  // switch in App.tsx), so this guard only suppresses the fake
  // double-fire, not a real re-open.
  const hasAutoLoadedRef = useRef(false);
  useEffect(() => {
    if (!hasAutoLoadedRef.current) {
      hasAutoLoadedRef.current = true;
      void load();
    }
    // Independent of the list load above — grows the persistent local
    // history (Statistics view) in the background, separate from whatever
    // date range happens to be picked here. Deliberately delayed by a
    // fixed 7s stagger, NOT fired in the same instant as load() — both hit
    // the same 10-req/min-capped Zadarma
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

  useEffect(() => {
    if (costsError) showToast(costsError);
  }, [costsError, showToast]);

  // Not a statistics-endpoint call (see useCallsStore's fetchBalance) — no
  // StrictMode-double-fire guard needed here the way load() above needs
  // one; a duplicate balance fetch under React StrictMode's dev-only
  // double-invoke is harmless (100/minute limit, one extra request is
  // nothing), unlike load() sharing the 10/minute statistics budget.
  useEffect(() => {
    void fetchBalance();
    // Fetch once per mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Maps a phone-number match key (see utils/phoneMatch.ts) to the row/
  // contact it came from — built once here and reused by
  // IncomingCallBanner.tsx for the live-ringing case, see
  // utils/rowPhoneIndex.ts's own doc comment for the shared shape/
  // reasoning (phoneToRow from `phone`-type columns, phoneToContact from
  // a person embedded in a `contact`-type column's freeform text).
  const { phoneToRow, phoneToContact } = useMemo(() => buildPhoneIndex(columns, rows), [columns, rows]);

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
        <button type="button" className={view === 'sms' ? 'active' : ''} onClick={() => setView('sms')}>
          Gaunamos SMS
        </button>
        {balance && (
          <span className="calls-balance" title="Likutis sąskaitoje">
            {balance.amount} {balance.currency}
          </span>
        )}
      </div>

      {view === 'stats' ? (
        <CallsStatsView />
      ) : view === 'sms' ? (
        <SmsInboxView
          phoneToRow={phoneToRow}
          phoneToContact={phoneToContact}
          onJumpToRow={onJumpToRow}
          onJumpToContact={onJumpToContact}
        />
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
        <button type="button" onClick={() => void load()} disabled={rangeTooLong}>
          {costsLoading ? 'Kraunama kainas…' : 'Įkelti skambučius'}
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
              <th>Kaina</th>
              <th>Būsena</th>
              <th>Veiksmai</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => {
              const key = phoneMatchKey(call.otherParty);
              const matched = key ? phoneToRow.get(key) : undefined;
              const matchedContact = key ? phoneToContact.get(key) : undefined;
              const cost = costs[call.call_id];
              return (
                <CallRow
                  key={call.call_id}
                  call={call}
                  cost={cost}
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
