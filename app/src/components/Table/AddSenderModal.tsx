import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Papa from 'papaparse';
import { Check, X, FileText, Download } from 'lucide-react';
import type { Row } from '../../types';
import { saveRows } from '../../db/db';
import { getPrimaryLabel } from '../../utils/row';
import { EMAIL_SEARCH_PATTERN, findContactIdByEmail, addContactSender } from '../../utils/contacts';
import { findContactCandidates } from '../../utils/contactBulkMatch';
import { parseCsvFile, downloadCsv } from '../../utils/csv';
import { todaySenderDate } from '../../utils/date';

interface AddSenderModalProps {
  onClose: () => void;
  onDone: (message: string) => void;
}

interface SenderMatchedEntry {
  companyLabel: string;
  tableName: string;
  recipientEmail: string;
  senderEmail: string;
}

interface AddSenderResults {
  matched: SenderMatchedEntry[];
  notFound: string[];
  uniqueEmailCount: number;
}

/** Tries each pattern in order against every header, returning the first
 * header index any pattern matches — a stricter pattern (exact "email")
 * listed first beats a looser one (a bare "e-?mail" substring, which
 * would otherwise match "Email Provider" just as readily as "Email").
 * Returns -1 (no default) rather than guessing wrong when nothing
 * matches — this column has no safe fallback the way a single-column
 * mark-sent list does. */
function guessColumnIndex(headers: string[], patterns: RegExp[]): number {
  for (const p of patterns) {
    const idx = headers.findIndex((h) => p.test(h.trim()));
    if (idx !== -1) return idx;
  }
  return -1;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '') || 'lentele';
}

/** "Pridėti siuntėją" — the sibling bulk action to MarkContactsSentModal
 * (Pridėti išsiųstus), sharing its matching engine (findContactCandidates
 * in utils/contactBulkMatch.ts) but recording something different: not a
 * count, but *which* sender mailbox(es) have emailed this contact. Built
 * for a real, repeating workflow — the same list gets sent to again from
 * a different mailbox in a later round (a first round nobody replies to,
 * a second round from a fresh mailbox that gets a response), 10+ times
 * over, and a worker who's about to call someone needs to know exactly
 * which mailbox(es) already reached out so they can reference it
 * correctly on the call. Source is always a two-column export (recipient
 * email + sender mailbox, e.g. Instantly's own "Email"/"Last contacted
 * from" columns) — unlike the single-column mark-sent list, there's no
 * plain-paste path here, since a bare list of addresses has nothing to
 * pair a sender with. */
