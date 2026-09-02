import { Fragment, useEffect, useState } from 'react';
import { format } from 'date-fns';
import { lt } from 'date-fns/locale';
import { localApiRequest } from '../../utils/localApi';
import { RefreshCw } from 'lucide-react';

/** Mirrors server/src/instantlyWebhookLog/db.ts's WebhookEventRecord —
 * timestamps as epoch ms, everything else as the server already resolved
 * it (no client-side re-derivation of outcome/timing). */
interface WebhookEventRecord {
  id: string;
  eventType: string | null;
  campaignId: string | null;
  rawBody: string;
  receivedAt: number;
  responseStatus: number | null;
  responseSentAt: number | null;
  processingStartedAt: number | null;
  processingFinishedAt: number | null;
  outcome: 'ignored' | 'no_api_key' | 'coalesced' | 'success' | 'error' | null;
  errorMessage: string | null;
  repliesFound: number | null;
  rowsCreated: number | null;
  skippedDuplicate: number | null;
  tableId: string | null;
  tableName: string | null;
}

const OUTCOME_LABELS: Record<string, string> = {
  success: 'Sėkmingai',
  error: 'Klaida',
  coalesced: 'Laukė eilėje',
  ignored: 'Ignoruotas',
  no_api_key: 'Nėra API rakto',
};
const OUTCOME_COLORS: Record<string, string> = {
  success: '#2fae5c',
  error: '#e5484d',
  coalesced: '#e08a2b',
  ignored: '#8a8f98',
  no_api_key: '#8a8f98',
};

function fmtTime(ms: number | null): string {
  if (!ms) return '—';
  return format(ms, 'HH:mm:ss.SSS', { locale: lt });
}

/** ms between two timestamps, or null if either is missing — null renders
 * as "—" rather than a misleading "0ms" or negative number. */
function deltaMs(from: number | null, to: number | null): number | null {
  if (!from || !to) return null;
  return to - from;
}

function fmtDelta(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** rawBody is always our own JSON.stringify of Instantly's real payload
 * (see index.ts's webhook route) so this should never fail — falls back
 * to the plain string rather than throwing if it somehow isn't valid
 * JSON, same "never trust wire data" caution as everywhere else this app
 * parses something it didn't generate itself. */
function formatRawBody(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** "Webhook žurnalas" — a real, timestamped record of every Instantly
 * reply webhook this server has received for this company, added after a
 * real, reported incident: the webhook route used to only log via
 * console.log/console.error, which isn't visible or queryable in
 * production, so there was no way to tell whether a given reply's webhook
 * even arrived, let alone where in the pipeline it stalled. Each row here
 * is exactly the chain the user asked to see:
 * gauta (received) -> atsakyta (HTTP ack sent) -> apdorojimas pradėtas
 * (processing started — may lag behind "gauta" if another campaign's sync
 * for this company was already running, see "Laukė eilėje") ->
 * apdorojimas baigtas (processing finished), with the outcome and,
 * for a successful sync, which table/how many rows it actually wrote. */
export function WebhookLogPanel() {
  const [events, setEvents] = useState<WebhookEventRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Which row's raw JSON body is expanded, if any — added specifically to
  // diagnose "Ignoruotas" rows: the ignore check is `eventType !==
  // 'reply_received' || !campaignId`, so seeing the *actual* raw payload
  // Instantly sent (not just our own guess at its shape, documented as
  // unverified in instantlyReplySync.ts's own doc comment) is the only
  // way to tell whether that check's assumptions about Instantly's field
  // names/values still hold.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    localApiRequest<{ events: WebhookEventRecord[] }>('/api/instantly/webhook-log?limit=100')
      .then((r) => setEvents(r.events))
      .catch((err) => setError(err instanceof Error ? err.message : 'Nepavyko įkelti žurnalo'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    // Load once on mount — a manual "Atnaujinti" button covers the "did
    // the reply I'm waiting on just arrive" check, same as every other
    // list in this app that isn't itself the primary live view.
    load();
  }, []);

  return (
    <div className="instantly-panel instantly-webhook-log">
      <div className="instantly-toolbar">
        <button type="button" onClick={load} disabled={loading}>
          <RefreshCw className="icon" size={14} /> Atnaujinti
        </button>
        <span className="instantly-hint">
          Kiekvienas įrašas — vienas iš Instantly gautas webhook įvykis. „Apdorota“ reiškia, kad atsakymai buvo
          sinchronizuoti į lentelę „Visi atsakymai“ — jei nori, kad jie atsirastų konkrečioje įmonės lentelėje,
          juos vis tiek reikia rankiniu būdu perkelti („Perkelti į lentelę“ mygtukas). Spustelėkite eilutę, kad
          pamatytumėte pilną gautą duomenų turinį (JSON).
        </span>
      </div>
      {error && <p className="instantly-hint">{error}</p>}
      {loading && events.length === 0 && <p className="instantly-hint">Kraunama…</p>}
      {!loading && events.length === 0 && !error && <p className="instantly-hint">Webhook įvykių dar negauta.</p>}
      {events.length > 0 && (
        <div className="instantly-webhook-log-table-wrap">
          <table className="instantly-webhook-log-table">
            <thead>
              <tr>
                <th>Gauta</th>
                <th>Kampanija</th>
                <th>Atsakyta per</th>
                <th>Laukė eilėje</th>
                <th>Apdorota per</th>
                <th>Rezultatas</th>
                <th>Detalės</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const ackDelay = deltaMs(e.receivedAt, e.responseSentAt);
                const queueDelay = deltaMs(e.receivedAt, e.processingStartedAt);
                const processingTime = deltaMs(e.processingStartedAt, e.processingFinishedAt);
                const isExpanded = expandedId === e.id;
                return (
                  <Fragment key={e.id}>
                    <tr
                      className="instantly-webhook-log-row"
                      onClick={() => setExpandedId((prev) => (prev === e.id ? null : e.id))}
                    >
                      <td title={new Date(e.receivedAt).toISOString()}>{fmtTime(e.receivedAt)}</td>
                      <td>{e.campaignId ?? '—'}</td>
                      <td>{fmtDelta(ackDelay)}</td>
                      <td>{fmtDelta(queueDelay)}</td>
                      <td>{fmtDelta(processingTime)}</td>
                      <td>
                        {e.outcome ? (
                          <span style={{ color: OUTCOME_COLORS[e.outcome] ?? undefined, fontWeight: 600 }}>
                            {OUTCOME_LABELS[e.outcome] ?? e.outcome}
                          </span>
                        ) : (
                          <span style={{ color: '#e08a2b', fontWeight: 600 }}>Vykdoma…</span>
                        )}
                      </td>
                      <td>
                        {e.outcome === 'success' &&
                          `+${e.rowsCreated ?? 0} nauji, ${e.skippedDuplicate ?? 0} jau buvo (${e.tableName ?? '?'})`}
                        {e.outcome === 'error' && e.errorMessage}
                        {e.outcome === 'ignored' && `event_type: "${e.eventType ?? ''}"${e.campaignId ? '' : ', trūksta campaign_id'}`}
                        {(e.outcome === 'no_api_key' || e.outcome === 'coalesced' || !e.outcome) && '—'}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="instantly-webhook-log-row-expanded">
                        <td colSpan={7}>
                          <pre className="instantly-webhook-log-raw">{formatRawBody(e.rawBody)}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
