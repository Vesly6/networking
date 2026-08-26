import { create } from 'zustand';
import {
  fetchCalls as apiFetchCalls,
  fetchBalance as apiFetchBalance,
  fetchCallCosts as apiFetchCallCosts,
  fetchRecording as apiFetchRecording,
  transcribeCall as apiTranscribeCall,
  summarizeCall as apiSummarizeCall,
  type CallRecord,
  type TranscriptionResult,
} from '../utils/callsApi';
import { getTranscription, saveTranscription, saveCallStats, getLatestCallStatDate } from '../db/db';
import { toCallStatRecord, addDays, todayDateString } from '../utils/callStats';

interface CallsState {
  calls: CallRecord[];
  ready: boolean;
  error: string | null;
  fetchCalls: (start: string, end: string) => Promise<void>;

  balance: { amount: string; currency: string } | null;
  balanceError: string | null;
  /** Not a statistics-endpoint call (see server/src/zadarma.ts's
   * getBalance) — safe to call freely, no cooldown needed unlike
   * fetchCalls/fetchCosts. */
  fetchBalance: () => Promise<void>;

  /** Keyed by `${callstart}|${sip}` — see callsApi.ts's fetchCallCosts.
   * A separate, explicit action (CallsView's "Rodyti kainas" button)
   * rather than something fetchCalls triggers automatically, since it's a
   * second real hit against the same 10-req/minute Zadarma statistics
   * budget for whatever date range is currently loaded. */
  costs: Record<string, { billcost: string; currency: string }>;
  costsLoading: boolean;
  costsError: string | null;
  fetchCosts: (start: string, end: string) => Promise<void>;

  recordingLinks: Record<string, string>;
  recordingErrors: Record<string, string>;
  fetchRecording: (callId: string) => Promise<void>;

  transcripts: Record<string, TranscriptionResult>;
  transcribingIds: Record<string, boolean>;
  transcribeErrors: Record<string, string>;
  transcribe: (callId: string) => Promise<void>;
  hydrateTranscription: (callId: string) => Promise<void>;

  summarizingIds: Record<string, boolean>;
  summarizeErrors: Record<string, string>;
  /** No-ops if this call hasn't been transcribed yet — summarize() derives
   * from transcripts[callId].text, it never transcribes on its own (that
   * stays an explicit, separate, real-money action via transcribe()
   * above). The Summary button in CallRow.tsx is only ever shown once a
   * transcript already exists, so in practice this guard should never
   * actually trigger from the UI — it's here for callers, not users. */
  summarize: (callId: string) => Promise<void>;

  historySyncing: boolean;
  historySyncProgress: { done: number; total: number } | null;
  historySyncError: string | null;
  /** Quietly grows the local `callStats` history (db.ts) from wherever it
   * last left off up through today — see the long comment above
   * buildBackfillChunks() below for why this exists and how it stays
   * under Zadarma's rate limit. Safe to call every time the Calls tab
   * mounts: a no-op finishes instantly once there's nothing new to fetch. */
  syncCallHistory: () => Promise<void>;
}

// A first-ever sync (no local history at all) reaches back this far. The
// user's own understanding of Zadarma's retention window was the reason
// this feature exists at all ("save it before it's gone") — 90 days
// matches that directly. If Zadarma's actual window turns out to be
// shorter, those earlier requests just come back empty; nothing breaks.
const BACKFILL_DEFAULT_DAYS = 90;
// Matches the server's own per-request validation (see DATE_RE/the 31-day
// check in server/src/index.ts) — a wider single request would just 400.
const BACKFILL_CHUNK_DAYS = 31;
// Same spacing as CallsView's manual "Load calls" cooldown, same reason:
// Zadarma caps /v1/statistics/pbx/ at 10 requests/minute.
const BACKFILL_COOLDOWN_MS = 7000;
// Guards against re-running the whole chunked fetch sequence every time
// the user flips back to the Calls tab within the same minute (switching
// tabs a few times while triaging calls is normal usage, not a signal
// that history needs re-syncing). Module-level, not store state — nothing
// in the UI needs to react to *when* the last attempt was, only to
// historySyncing itself.
const SYNC_RETRY_GAP_MS = 60_000;
let lastSyncAttemptAt = 0;

function toZadarmaDatetime(date: string, time: string): string {
  return `${date} ${time}`;
}

/** Splits [fromDate, toDate] (yyyy-MM-dd, inclusive) into ≤31-day chunks
 * for sequential fetching. */
