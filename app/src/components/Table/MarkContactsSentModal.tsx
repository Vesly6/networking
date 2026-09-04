import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Papa from 'papaparse';
import { Check, X, FileText, Download } from 'lucide-react';
import type { Row } from '../../types';
import { saveRows } from '../../db/db';
import { getPrimaryLabel } from '../../utils/row';
import { EMAIL_SEARCH_PATTERN, findContactIdByEmail, markContactSent } from '../../utils/contacts';
import { findContactCandidates } from '../../utils/contactBulkMatch';
import { parseCsvFile, downloadCsv, sanitizeFilename } from '../../utils/csv';
import { createImportRecord, type ImportChangeEntry } from '../../utils/importHistory';

interface MarkContactsSentModalProps {
  onClose: () => void;
  onDone: (message: string) => void;
}

interface MatchedEntry {
  email: string;
  tableName: string;
  companyLabel: string;
}

interface MarkResults {
  matched: MatchedEntry[];
  notFound: string[];
  /** How many unique addresses were pasted — kept separate from
   * matched.length, which counts marked *contact cards* and can be
   * larger: the same company legitimately exists in more than one
   * workspace table (a filtered campaign table plus a shared master
   * list), and every table's own card for that address gets marked, not
   * just one. Without this the results screen's numbers looked like they
   * didn't add up ("I pasted 361, it says 420 marked?"). */
  uniqueEmailCount: number;
}

/** Header names that plausibly mean "this column holds the email address"
 * — used only to pick a sensible default in the column picker below; the
 * user can always override it, same "suggestion, not a re-parse" spirit
 * as CsvImportMapping.tsx's own buildDefaultMapping. */
function guessEmailColumnIndex(headers: string[]): number {
  const idx = headers.findIndex((h) => /e-?mail|paštas/i.test(h));
  return idx === -1 ? 0 : idx;
}

/** A table name is free-text (can hold quotes, slashes, emoji, ...) —
 * strip it down to something every OS accepts as a filename rather than
 * trusting it verbatim. */
/** Bulk "mark as sent" — the third mapping in the sent/replied tracking
 * feature, replacing an earlier per-contact click that turned out to be
 * the wrong shape for the real workflow (10,000+ contacts across dozens
 * of country/sector tables, on explicit request "мне ручного клика не
 * нужно вообще"). Paste (or upload) the list of email addresses going out
 * in this outreach round; every matching Contacts entry across EVERY
 * workspace table gets sentCount bumped in one action — no per-table
 * repetition, no per-contact clicking. Opened from TableView.tsx's
 * toolbar, available regardless of which table happens to be open, since
 * the search itself isn't scoped to it. */
