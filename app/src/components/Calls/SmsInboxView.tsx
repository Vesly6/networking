import { useEffect, useMemo, useState } from 'react';
import { fetchSmsInbox, setupSmsWebhook, sendSms, type IncomingSmsRecord, type SmsLogRecord } from '../../utils/callsApi';
import { useToastStore } from '../../store/useToastStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { getAllSmsLog, saveSmsLogEntry } from '../../db/db';
import { phoneMatchKey } from '../../utils/phoneMatch';
import { formatHistoryTimestamp } from '../../utils/date';
import { randomUUID } from '../../utils/uuid';

const UNKNOWN_KEY = '__unknown__';

interface ThreadEntry {
  id: string;
  direction: 'in' | 'out';
  message: string | null;
  timestamp: number;
  success?: boolean;
  cost?: string;
  currency?: string;
  error?: string;
  rawPayload?: string;
}

interface Thread {
  matchKey: string;
  phone: string;
  entries: ThreadEntry[];
  latestTimestamp: number;
}

interface SmsInboxViewProps {
  phoneToRow: Map<string, { rowId: string; label: string }>;
  phoneToContact: Map<string, { rowId: string; columnId: string; contactId: string; label: string }>;
  onJumpToRow: (rowId: string) => void;
  onJumpToContact: (rowId: string, columnId: string, contactId: string) => void;
}

