import { useEffect, useMemo, useState } from 'react';
import { useCallsStore } from '../../store/useCallsStore';
import { useToastStore } from '../../store/useToastStore';
import { getAllCallStats, saveCallStats } from '../../db/db';
import { fetchCallCosts } from '../../utils/callsApi';
import {
  addDays,
  addMonths,
  bucketByDay,
  dayOfWeek,
  formatDuration,
  monthRange,
  summarize,
  todayDateString,
  weekRange,
  type CallStatRecord,
} from '../../utils/callStats';
import { BarChart, type BarChartPoint } from './BarChart';
import { ArrowLeft, ArrowRight } from 'lucide-react';

type Period = 'week' | 'month';

const WEEKDAY_LABELS = ['Pr', 'An', 'Tr', 'Kt', 'Pn', 'Št', 'Sk'];

function dayLabel(date: string, period: Period): string {
  if (period === 'week') return WEEKDAY_LABELS[dayOfWeek(date)];
  return String(Number(date.slice(8, 10)));
}

function rangeTitle(start: string, end: string, period: Period): string {
  const fmt = (d: string) =>
    new Date(`${d}T00:00:00`).toLocaleDateString('lt-LT', { month: 'short', day: 'numeric', year: 'numeric' });
  if (period === 'month') {
    return new Date(`${start}T00:00:00`).toLocaleDateString('lt-LT', { month: 'long', year: 'numeric' });
  }
  return `${fmt(start)} – ${fmt(end)}`;
}

/** Reads the locally-persisted call history (db.ts's `callStats` store,
 * kept fresh by useCallsStore's background syncCallHistory + every manual
 * "Load calls") — deliberately independent of the live `calls` list above
 * it in the Calls tab, which is scoped to whatever date range is currently
 * picked there. This view is what survives Zadarma's own statistics
 * eventually aging out; see the long comment on syncCallHistory for why
 * that's the whole point of this feature. */