function buildBackfillChunks(fromDate: string, toDate: string): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = [];
  let chunkStart = fromDate;
  while (chunkStart <= toDate) {
    const chunkEnd = addDays(chunkStart, BACKFILL_CHUNK_DAYS - 1);
    const clampedEnd = chunkEnd > toDate ? toDate : chunkEnd;
    chunks.push({
      start: toZadarmaDatetime(chunkStart, '00:00:00'),
      end: toZadarmaDatetime(clampedEnd, '23:59:59'),
    });
    chunkStart = addDays(clampedEnd, 1);
  }
  return chunks;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const useCallsStore = create<CallsState>((set, get) => ({
  calls: [],
  ready: false,
  error: null,
  fetchCalls: async (start, end) => {
    set({ ready: false, error: null });
    try {
      const { stats } = await apiFetchCalls(start, end);
      set({ calls: stats, ready: true });
      // Every manual load also feeds the persistent local history — not
      // just the background sync below. A manual load for some arbitrary
      // past range (outside what the background sync would have reached)
      // still ends up saved, same as anything else.
      void saveCallStats(stats.map(toCallStatRecord));
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Could not load calls';
      // Zadarma's own message ("You exceeded the rate limit by User
      // Limits") is accurate but easy to misread as a real failure —
      // reframe it as the transient, waitable thing it actually is.
      const message = /rate limit/i.test(raw)
        ? 'The calls service limits statistics requests to 10/minute — wait a moment and try again.'
        : raw;
      set({ error: message, ready: true });
    }
  },

  balance: null,
  balanceError: null,
  fetchBalance: async () => {
    try {
      const { balance, currency } = await apiFetchBalance();
      set({ balance: { amount: balance, currency }, balanceError: null });
    } catch (err) {
      set({ balanceError: err instanceof Error ? err.message : 'Could not load balance' });
    }
  },

  costs: {},
  costsLoading: false,
  costsError: null,
  fetchCosts: async (start, end) => {
    set({ costsLoading: true, costsError: null });
    try {
      const callList = get().calls.map((c) => ({ call_id: c.call_id, callstart: c.callstart }));
      const costs = await apiFetchCallCosts(start, end, callList);
      set((s) => ({ costs: { ...s.costs, ...costs }, costsLoading: false }));
    } catch (err) {
      const raw = err instanceof Error ? err.message : 'Could not load call costs';
      const message = /rate limit/i.test(raw)
        ? 'The calls service limits statistics requests to 10/minute — wait a moment and try again.'
        : raw;
      set({ costsError: message, costsLoading: false });
    }
  },

  recordingLinks: {},
  recordingErrors: {},
  fetchRecording: async (callId) => {
    try {
      const info = await apiFetchRecording(callId);
      const link = info.link ?? info.links?.[0];
      if (!link) throw new Error('No recording available for this call');
      set((s) => ({ recordingLinks: { ...s.recordingLinks, [callId]: link } }));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not fetch recording';
      set((s) => ({ recordingErrors: { ...s.recordingErrors, [callId]: message } }));
    }
  },

  transcripts: {},
  transcribingIds: {},
  transcribeErrors: {},
  transcribe: async (callId) => {
    set((s) => ({
      transcribingIds: { ...s.transcribingIds, [callId]: true },
      transcribeErrors: { ...s.transcribeErrors, [callId]: '' },
    }));
    try {
      const result = await apiTranscribeCall(callId);
      set((s) => ({ transcripts: { ...s.transcripts, [callId]: result } }));
      void saveTranscription({ callId, ...result, savedAt: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not transcribe this call';
      set((s) => ({ transcribeErrors: { ...s.transcribeErrors, [callId]: message } }));
    } finally {
      set((s) => {
        const transcribingIds = { ...s.transcribingIds };
        delete transcribingIds[callId];
        return { transcribingIds };
      });
    }
  },
  hydrateTranscription: async (callId) => {
    if (get().transcripts[callId]) return;
    const cached = await getTranscription(callId);
    if (cached) {
      set((s) => ({ transcripts: { ...s.transcripts, [callId]: { text: cached.text, summary: cached.summary } } }));
    }
  },

  summarizingIds: {},
  summarizeErrors: {},
  summarize: async (callId) => {
    const text = get().transcripts[callId]?.text;
    if (!text) return;
    set((s) => ({
      summarizingIds: { ...s.summarizingIds, [callId]: true },
      summarizeErrors: { ...s.summarizeErrors, [callId]: '' },
    }));
    try {
      const { summary } = await apiSummarizeCall(callId, text);
      set((s) => ({ transcripts: { ...s.transcripts, [callId]: { ...s.transcripts[callId], summary } } }));
      void saveTranscription({ callId, text, summary, savedAt: Date.now() });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not summarize this call';
      set((s) => ({ summarizeErrors: { ...s.summarizeErrors, [callId]: message } }));
    } finally {
      set((s) => {
        const summarizingIds = { ...s.summarizingIds };
        delete summarizingIds[callId];
        return { summarizingIds };
      });
    }
  },

  historySyncing: false,
  historySyncProgress: null,
  historySyncError: null,
  syncCallHistory: async () => {
    if (get().historySyncing) return;
    const now = Date.now();
    if (now - lastSyncAttemptAt < SYNC_RETRY_GAP_MS) return;
    lastSyncAttemptAt = now;

    const latest = await getLatestCallStatDate();
    const today = todayDateString();
    // Resume the day *after* the last thing we have, so an already-synced
    // day never gets re-fetched — except there's nothing to resume from
    // yet, this is a first-ever sync, reach back the full default window.
    const from = latest ? addDays(latest.slice(0, 10), 1) : addDays(today, -BACKFILL_DEFAULT_DAYS);
    if (from > today) return; // already synced through today

    const chunks = buildBackfillChunks(from, today);
    set({ historySyncing: true, historySyncProgress: { done: 0, total: chunks.length }, historySyncError: null });
    try {
      for (let i = 0; i < chunks.length; i++) {
        const { stats } = await apiFetchCalls(chunks[i].start, chunks[i].end);
        await saveCallStats(stats.map(toCallStatRecord));
        set({ historySyncProgress: { done: i + 1, total: chunks.length } });
        // No delay after the last chunk — nothing left to wait out for.
        if (i < chunks.length - 1) await sleep(BACKFILL_COOLDOWN_MS);
      }
    } catch (err) {
      // Quiet by design — this runs in the background on every Calls tab
      // visit, and a transient failure (rate limit, network blip) will
      // just get picked up on the next visit via the same watermark. No
      // toast; historySyncError exists for the stats view to show a small
      // inline note if useful, not to interrupt anything.
      set({ historySyncError: err instanceof Error ? err.message : 'Could not sync call history' });
    } finally {
      set({ historySyncing: false, historySyncProgress: null });
    }
  },
}));