function formatReceivedAt(ms: number): string {
  return new Date(ms).toLocaleString('lt-LT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** One compose form, shared between "reply inside a thread" and "+ Nauja
 * SMS" — same confirm-before-send / log-regardless-of-outcome pattern
 * CellHoverEditor's own SMS compose already established, just lifted here
 * so a message can be sent without first going through Contacts (on
 * explicit request: "хочу чтоб я мог не только в контактах писать но и
 * тут тоже"). `phone` is editable only for the "+ Nauja SMS" case (a fresh
 * conversation with no thread yet); replying inside an existing thread
 * already knows the number. */
function SmsComposeForm({
  phone,
  phoneEditable,
  onSent,
  onCancel,
}: {
  phone: string;
  phoneEditable: boolean;
  onSent: (entry: SmsLogRecord) => void;
  onCancel: () => void;
}) {
  const showToast = useToastStore((s) => s.show);
  const [phoneDraft, setPhoneDraft] = useState(phone);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    const text = draft.trim();
    const target = phoneDraft.trim();
    if (!text || !target) return;
    if (!(await confirmDialog(`Siųsti SMS ${target}?\n\n${text}`))) return;
    setSending(true);
    const entry: SmsLogRecord = { id: randomUUID(), phone: target, message: text, sentAt: Date.now(), success: false };
    try {
      const result = await sendSms(target, text);
      entry.success = true;
      entry.cost = result.cost;
      entry.currency = result.currency;
      showToast(`SMS išsiųsta ${target}`);
    } catch (err) {
      entry.error = err instanceof Error ? err.message : 'Nepavyko išsiųsti SMS';
      showToast(entry.error);
    } finally {
      setSending(false);
      await saveSmsLogEntry(entry);
      onSent(entry);
    }
  };

  return (
    <form
      className="sms-inbox-compose"
      onSubmit={(e) => {
        e.preventDefault();
        void handleSend();
      }}
    >
      {phoneEditable && (
        <input
          className="sms-inbox-compose-phone"
          placeholder="+370…"
          value={phoneDraft}
          onChange={(e) => setPhoneDraft(e.target.value)}
        />
      )}
      <textarea
        autoFocus
        placeholder={`Rašyti SMS ${phoneEditable ? '' : phone}…`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="sms-inbox-compose-actions">
        <button type="submit" className="primary" disabled={sending || !draft.trim() || !phoneDraft.trim()}>
          {sending ? 'Siunčiama…' : '✉️ Siųsti'}
        </button>
        <button type="button" onClick={onCancel}>
          ✕ Atšaukti
        </button>
      </div>
    </form>
  );
}

function ThreadCard({
  thread,
  matched,
  matchedContact,
  onJumpToRow,
  onJumpToContact,
  onSent,
}: {
  thread: Thread;
  matched?: { rowId: string; label: string };
  matchedContact?: { rowId: string; columnId: string; contactId: string; label: string };
  onJumpToRow: (rowId: string) => void;
  onJumpToContact: (rowId: string, columnId: string, contactId: string) => void;
  onSent: (entry: SmsLogRecord) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [replying, setReplying] = useState(false);
  const latest = thread.entries[0];
  const label = matchedContact?.label ?? matched?.label;

  return (
    <div className="sms-thread-card">
      <button type="button" className="sms-thread-header" onClick={() => setExpanded((v) => !v)}>
        <div className="sms-thread-header-main">
          <span className="sms-thread-phone">
            {thread.matchKey === UNKNOWN_KEY ? '(nežinomas siuntėjas)' : thread.phone}
          </span>
          {label && <span className="sms-thread-label">{label}</span>}
        </div>
        <span className="sms-thread-preview">
          {latest.direction === 'out' ? '→ ' : ''}
          {latest.message || (latest.direction === 'in' ? '(nepavyko atpažinti teksto)' : '')}
        </span>
        <span className="sms-thread-time">{formatReceivedAt(thread.latestTimestamp)}</span>
      </button>

      {expanded && (
        <div className="sms-thread-body">
          <div className="sms-thread-actions">
            {matchedContact ? (
              <button
                type="button"
                className="sms-thread-jump"
                onClick={() => onJumpToContact(matchedContact.rowId, matchedContact.columnId, matchedContact.contactId)}
              >
                🏢 {matchedContact.label} →
              </button>
            ) : (
              matched && (
                <button type="button" className="sms-thread-jump" onClick={() => onJumpToRow(matched.rowId)}>
                  🏢 {matched.label} →
                </button>
              )
            )}
            {!replying && thread.matchKey !== UNKNOWN_KEY && (
              <button type="button" onClick={() => setReplying(true)}>
                ↩ Atsakyti
              </button>
            )}
          </div>

          {replying && (
            <SmsComposeForm
              phone={thread.phone}
              phoneEditable={false}
              onCancel={() => setReplying(false)}
              onSent={(entry) => {
                setReplying(false);
                onSent(entry);
              }}
            />
          )}

          <div className="sms-thread-entries">
            {thread.entries.map((e) => (
              <div key={e.id} className={`sms-thread-entry sms-thread-entry-${e.direction}`}>
                <div className="sms-thread-entry-meta">
                  <span className="sms-thread-entry-dir">{e.direction === 'out' ? 'Jūs' : 'Gauta'}</span>
                  <span className="sms-thread-entry-time">{formatHistoryTimestamp(e.timestamp)}</span>
                  {e.direction === 'out' &&
                    (e.success ? (
                      <span className="cell-hover-sms-history-ok">
                        išsiųsta{e.cost ? ` (${e.cost} ${e.currency ?? ''})` : ''}
                      </span>
                    ) : (
                      <span className="cell-hover-sms-history-fail">nepavyko: {e.error}</span>
                    ))}
                </div>
                {e.message ? (
                  <div className="sms-thread-entry-text">{e.message}</div>
                ) : (
                  e.rawPayload && (
                    <details className="sms-thread-entry-raw">
                      <summary>Nepavyko atpažinti teksto — rodyti neapdorotus duomenis</summary>
                      <pre>{e.rawPayload}</pre>
                    </details>
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Every SMS this app knows about — incoming (server-side, via Zadarma's
 * webhook — see server/src/index.ts) and outgoing (this app's own send
 * log, IndexedDB) — merged into one list of conversations grouped by
 * phone number, on explicit request ("достать историю всех смс в
 * окошко"). Neither side is fetched from Zadarma itself: their API has no
 * method to list sent SMS after the fact (confirmed against their own
 * official PHP client — sendSms() is the only SMS method that exists at
 * all), and incoming SMS only exists locally because the webhook pushed it
 * here — there's no "GET all incoming" Zadarma endpoint either. This view
 * is the only record of either, which is the whole reason smsLog/
 * incoming_sms exist as permanent local stores instead of being fetched
 * live. */
export function SmsInboxView({ phoneToRow, phoneToContact, onJumpToRow, onJumpToContact }: SmsInboxViewProps) {
  const [incoming, setIncoming] = useState<IncomingSmsRecord[]>([]);
  const [outgoing, setOutgoing] = useState<SmsLogRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [settingUpWebhook, setSettingUpWebhook] = useState(false);
  const [composingNew, setComposingNew] = useState(false);
  const showToast = useToastStore((s) => s.show);

  const load = () => {
    setLoading(true);
    Promise.all([fetchSmsInbox(), getAllSmsLog()])
      .then(([inboxRes, log]) => {
        setIncoming(inboxRes.messages);
        setOutgoing(log);
      })
      .catch((err) => showToast(err instanceof Error ? err.message : 'Nepavyko įkelti SMS'))
      .finally(() => setLoading(false));
  };

  // Load once on mount only — showToast is a stable Zustand action
  // reference, not a real dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const handleSetupWebhook = async () => {
    setSettingUpWebhook(true);
    try {
      const res = await setupSmsWebhook();
      showToast(`SMS webhook užregistruotas: ${res.url}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko užregistruoti SMS webhook');
    } finally {
      setSettingUpWebhook(false);
    }
  };

  const threads = useMemo(() => {
    const map = new Map<string, Thread>();
    const addEntry = (phone: string, entry: ThreadEntry) => {
      const key = phoneMatchKey(phone) ?? (phone.trim() ? phone.trim() : UNKNOWN_KEY);
      let thread = map.get(key);
      if (!thread) {
        thread = { matchKey: key, phone, entries: [], latestTimestamp: 0 };
        map.set(key, thread);
      }
      thread.entries.push(entry);
      if (entry.timestamp > thread.latestTimestamp) thread.latestTimestamp = entry.timestamp;
    };
    for (const m of incoming) {
      addEntry(m.fromNumber ?? '', {
        id: m.id,
        direction: 'in',
        message: m.message,
        timestamp: m.receivedAt,
        rawPayload: m.rawPayload,
      });
    }
    for (const s of outgoing) {
      addEntry(s.phone, {
        id: s.id,
        direction: 'out',
        message: s.message,
        timestamp: s.sentAt,
        success: s.success,
        cost: s.cost,
        currency: s.currency,
        error: s.error,
      });
    }
    const list = Array.from(map.values());
    for (const t of list) t.entries.sort((a, b) => b.timestamp - a.timestamp);
    list.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
    return list;
  }, [incoming, outgoing]);

  const handleSent = (entry: SmsLogRecord) => {
    setOutgoing((prev) => [entry, ...prev]);
    setComposingNew(false);
  };

  return (
    <div className="sms-inbox-view">
      <div className="calls-toolbar">
        <button type="button" onClick={load} disabled={loading}>
          {loading ? 'Kraunama…' : '↻ Atnaujinti'}
        </button>
        <button type="button" onClick={() => setComposingNew((v) => !v)}>
          ✉️ Nauja SMS
        </button>
        <button
          type="button"
          onClick={() => void handleSetupWebhook()}
          disabled={settingUpWebhook}
          title="Vienkartinis veiksmas — praneša Zadarma siųsti gaunamas SMS į šio serverio adresą. Reikalauja PUBLIC_BASE_URL serverio nustatymuose."
        >
          {settingUpWebhook ? 'Registruojama…' : '⚙️ Registruoti SMS webhook'}
        </button>
      </div>

      {composingNew && (
        <SmsComposeForm phone="" phoneEditable onCancel={() => setComposingNew(false)} onSent={handleSent} />
      )}

      {!loading && threads.length === 0 && <div className="empty-state">Kol kas nėra jokių SMS.</div>}

      {threads.length > 0 && (
        <div className="sms-thread-list">
          {threads.map((t) => (
            <ThreadCard
              key={t.matchKey}
              thread={t}
              matched={phoneToRow.get(t.matchKey)}
              matchedContact={phoneToContact.get(t.matchKey)}
              onJumpToRow={onJumpToRow}
              onJumpToContact={onJumpToContact}
              onSent={handleSent}
            />
          ))}
        </div>
      )}
    </div>
  );
}