export function AddSenderModal({ onClose, onDone }: AddSenderModalProps) {
  const [adding, setAdding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [results, setResults] = useState<AddSenderResults | null>(null);

  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[] | null>(null);
  const [csvRows, setCsvRows] = useState<string[][] | null>(null);
  const [recipientColumnIndex, setRecipientColumnIndex] = useState(0);
  const [senderColumnIndex, setSenderColumnIndex] = useState(-1);

  const resetFileSelection = () => {
    setCsvFileName(null);
    setCsvHeaders(null);
    setCsvRows(null);
    setRecipientColumnIndex(0);
    setSenderColumnIndex(-1);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const { headers, rows } = await parseCsvFile(file);
    if (headers.length < 2) {
      onDone('Failas turi turėti bent du stulpelius — gavėjo el. paštą ir siuntėjo pašto dėžutę.');
      return;
    }
    setCsvFileName(file.name);
    setCsvHeaders(headers);
    setCsvRows(rows);
    setRecipientColumnIndex(guessColumnIndex(headers, [/^e-?mail$/i, /e-?mail|paštas/i]));
    setSenderColumnIndex(guessColumnIndex(headers, [/last contacted from/i, /siunt(ė|e)jo?\s*(paštas|d[ėe]žut[ėe])/i, /\bsender\b/i, /\bfrom\b/i]));
  };

  const handleConfirm = async () => {
    if (!csvRows || senderColumnIndex === -1) return;
    setAdding(true);
    try {
      const emailPattern = new RegExp(EMAIL_SEARCH_PATTERN.source);
      // One recipient email -> every distinct sender mailbox this
      // specific file pairs it with. Almost always exactly one (a whole
      // campaign export shares one "Last contacted from" value per row),
      // but a Set means a file that happens to mix two for the same
      // person doesn't silently drop either.
      const sendersByRecipient = new Map<string, Set<string>>();
      for (const r of csvRows) {
        const recipientMatch = emailPattern.exec((r[recipientColumnIndex] ?? '').trim());
        const senderMatch = emailPattern.exec((r[senderColumnIndex] ?? '').trim());
        if (!recipientMatch || !senderMatch) continue;
        const recipient = recipientMatch[0].toLowerCase();
        const sender = senderMatch[0].toLowerCase();
        const set = sendersByRecipient.get(recipient) ?? new Set<string>();
        set.add(sender);
        sendersByRecipient.set(recipient, set);
      }
      const recipientEmails = [...sendersByRecipient.keys()];
      if (recipientEmails.length === 0) {
        onDone('Nerasta nė vienos poros (gavėjo el. paštas + siuntėjo pašto dėžutė).');
        return;
      }

      // See findContactCandidates' own doc comment (utils/contactBulkMatch.ts,
      // shared with MarkContactsSentModal) — fresh from the server every
      // time, scoped to only each table's Contacts column, every table
      // with a real match credited, not just the first one found.
      const candidatesByEmail = await findContactCandidates(recipientEmails);

      // Same progressive per-row-id accumulation as MarkContactsSentModal,
      // for the identical reason: reading row.cells fresh every time would
      // silently drop all but the last write whenever two+ recipient
      // emails in this file share the same destination row.
      const contactsByRowId = new Map<string, string>();
      const rowById = new Map<string, Row>();
      const contactColIdByRowId = new Map<string, string>();
      const matched: SenderMatchedEntry[] = [];
      const notFound: string[] = [];
      // One date for the whole run — every recorded sender in this batch
      // was, as far as this app knows, sent "today" (the moment this
      // export gets uploaded), not whatever date the campaign tool
      // itself might report per-row.
      const today = todaySenderDate();

      for (const recipientEmail of recipientEmails) {
        const senders = sendersByRecipient.get(recipientEmail)!;
        const candidates = candidatesByEmail.get(recipientEmail);
        if (!candidates || candidates.length === 0) {
          notFound.push(recipientEmail);
          continue;
        }
        let matchedAny = false;
        for (const { row, contactColId, table } of candidates) {
          const currentContacts = contactsByRowId.get(row.id) ?? (row.cells[contactColId] ?? '');
          const contactId = findContactIdByEmail(currentContacts, recipientEmail);
          if (!contactId) continue;
          let next = currentContacts;
          for (const senderEmail of senders) {
            next = addContactSender(next, contactId, senderEmail, today);
            matched.push({ companyLabel: getPrimaryLabel(row, table.columns), tableName: table.name, recipientEmail, senderEmail });
          }
          contactsByRowId.set(row.id, next);
          rowById.set(row.id, row);
          contactColIdByRowId.set(row.id, contactColId);
          matchedAny = true;
        }
        if (!matchedAny) notFound.push(recipientEmail);
      }

      const toSave = [...rowById.values()].map((row) => ({
        ...row,
        cells: { ...row.cells, [contactColIdByRowId.get(row.id)!]: contactsByRowId.get(row.id)! },
        updatedAt: Date.now(),
      }));
      if (toSave.length > 0) await saveRows(toSave);

      setResults({ matched, notFound, uniqueEmailCount: recipientEmails.length });
    } catch (err) {
      onDone(err instanceof Error ? err.message : 'Nepavyko pridėti siuntėjo');
    } finally {
      setAdding(false);
    }
  };

  const handleDownloadNotFound = () => {
    if (!results || results.notFound.length === 0) return;
    const csvContent = ['email', ...results.notFound].join('\n');
    downloadCsv('siuntejas_nerasta.csv', csvContent);
  };

  const handleDownloadTableGroup = (tableName: string, entries: SenderMatchedEntry[]) => {
    const csvContent = Papa.unparse({
      fields: ['company', 'recipient_email', 'sender_email'],
      data: entries.map((e) => [e.companyLabel, e.recipientEmail, e.senderEmail]),
    });
    downloadCsv(`siuntejas_${sanitizeFilename(tableName)}.csv`, csvContent);
  };

  // Grouped by table, same reasoning/shape as MarkContactsSentModal's own
  // matchedByTable — see its doc comment.
  const matchedByTable = results
    ? (() => {
        const order: string[] = [];
        const map = new Map<string, SenderMatchedEntry[]>();
        for (const m of results.matched) {
          if (!map.has(m.tableName)) {
            map.set(m.tableName, []);
            order.push(m.tableName);
          }
          map.get(m.tableName)!.push(m);
        }
        return order.map((tableName) => ({ tableName, entries: map.get(tableName)! }));
      })()
    : [];

  if (results) {
    return createPortal(
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal push-reply-rows-modal" onClick={(e) => e.stopPropagation()}>
          <h2>Pridėti siuntėją — rezultatai</h2>
          <p className="csv-import-mapping-summary">
            Unikalių gavėjų: {results.uniqueEmailCount} · Nerasta: {results.notFound.length}
          </p>
          <div className="bulk-match-results-section">
            <div className="bulk-match-results-heading">
              <Check className="icon" size={14} /> Pridėti siuntėjai ({results.matched.length})
            </div>
            {matchedByTable.length > 0 ? (
              <div className="bulk-match-results-groups">
                {matchedByTable.map(({ tableName, entries }) => (
                  <div key={tableName} className="bulk-match-results-group">
                    <div className="bulk-match-results-group-heading">
                      <span>
                        {tableName} ({entries.length})
                      </span>
                      <button
                        type="button"
                        className="mark-sent-mapping-reset"
                        onClick={() => handleDownloadTableGroup(tableName, entries)}
                      >
                        <Download className="icon" size={12} /> atsisiųsti CSV
                      </button>
                    </div>
                    <div className="bulk-match-results-list">
                      {entries.map((m, i) => (
                        <div key={i} className="bulk-match-results-row">
                          <span className="bulk-match-results-company">{m.companyLabel}</span>
                          <span className="bulk-match-results-email">{m.recipientEmail}</span>
                          <span className="bulk-match-results-sender">← {m.senderEmail}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="csv-import-mapping-hint">Nė vienas kontaktas nerastas.</p>
            )}
          </div>
          <div className="bulk-match-results-section">
            <div className="bulk-match-results-heading">
              <X className="icon" size={14} /> Nerasti adresai ({results.notFound.length})
              {results.notFound.length > 0 && (
                <button type="button" className="mark-sent-mapping-reset" onClick={handleDownloadNotFound}>
                  <Download className="icon" size={12} /> atsisiųsti CSV
                </button>
              )}
            </div>
            {results.notFound.length > 0 ? (
              <div className="bulk-match-results-list">
                {results.notFound.map((email, i) => (
                  <div key={i} className="bulk-match-results-row">
                    <span className="bulk-match-results-email">{email}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="csv-import-mapping-hint">Visi adresai rasti.</p>
            )}
          </div>
          <div className="popover-footer">
            <button type="button" className="primary" onClick={() => onDone(`Pridėtas siuntėjas: ${results.matched.length} kontaktų, nerasta: ${results.notFound.length}`)}>
              Uždaryti
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal push-reply-rows-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Pridėti siuntėją</h2>
        <p className="csv-import-mapping-hint">
          Įkelkite išsiuntimo eksporto CSV failą (pvz. Instantly „Email“ / „Last contacted from“) — bus ieškoma atitikmenų
          tarp visų darbo srities lentelių Contacts stulpelio, ir kiekvienam rastam kontaktui pridėtas siuntėjo pašto
          dėžutės adresas prie jo sąrašo.
        </p>
        {csvHeaders && csvRows ? (
          <div className="mark-sent-mapping">
            <div className="mark-sent-mapping-file">
              <FileText className="icon" size={14} /> {csvFileName} ({csvRows.length} eil.){' '}
              <button type="button" className="mark-sent-mapping-reset" onClick={resetFileSelection}>
                pasirinkti kitą failą
              </button>
            </div>
            <label className="mark-sent-mapping-label">
              Kuriame stulpelyje gavėjo el. paštas?
              <select value={recipientColumnIndex} onChange={(e) => setRecipientColumnIndex(Number(e.target.value))}>
                {csvHeaders.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `Stulpelis ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="mark-sent-mapping-label">
              Kuriame stulpelyje siuntėjo pašto dėžutė?
              <select value={senderColumnIndex} onChange={(e) => setSenderColumnIndex(Number(e.target.value))}>
                <option value={-1}>— Pasirinkite stulpelį —</option>
                {csvHeaders.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `Stulpelis ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <button type="button" className="mark-sent-upload" onClick={() => fileInputRef.current?.click()}>
            Įkelti failą (.csv)
          </button>
        )}
        <input ref={fileInputRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => void handleFileChange(e)} />
        <div className="popover-footer">
          <button type="button" onClick={onClose}>
            Atšaukti
          </button>
          <button type="button" className="primary" disabled={!csvRows || senderColumnIndex === -1 || adding} onClick={() => void handleConfirm()}>
            {adding ? 'Pridedama…' : 'Pridėti'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