export function CallsStatsView() {
  const historySyncing = useCallsStore((s) => s.historySyncing);
  const historySyncProgress = useCallsStore((s) => s.historySyncProgress);
  const showToast = useToastStore((s) => s.show);

  const [records, setRecords] = useState<CallStatRecord[] | null>(null);
  const [period, setPeriod] = useState<Period>('week');
  const [anchorDate, setAnchorDate] = useState(() => todayDateString());
  const [costsLoading, setCostsLoading] = useState(false);

  useEffect(() => {
    void getAllCallStats().then(setRecords);
    // Re-read once a background sync finishes — historySyncing flipping
    // false->true->false brackets exactly one sync run.
  }, [historySyncing]);

  const { start, end } = useMemo(
    () => (period === 'week' ? weekRange(anchorDate) : monthRange(anchorDate)),
    [period, anchorDate],
  );

  const periodRecords = useMemo(() => {
    if (!records) return [];
    return records.filter((r) => {
      const d = r.callstart.slice(0, 10);
      return d >= start && d <= end;
    });
  }, [records, start, end]);

  const summary = useMemo(() => summarize(periodRecords), [periodRecords]);

  // Reuses the exact same /api/calls/costs endpoint (and its nearest-
  // timestamp correlation — see server/src/zadarma.ts's getCallCosts) the
  // live Calls list's "Įkelti skambučius" now also fetches, just pointed
  // at this period's *locally persisted* records (db.ts's `callStats`
  // store) instead of the live list. Results are written straight back
  // onto those same records via saveCallStats — an ordinary field update
  // by call_id, the same upsert every other write to this store already
  // does — so once run for a period, its cost stays known on every future
  // visit without needing to be re-fetched, matching the "local,
  // permanent copy" reasoning this whole feature exists for. Deliberately
  // a separate, explicit action (not automatic on period change) — same
  // "don't multiply an already rate-limited request" caution as the live
  // list's own cost fetch.
  const loadCosts = async () => {
    if (costsLoading || periodRecords.length === 0) return;
    setCostsLoading(true);
    try {
      const costs = await fetchCallCosts(
        `${start} 00:00:00`,
        `${end} 23:59:59`,
        periodRecords.map((r) => ({ call_id: r.call_id, callstart: r.callstart })),
      );
      const updated = periodRecords.map((r) => (costs[r.call_id] ? { ...r, ...costs[r.call_id] } : r));
      await saveCallStats(updated);
      const updatedById = new Map(updated.map((r) => [r.call_id, r]));
      setRecords((prev) => (prev ? prev.map((r) => updatedById.get(r.call_id) ?? r) : prev));
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Nepavyko įkelti išlaidų';
      showToast(/rate limit/i.test(raw) ? 'Skambučių paslauga riboja užklausas — palaukite ir bandykite dar kartą.' : raw);
    } finally {
      setCostsLoading(false);
    }
  };

  // The background sync stops at the first chunk that fails (rate limit,
  // network blip) rather than skipping ahead — skipping would let a
  // *later* chunk succeed and advance the watermark past a chunk that
  // never actually synced, silently baking a permanent gap into the
  // "resume from the watermark" logic. The tradeoff: catching up from a
  // long-untouched account can take a few tab visits, not one — worth
  // saying so explicitly, since a stretch of zeros right after first
  // opening this view otherwise reads as "no calls," not "still loading."
  const latestSyncedDate = useMemo(() => {
    if (!records || records.length === 0) return null;
    return records.reduce((max, r) => (r.callstart > max ? r.callstart : max), records[0].callstart).slice(0, 10);
  }, [records]);
  const today = todayDateString();
  const catchingUp = !historySyncing && latestSyncedDate !== null && latestSyncedDate < addDays(today, -1);

  const chartData: BarChartPoint[] = useMemo(() => {
    return bucketByDay(periodRecords, start, end).map((b) => ({
      label: dayLabel(b.date, period),
      fullLabel: `${b.date}: skambučių ${b.total}, atsakyta ${b.answered}, ${formatDuration(b.seconds)}`,
      total: b.total,
      answered: b.answered,
    }));
  }, [periodRecords, start, end, period]);

  const shift = (dir: 1 | -1) => {
    setAnchorDate(period === 'week' ? addDays(anchorDate, dir * 7) : addMonths(anchorDate, dir));
  };

  if (records !== null && records.length === 0 && !historySyncing) {
    return (
      <div className="calls-stats-view">
        <div className="empty-state">
          Kol kas nėra lokaliai išsaugotos skambučių istorijos. Atidarykite skambučių skirtuką turėdami įprastą
          interneto ryšį, ir duomenys pradės pildytis automatiškai — patikrinkite po minutės.
        </div>
      </div>
    );
  }

  return (
    <div className="calls-stats-view">
      <div className="calls-stats-toolbar">
        <div className="calls-stats-period-toggle">
          <button type="button" className={period === 'week' ? 'active' : ''} onClick={() => setPeriod('week')}>
            Savaitė
          </button>
          <button type="button" className={period === 'month' ? 'active' : ''} onClick={() => setPeriod('month')}>
            Mėnuo
          </button>
        </div>
        <div className="calls-stats-range-nav">
          <button type="button" onClick={() => shift(-1)} title="Ankstesnis">
            <ArrowLeft className="icon" size={16} />
          </button>
          <span className="calls-stats-range-title">{rangeTitle(start, end, period)}</span>
          <button type="button" onClick={() => shift(1)} title="Kitas">
            <ArrowRight className="icon" size={16} />
          </button>
        </div>
        {historySyncing && historySyncProgress && (
          <span className="calls-stats-syncing">
            Sinchronizuojama istorija… {historySyncProgress.done}/{historySyncProgress.total}
          </span>
        )}
        {catchingUp && (
          <span className="calls-stats-syncing" title="Skambučių paslauga riboja, kaip greitai galime atsisiųsti istoriją — tai automatiškai pasivys per kelis kitus apsilankymus šiame skirtuke.">
            Lokali istorija sinchronizuota iki {latestSyncedDate} — dar vejamasi
          </span>
        )}
        <button
          type="button"
          className="calls-stats-load-costs"
          onClick={() => void loadCosts()}
          disabled={costsLoading || periodRecords.length === 0}
        >
          {costsLoading ? 'Kraunama išlaidas…' : 'Rodyti išlaidas'}
        </button>
      </div>

      <div className="calls-stats-cards">
        <div className="calls-stats-card">
          <div className="calls-stats-card-value">{summary.totalCalls}</div>
          <div className="calls-stats-card-label">Skambučiai</div>
        </div>
        <div className="calls-stats-card">
          <div className="calls-stats-card-value">{summary.answered}</div>
          <div className="calls-stats-card-label">Atsakyta</div>
        </div>
        <div className="calls-stats-card">
          <div className="calls-stats-card-value">{Math.round(summary.answerRate * 100)}%</div>
          <div className="calls-stats-card-label">Atsakymo dažnis</div>
        </div>
        <div className="calls-stats-card">
          <div className="calls-stats-card-value">{formatDuration(summary.totalSeconds)}</div>
          <div className="calls-stats-card-label">Pokalbio trukmė</div>
        </div>
        <div className="calls-stats-card">
          <div className="calls-stats-card-value">
            {summary.totalCost === null ? '—' : `${summary.totalCost.toFixed(2)} ${summary.currency}`}
          </div>
          <div className="calls-stats-card-label">
            Išlaidos
            {summary.totalCost !== null && summary.callsWithoutCost > 0 && (
              <span title="Dalis šio laikotarpio skambučių dar neturi žinomos kainos (nepavyko susieti su Zadarma sąskaitos duomenimis).">
                {' '}
                (dar {summary.callsWithoutCost} be kainos)
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="calls-stats-chart">
        <BarChart data={chartData} />
        <div className="calls-bar-chart-legend">
          <span>
            <i className="calls-bar-chart-swatch calls-bar-chart-swatch-total" /> Skambučiai
          </span>
          <span>
            <i className="calls-bar-chart-swatch calls-bar-chart-swatch-answered" /> Atsakyta
          </span>
        </div>
      </div>
    </div>
  );
}