export function MarkContactsSentModal({ onClose, onDone }: MarkContactsSentModalProps) {
  const [text, setText] = useState('');
  const [marking, setMarking] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Populated once handleConfirm finishes — switches the modal from the
  // input screen to a review screen instead of closing immediately, so a
  // "only 36 marked" run can actually be inspected (which contacts got
  // credited, which pasted emails found nothing) instead of just a toast
  // with two numbers. Real, reported gap: with no visibility into *which*
  // emails failed to match, there was no way to tell a genuine "this
  // person isn't in any table yet" apart from a data-format mismatch (the
  // email living in some other column than the row's own Contacts column
  // — see findContactIdByEmail's own doc comment) without re-deriving it
  // by hand.
  const [results, setResults] = useState<MarkResults | null>(null);

  // Mapping mode — entered only when an uploaded file turns out to have
  // more than one column (a real export, e.g. from Instantly: name,
  // company, email, status, ...), on explicit request ("хочу сделать
  // маппинг... выберу только по емайлам"): rather than blindly regex-
  // scanning the whole file for anything email-shaped (which could pick
  // up a stray email elsewhere in an unrelated column), show the file's
  // own columns and let the user pick which one actually holds the
  // addresses. A single-column file (or a plain paste) has nothing to
  // map — that keeps using the simple whole-text scan below unchanged.
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[] | null>(null);
  const [csvRows, setCsvRows] = useState<string[][] | null>(null);
  const [emailColumnIndex, setEmailColumnIndex] = useState(0);

  const resetFileSelection = () => {
    setCsvFileName(null);
    setCsvHeaders(null);
    setCsvRows(null);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const { headers, rows } = await parseCsvFile(file);
    if (headers.length > 1) {
      setText('');
      setCsvFileName(file.name);
      setCsvHeaders(headers);
      setCsvRows(rows);
      setEmailColumnIndex(guessEmailColumnIndex(headers));
      return;
    }
    // Nothing to map (a single column, or plain-text .txt Papa.parse still
    // read as one column) — fall back to the original whole-text scan, same
    // as pasting directly into the textarea.
    resetFileSelection();
    const content = await file.text();
    setText((prev) => (prev.trim() ? `${prev}\n${content}` : content));
  };

  const handleConfirm = async () => {
    setMarking(true);
    try {
      // In mapping mode, the source text is just the chosen column's own
      // values (never the other columns) — a name/company/status column
      // full of unrelated text should never accidentally contribute a
      // false-positive email match. Otherwise (plain paste, or a
      // single-column upload) it's the whole textarea, same as before.
      const sourceText = csvRows ? csvRows.map((r) => r[emailColumnIndex] ?? '').join('\n') : text;
      // Any email-shaped substring anywhere in the source text is picked
      // up regardless of what separates them (newlines, commas, a
      // "Name <email@x.com>" cell, ...) — same technique emailMatch.ts's
      // own extractRowEmails already uses against a single cell's text.
      const pattern = new RegExp(EMAIL_SEARCH_PATTERN.source, 'g');
      const pastedEmails = [...new Set([...sourceText.matchAll(pattern)].map((m) => m[0].toLowerCase()))];
      if (pastedEmails.length === 0) {
        onDone('Nerasta nė vieno el. pašto adreso.');
        return;
      }

      // See findContactCandidates' own doc comment for why this is a
      // shared util now: always fresh from the server, scoped to only
      // each table's Contacts column, and returns every table with a real
      // match rather than stopping at the first one found.
      const candidatesByEmail = await findContactCandidates(pastedEmails);

      // Accumulates progressively per row id — reading row.cells fresh
      // every time (instead of tracking what's already been marked THIS
      // run) would silently drop all but the last mark whenever two+
      // pasted emails share the same destination row, same class of bug
      // PushReplyRowsModal's own historyByRowId accumulation guards
      // against.
      const contactsByRowId = new Map<string, string>();
      const rowById = new Map<string, Row>();
      const contactColIdByRowId = new Map<string, string>();
      const matched: MatchedEntry[] = [];
      const notFound: string[] = [];
      // One entry per (row, contact) actually bumped — tableId is
      // per-change, not shared across the whole import, since this modal
      // can (and typically does) touch many different workspace tables in
      // one run.
      const changes: ImportChangeEntry[] = [];

      for (const email of pastedEmails) {
        const candidates = candidatesByEmail.get(email);
        if (!candidates || candidates.length === 0) {
          notFound.push(email);
          continue;
        }
        let matchedAny = false;
        for (const { row, contactColId, table } of candidates) {
          const currentContacts = contactsByRowId.get(row.id) ?? (row.cells[contactColId] ?? '');
          const contactId = findContactIdByEmail(currentContacts, email);
          if (!contactId) continue;
          contactsByRowId.set(row.id, markContactSent(currentContacts, contactId));
          rowById.set(row.id, row);
          contactColIdByRowId.set(row.id, contactColId);
          matched.push({ email, tableName: table.name, companyLabel: getPrimaryLabel(row, table.columns) });
          changes.push({
            tableId: table.id,
            rowId: row.id,
            kind: 'contact_counter_bumped',
            columnId: contactColId,
            contactId,
            field: 'sentCount',
            amount: 1,
          });
          matchedAny = true;
        }
        if (!matchedAny) notFound.push(email);
      }

      const toSave = [...rowById.values()].map((row) => ({
        ...row,
        cells: { ...row.cells, [contactColIdByRowId.get(row.id)!]: contactsByRowId.get(row.id)! },
        updatedAt: Date.now(),
      }));
      // Rows here can belong to several different tables at once — the
      // server's PUT /api/rows already supports a mixed-table batch (each
      // Row carries its own tableId), no per-table splitting needed.
      if (toSave.length > 0) await saveRows(toSave);

      if (changes.length > 0) {
        // Best-effort, same reasoning as PushReplyRowsModal's own — the
        // row writes above already succeeded regardless of this call.
        void createImportRecord({
          type: 'mark_sent',
          label: `Pažymėta išsiųsta (${pastedEmails.length} adresų)`,
          recordCount: matched.length,
          changes,
        }).catch(() => {});
      }

      setResults({ matched, notFound, uniqueEmailCount: pastedEmails.length });
    } catch (err) {
      onDone(err instanceof Error ? err.message : 'Nepavyko pažymėti kaip išsiųsta');
    } finally {
      setMarking(false);
    }
  };

  const handleDownloadNotFound = () => {
    if (!results || results.notFound.length === 0) return;
    const csvContent = ['email', ...results.notFound].join('\n');
    downloadCsv('nepazymeti_el_pastai.csv', csvContent);
  };

  const handleDownloadTableGroup = (tableName: string, entries: MatchedEntry[]) => {
    const csvContent = Papa.unparse({
      fields: ['company', 'email'],
      data: entries.map((e) => [e.companyLabel, e.email]),
    });
    downloadCsv(`pazymeta_${sanitizeFilename(tableName)}.csv`, csvContent);
  };

  // Grouped by table, not one flat list — on explicit request, so results
  // can be inspected and exported per table independently: one table's
  // worker cares about that table's own contacts, not a mixed list
  // spanning every other table a company happens to also exist in (see
  // the note above matched.length about duplicate cards across tables).
  // Preserves the order tables were first encountered while matching, not
  // alphabetical — usually mirrors the table's own position in the
  // workspace, which is more recognizable at a glance than a resorted
  // list would be.
  const matchedByTable = results
    ? (() => {
        const order: string[] = [];
        const map = new Map<string, MatchedEntry[]>();
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
          <h2>Pridėti išsiųstus — rezultatai</h2>
          <p className="csv-import-mapping-summary">
            Unikalių adresų: {results.uniqueEmailCount} · Nerasta: {results.notFound.length}
          </p>
          {results.matched.length > results.uniqueEmailCount && (
            <p className="csv-import-mapping-hint">
              Pažymėtų kontaktų iš viso: {results.matched.length} — kai kurios įmonės egzistuoja daugiau nei vienoje lentelėje, todėl
              kiekvienoje jų atskirai pažymėta ta pati siunta (žr. grupes pagal lentelę žemiau).
            </p>
          )}
          <div className="bulk-match-results-section">
            <div className="bulk-match-results-heading">
              <Check className="icon" size={14} /> Pažymėti kontaktai ({results.matched.length})
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
                          <span className="bulk-match-results-email">{m.email}</span>
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
            <button
              type="button"
              className="primary"
              onClick={() =>
                onDone(`Pažymėta išsiųsta: ${results.uniqueEmailCount} adresų (${results.matched.length} kontaktų), nerasta: ${results.notFound.length}`)
              }
            >
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
        <h2>Pridėti išsiųstus</h2>
        <p className="csv-import-mapping-hint">
          Įklijuokite arba įkelkite el. pašto adresų sąrašą — bus ieškoma atitikmenų tarp visų darbo srities lentelių
          Contacts stulpelio ir kiekvienam rastam kontaktui pažymėta, kad laiškas išsiųstas.
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
              Kuriame stulpelyje el. paštas?
              <select value={emailColumnIndex} onChange={(e) => setEmailColumnIndex(Number(e.target.value))}>
                {csvHeaders.map((h, i) => (
                  <option key={i} value={i}>
                    {h || `Stulpelis ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <>
            <textarea
              className="mark-sent-textarea"
              rows={8}
              placeholder={'vienas@example.com\nkitas@example.com\n...'}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button type="button" className="mark-sent-upload" onClick={() => fileInputRef.current?.click()}>
              Įkelti failą (.csv/.txt)
            </button>
          </>
        )}
        <input ref={fileInputRef} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={(e) => void handleFileChange(e)} />
        <div className="popover-footer">
          <button type="button" onClick={onClose}>
            Atšaukti
          </button>
          <button type="button" className="primary" disabled={(!text.trim() && !csvRows) || marking} onClick={() => void handleConfirm()}>
            {marking ? 'Žymima…' : 'Pažymėti'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
