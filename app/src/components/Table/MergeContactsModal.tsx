import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import Papa from 'papaparse';
import { X, Upload, Check, Download } from 'lucide-react';
import type { Column, Row } from '../../types';
import type { CellUpdate } from '../../store/useTableStore';
import { parseCsvFile, downloadCsv } from '../../utils/csv';
import { normalizeDomain } from '../../utils/domainMatch';
import { buildDomainIndex, type RowDomainMatch } from '../../utils/rowDomainIndex';
import { getPrimaryLabel } from '../../utils/row';
import { joinContactFields, addContactsDedupByEmail } from '../../utils/contacts';

const NONE = '__none__';
const SKIP = '__skip__';

type MatchMode = 'website' | 'id';

interface MergeContactsModalProps {
  columns: Column[];
  rows: Row[];
  contactColumnId: string;
  onConfirm: (updates: CellUpdate[], stats: MergeStats) => void;
  onCancel: () => void;
}

export interface MergeStats {
  updatedRows: number;
  addedContacts: number;
  skippedDuplicates: number;
  skippedGroups: number;
}

type Step = 'pick-file' | 'map-fields' | 'review';

interface FieldMapping {
  matchCol: string;
  companyNameCol: string;
  nameMode: 'full' | 'split';
  fullNameCol: string;
  firstNameCol: string;
  lastNameCol: string;
  titleCol: string;
  emailCol: string;
  phoneCol: string;
  linkedinCol: string;
}

function guessHeader(headers: string[], exact: string[], pattern?: RegExp): string {
  const lower = (h: string) => h.trim().toLowerCase();
  for (const name of exact) {
    const found = headers.find((h) => lower(h) === name);
    if (found) return found;
  }
  if (pattern) {
    const found = headers.find((h) => pattern.test(lower(h)));
    if (found) return found;
  }
  return NONE;
}

function guessMatchCol(headers: string[], mode: MatchMode): string {
  return mode === 'website'
    ? guessHeader(headers, ['website'], /website|svetain|domain/)
    : guessHeader(headers, ['mapping contacts', 'id', 'nr', 'nr.'], /^id$|numeris|company.?id/);
}

function buildDefaultMapping(headers: string[], mode: MatchMode): FieldMapping {
  const fullNameCol = guessHeader(headers, ['full name'], /full.?name/);
  const firstNameCol = guessHeader(headers, ['first name'], /first.?name|vardas/);
  const lastNameCol = guessHeader(headers, ['last name'], /last.?name|pavard/);
  return {
    matchCol: guessMatchCol(headers, mode),
    companyNameCol: guessHeader(headers, ['company name', 'company'], /company|įmon/),
    nameMode: fullNameCol !== NONE ? 'full' : 'split',
    fullNameCol,
    firstNameCol,
    lastNameCol,
    titleCol: guessHeader(headers, ['title'], /title|position|pareig/),
    emailCol: guessHeader(headers, ['email'], /email/),
    phoneCol: guessHeader(headers, ['phone'], /phone|tel\b/),
    linkedinCol: guessHeader(headers, ['linkedin link', 'linkedin'], /linkedin/),
  };
}

interface CsvGroup {
  key: string;
  matchValue: string | null;
  companyName: string;
  entryTexts: string[];
  /** The original CSV rows behind this group's entries, kept alongside
   * entryTexts (which are already reshaped into the joined contact-field
   * string) specifically for the "Atsiųsti N nesusietų kontaktų" download
   * button below — the export needs the CSV's own original columns, not
   * the already-transformed contact text. */
  rawRows: string[][];
  candidates: RowDomainMatch[];
}

type GroupBucket = 'matched' | 'collision' | 'unmatched';

function bucketOf(group: CsvGroup): GroupBucket {
  if (group.candidates.length === 1) return 'matched';
  if (group.candidates.length > 1) return 'collision';
  return 'unmatched';
}

/** Keyed by the exact (trimmed) value of a manually-assigned id/number
 * column — the alternative to normalizeDomain() above, for companies
 * neither file happens to have a website for (confirmed against the
 * user's real data: roughly half of a real decision-makers export's 629
 * companies share no website with the target table at all). The user's
 * own workflow: add an "ID"/"Nr" column to both source CSVs by hand
 * before importing. Deliberately just an exact string match — no
 * normalization beyond trimming, since the whole point is the user
 * controls both sides of the comparison directly rather than the app
 * guessing (unlike a website, which needs http/www/path stripped before
 * two independently-typed values are likely to agree, a manually-typed
 * number either matches exactly or the user mistyped it). Same
 * RowDomainMatch shape (and same "array per key, not one" reasoning — two
 * rows could share an id by mistake and that has to surface, not silently
 * pick one) as buildDomainIndex. */
function buildIdIndex(columns: Column[], rows: Row[], idColumnId: string): Map<string, RowDomainMatch[]> {
  const index = new Map<string, RowDomainMatch[]>();
  for (const row of rows) {
    const id = (row.cells[idColumnId] ?? '').trim();
    if (!id) continue;
    const match: RowDomainMatch = { rowId: row.id, label: getPrimaryLabel(row, columns) };
    const existing = index.get(id);
    if (existing) existing.push(match);
    else index.set(id, [match]);
  }
  return index;
}

/** Step-by-step wizard for pulling a second CSV (typically a decision-makers/
 * contacts export) into an already-open table's Contacts column, matched to
 * the right row by one column of the user's choosing — either a website
 * (compared as a normalized domain, since company *names* rarely match as
 * text between two different data sources: e.g. `Uždaroji akcinė bendrovė
 * "AUGUST IR KO"` vs `"August ir Ko" UAB`, a real example from the data this
 * was built against) or a manually-assigned id/number (exact match — see
 * buildIdIndex above), never both fields shown at once. An earlier version
 * showed four separate selects (table+CSV website, table+CSV id) at the
 * same time, on the theory that a table could use domain matching for most
 * rows and id matching as a backup for the rest in one pass — reworked to
 * one mode toggle plus one column pair on explicit request ("оставить
 * только одну обозначительную колонку"): simpler to look at, and the two
 * comparison rules (normalize-as-URL vs exact-string) are different enough
 * under the hood that quietly blending them risked real surprises (e.g. a
 * bare "42" run through the URL parser normalizes to "0.0.0.42", not "42"
 * — confirmed directly — so a manually-typed number was never safe to
 * reuse the domain path for). Nothing stops re-running this wizard a
 * second time with the other mode for whatever didn't match the first
 * time — the dedup-by-email in addContactsDedupByEmail below makes that
 * safe.
 *
 * Deliberately separate from CsvImportMapping.tsx: that modal maps CSV
 * headers to *table columns* (creating new ones as needed); this one maps
 * CSV headers to a small set of *fixed contact fields* and never creates a
 * column — it only ever appends into the one Contacts column already picked
 * by the caller. Nothing is written until the final "review" step is
 * confirmed — same explicit-review-before-write rule this app already
 * follows for the ordinary CSV import mapping. */
export function MergeContactsModal({ columns, rows, contactColumnId, onConfirm, onCancel }: MergeContactsModalProps) {
  const [step, setStep] = useState<Step>('pick-file');
  const [headers, setHeaders] = useState<string[]>([]);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [error, setError] = useState('');
  const [mapping, setMapping] = useState<FieldMapping | null>(null);

  const [matchMode, setMatchMode] = useState<MatchMode>('website');
  const linkColumns = useMemo(() => columns.filter((c) => c.type === 'link'), [columns]);
  // Auto-selected only in website mode when there's exactly one candidate
  // column — an id/number can live in any column type, so there's nothing
  // safe to guess there; the user picks explicitly.
  const [matchColumnId, setMatchColumnId] = useState(() => (linkColumns.length === 1 ? linkColumns[0].id : ''));
  const matchColumnOptions = matchMode === 'website' ? linkColumns : columns;

  const handleModeChange = (mode: MatchMode) => {
    setMatchMode(mode);
    setMatchColumnId(mode === 'website' && linkColumns.length === 1 ? linkColumns[0].id : '');
    setMapping((prev) => (prev ? { ...prev, matchCol: guessMatchCol(headers, mode) } : prev));
  };

  // rowId -> chosen resolution: a row id to merge into, SKIP to drop the
  // whole group, or undefined if not yet decided (blocks confirm for
  // collision/unmatched groups; matched groups always start pre-decided).
  const [resolutions, setResolutions] = useState<Record<string, string>>({});
  const [showMatched, setShowMatched] = useState(false);

  const handleFile = async (file: File) => {
    setError('');
    try {
      const parsed = await parseCsvFile(file);
      if (parsed.headers.length === 0) {
        setError('Tuščias arba nenuskaitomas CSV failas.');
        return;
      }
      setHeaders(parsed.headers);
      setDataRows(parsed.rows);
      setMapping(buildDefaultMapping(parsed.headers, matchMode));
      setStep('map-fields');
    } catch {
      setError('Nepavyko nuskaityti CSV failo.');
    }
  };

  const domainIndex = useMemo(
    () => (matchMode === 'website' && matchColumnId ? buildDomainIndex(columns, rows, matchColumnId) : new Map<string, RowDomainMatch[]>()),
    [matchMode, matchColumnId, columns, rows],
  );
  const idIndex = useMemo(
    () => (matchMode === 'id' && matchColumnId ? buildIdIndex(columns, rows, matchColumnId) : new Map<string, RowDomainMatch[]>()),
    [matchMode, matchColumnId, columns, rows],
  );

  const groups = useMemo<CsvGroup[]>(() => {
    if (!mapping) return [];
    const idx = (col: string) => (col === NONE ? -1 : headers.indexOf(col));
    const iMatch = idx(mapping.matchCol);
    const iCompany = idx(mapping.companyNameCol);
    const iFull = idx(mapping.fullNameCol);
    const iFirst = idx(mapping.firstNameCol);
    const iLast = idx(mapping.lastNameCol);
    const iTitle = idx(mapping.titleCol);
    const iEmail = idx(mapping.emailCol);
    const iPhone = idx(mapping.phoneCol);
    const iLinkedin = idx(mapping.linkedinCol);

    const byKey = new Map<string, CsvGroup>();
    dataRows.forEach((row, i) => {
      const rawMatch = iMatch >= 0 ? (row[iMatch] ?? '') : '';
      const matchValue = matchMode === 'website' ? normalizeDomain(rawMatch) : rawMatch.trim() || null;
      const companyName = (iCompany >= 0 ? row[iCompany] : '')?.trim() ?? '';
      const key = matchValue ?? (companyName ? `company:${companyName.toLowerCase()}` : `row:${i}`);

      const firstName = iFirst >= 0 ? (row[iFirst] ?? '').trim() : '';
      const lastName = iLast >= 0 ? (row[iLast] ?? '').trim() : '';
      const fullName = iFull >= 0 ? (row[iFull] ?? '').trim() : '';
      const [guessedFirst, ...guessedRestParts] = mapping.nameMode === 'full' ? fullName.split(' ').filter(Boolean) : [];
      const entryText = joinContactFields({
        firstName: mapping.nameMode === 'split' ? firstName : (guessedFirst ?? ''),
        lastName: mapping.nameMode === 'split' ? lastName : guessedRestParts.join(' '),
        position: iTitle >= 0 ? (row[iTitle] ?? '').trim() : '',
        company: companyName,
        email: iEmail >= 0 ? (row[iEmail] ?? '').trim() : '',
        phone: iPhone >= 0 ? (row[iPhone] ?? '').trim() : '',
        linkedinUrl: iLinkedin >= 0 ? (row[iLinkedin] ?? '').trim() : '',
        instagramUrl: '',
        facebookUrl: '',
      });
      if (!entryText) return;

      const existing = byKey.get(key);
      if (existing) {
        existing.entryTexts.push(entryText);
        existing.rawRows.push(row);
      } else {
        const index = matchMode === 'website' ? domainIndex : idIndex;
        const candidates = matchValue ? (index.get(matchValue) ?? []) : [];
        byKey.set(key, {
          key,
          matchValue,
          companyName: companyName || matchValue || `Eilutė ${i + 1}`,
          entryTexts: [entryText],
          rawRows: [row],
          candidates,
        });
      }
    });
    return [...byKey.values()];
  }, [mapping, dataRows, headers, matchMode, domainIndex, idIndex]);

  const matchedGroups = groups.filter((g) => bucketOf(g) === 'matched');
  const collisionGroups = groups.filter((g) => bucketOf(g) === 'collision');
  const unmatchedGroups = groups.filter((g) => bucketOf(g) === 'unmatched');

  const resolutionFor = (group: CsvGroup): string | undefined => {
    if (group.key in resolutions) return resolutions[group.key];
    if (bucketOf(group) === 'matched') return group.candidates[0].rowId;
    return undefined;
  };

  const setResolution = (key: string, value: string) => setResolutions((prev) => ({ ...prev, [key]: value }));

  // On explicit request — a real, reported case where auto-matching found
  // 0 companies (the target table's Website column wasn't type "Nuoroda"
  // yet, so there was nothing to match against — see the warning below)
  // left every one of 629 groups needing a manual decision, and clicking
  // through that many one at a time isn't realistic. Only touches groups
  // with no decision yet, so it never overwrites a pick already made.
  const skipAll = (bucketGroups: CsvGroup[]) => {
    setResolutions((prev) => {
      const next = { ...prev };
      for (const g of bucketGroups) {
        if (resolutionFor(g) === undefined) next[g.key] = SKIP;
      }
      return next;
    });
  };

  const pendingCount = [...collisionGroups, ...unmatchedGroups].filter((g) => resolutionFor(g) === undefined).length;
  const totalPeople = groups.reduce((sum, g) => sum + g.entryTexts.length, 0);

  // Every group that WON'T be merged if the user confirms right now — not
  // decided yet, or explicitly skipped. Recomputed live as resolutions
  // change, so the download button's own count (and the file it produces)
  // always matches what "Pridėti kontaktus" would actually leave out.
  const unresolvedGroups = groups.filter((g) => {
    const r = resolutionFor(g);
    return !r || r === SKIP;
  });
  const unresolvedContactCount = unresolvedGroups.reduce((sum, g) => sum + g.rawRows.length, 0);

  // On explicit request — until now, a skipped/unresolved contact just
  // vanished the moment you clicked "Pridėti kontaktus", with no way to
  // come back to it later (research the right company, try again after
  // fixing the source data, etc.). Exports the CSV's own original columns
  // (not the already-joined contact text) so the download is a normal,
  // re-usable CSV — including the same "Mapping contacts"-style column, if
  // the file had one, for a future numbered re-match.
  const handleDownloadUnresolved = () => {
    const data = unresolvedGroups.flatMap((g) => g.rawRows);
    const csv = Papa.unparse({ fields: headers, data });
    downloadCsv('nesusieti_kontaktai.csv', csv);
  };

  const handleConfirm = () => {
    const byRow = new Map<string, string[]>();
    let skippedGroups = 0;
    for (const group of groups) {
      const resolution = resolutionFor(group);
      if (!resolution || resolution === SKIP) {
        skippedGroups++;
        continue;
      }
      const list = byRow.get(resolution) ?? [];
      list.push(...group.entryTexts);
      byRow.set(resolution, list);
    }

    const updates: CellUpdate[] = [];
    let addedContacts = 0;
    let skippedDuplicates = 0;
    for (const [rowId, entryTexts] of byRow) {
      const row = rows.find((r) => r.id === rowId);
      if (!row) continue;
      const result = addContactsDedupByEmail(row.cells[contactColumnId] ?? '', entryTexts);
      addedContacts += result.added;
      skippedDuplicates += result.skipped;
      updates.push({ rowId, columnId: contactColumnId, value: result.raw });
    }

    onConfirm(updates, {
      updatedRows: byRow.size,
      addedContacts,
      skippedDuplicates,
      skippedGroups,
    });
  };

  const renderGroupRow = (group: CsvGroup) => {
    const bucket = bucketOf(group);
    const resolution = resolutionFor(group);
    const options = bucket === 'collision' ? group.candidates : rows.map((r) => ({ rowId: r.id, label: getPrimaryLabel(r, columns) }));
    return (
      <div className="merge-contacts-group" key={group.key}>
        <div className="merge-contacts-group-info">
          <span className="merge-contacts-group-name">{group.companyName}</span>
          <span className="merge-contacts-group-meta">
            {group.entryTexts.length} {group.entryTexts.length === 1 ? 'kontaktas' : 'kontaktai(-ų)'}
            {group.matchValue && ` · ${group.matchValue}`}
          </span>
        </div>
        <select value={resolution ?? ''} onChange={(e) => setResolution(group.key, e.target.value)}>
          <option value="" disabled>
            — pasirinkite eilutę —
          </option>
          <option value={SKIP}>Praleisti</option>
          {options.map((o) => (
            <option key={o.rowId} value={o.rowId}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    );
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal merge-contacts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="apollo-search-modal-header">
          <h2>
            <Upload className="icon" size={18} /> Pridėti kontaktus iš CSV
          </h2>
          <button type="button" className="apollo-search-modal-close" onClick={onCancel}>
            <X className="icon" size={16} />
          </button>
        </div>

        {step === 'pick-file' && (
          <div className="linkedin-csv-picker">
            <p className="apollo-search-modal-hint">
              Pasirinkite CSV su kontaktais (pvz. sprendimų priėmėjais). Kiekvienas kontaktas bus pridėtas prie tos šios
              lentelės eilutės, kuri sutampa su CSV faile nurodyta svetaine arba numeriu.
            </p>
            <input type="file" accept=".csv" onChange={(e) => e.target.files?.[0] && void handleFile(e.target.files[0])} />
            {error && <p className="search-result-detail-error">{error}</p>}
          </div>
        )}

        {step === 'map-fields' && mapping && (
          <div className="linkedin-csv-mapping">
            <p className="apollo-search-modal-hint">Rasta {dataRows.length} eilučių. Nurodykite, kuris CSV stulpelis atitinka kurį lauką.</p>
            <div className="merge-contacts-name-mode">
              <label>
                <input type="radio" checked={matchMode === 'website'} onChange={() => handleModeChange('website')} />
                Sieti pagal svetainę
              </label>
              <label>
                <input type="radio" checked={matchMode === 'id'} onChange={() => handleModeChange('id')} />
                Sieti pagal ID/numerį
              </label>
            </div>
            {matchMode === 'website' && linkColumns.length === 0 && (
              <p className="merge-contacts-warning">
                Šioje lentelėje nėra nė vieno „Nuoroda" tipo stulpelio. Jei turite stulpelį su svetainėmis (pvz. „Svetainė"),
                pakeiskite jo tipą į „Nuoroda" (stulpelio antraštėje spauskite (⋮) → Tipas) ir bandykite iš naujo — arba
                naudokite ID/numerį virš šio pranešimo.
              </p>
            )}
            <label>
              {matchMode === 'website' ? 'Šios lentelės svetainės stulpelis' : 'Šios lentelės ID/numerio stulpelis'}
              <select value={matchColumnId} onChange={(e) => setMatchColumnId(e.target.value)}>
                <option value="">— nėra —</option>
                {matchColumnOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {matchMode === 'website' ? 'CSV: Svetainės / domeno stulpelis' : 'CSV: ID/numerio stulpelis'}
              <select value={mapping.matchCol} onChange={(e) => setMapping({ ...mapping, matchCol: e.target.value })}>
                <option value={NONE}>— nėra —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <label>
              CSV: Įmonės pavadinimo stulpelis (tik rodymui)
              <select value={mapping.companyNameCol} onChange={(e) => setMapping({ ...mapping, companyNameCol: e.target.value })}>
                <option value={NONE}>— nėra —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <div className="merge-contacts-name-mode">
              <label>
                <input
                  type="radio"
                  checked={mapping.nameMode === 'full'}
                  onChange={() => setMapping({ ...mapping, nameMode: 'full' })}
                />
                Vienas stulpelis (pilnas vardas)
              </label>
              <label>
                <input
                  type="radio"
                  checked={mapping.nameMode === 'split'}
                  onChange={() => setMapping({ ...mapping, nameMode: 'split' })}
                />
                Atskiri Vardas / Pavardė stulpeliai
              </label>
            </div>
            {mapping.nameMode === 'full' ? (
              <label>
                CSV: Pilnas vardas
                <select value={mapping.fullNameCol} onChange={(e) => setMapping({ ...mapping, fullNameCol: e.target.value })}>
                  <option value={NONE}>— nėra —</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label>
                  CSV: Vardas
                  <select value={mapping.firstNameCol} onChange={(e) => setMapping({ ...mapping, firstNameCol: e.target.value })}>
                    <option value={NONE}>— nėra —</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  CSV: Pavardė
                  <select value={mapping.lastNameCol} onChange={(e) => setMapping({ ...mapping, lastNameCol: e.target.value })}>
                    <option value={NONE}>— nėra —</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            <label>
              CSV: Pareigos
              <select value={mapping.titleCol} onChange={(e) => setMapping({ ...mapping, titleCol: e.target.value })}>
                <option value={NONE}>— nėra —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <label>
              CSV: El. paštas
              <select value={mapping.emailCol} onChange={(e) => setMapping({ ...mapping, emailCol: e.target.value })}>
                <option value={NONE}>— nėra —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <label>
              CSV: Telefonas
              <select value={mapping.phoneCol} onChange={(e) => setMapping({ ...mapping, phoneCol: e.target.value })}>
                <option value={NONE}>— nėra —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <label>
              CSV: LinkedIn nuoroda
              <select value={mapping.linkedinCol} onChange={(e) => setMapping({ ...mapping, linkedinCol: e.target.value })}>
                <option value={NONE}>— nėra —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {step === 'review' && (
          <div className="merge-contacts-review">
            <p className="apollo-search-modal-hint">
              Iš viso {totalPeople} kontaktų, {groups.length} įmonių grupių. Automatiškai rasta: {matchedGroups.length} · Keli
              galimi atitikmenys: {collisionGroups.length} · Nerasta atitikmens: {unmatchedGroups.length}.
            </p>
            {unresolvedContactCount > 0 && (
              <button type="button" onClick={handleDownloadUnresolved}>
                <Download className="icon" size={14} /> Atsiųsti {unresolvedContactCount} nesusietų kontaktų
              </button>
            )}
            {collisionGroups.length > 0 && (
              <>
                <div className="merge-contacts-section-header">
                  <h3 className="merge-contacts-section-title">Keli galimi atitikmenys — pasirinkite vieną</h3>
                  <button type="button" onClick={() => skipAll(collisionGroups)}>
                    Praleisti visus ({collisionGroups.length})
                  </button>
                </div>
                <div className="merge-contacts-list">{collisionGroups.map(renderGroupRow)}</div>
              </>
            )}
            {unmatchedGroups.length > 0 && (
              <>
                <div className="merge-contacts-section-header">
                  <h3 className="merge-contacts-section-title">Nerasta atitikmens — pasirinkite eilutę arba praleiskite</h3>
                  <button type="button" onClick={() => skipAll(unmatchedGroups)}>
                    Praleisti visus ({unmatchedGroups.length})
                  </button>
                </div>
                <div className="merge-contacts-list">{unmatchedGroups.map(renderGroupRow)}</div>
              </>
            )}
            {matchedGroups.length > 0 && (
              <>
                <button type="button" className="merge-contacts-toggle-matched" onClick={() => setShowMatched((v) => !v)}>
                  {showMatched ? 'Slėpti' : 'Rodyti'} automatiškai rastus atitikmenis ({matchedGroups.length})
                </button>
                {showMatched && <div className="merge-contacts-list">{matchedGroups.map(renderGroupRow)}</div>}
              </>
            )}
          </div>
        )}

        <div className="popover-footer">
          <button type="button" onClick={onCancel}>
            <X className="icon" size={16} /> Atšaukti
          </button>
          {step === 'map-fields' && (
            <button type="button" className="primary" onClick={() => setStep('review')}>
              Toliau
            </button>
          )}
          {step === 'review' && (
            <button type="button" className="primary" disabled={pendingCount > 0} onClick={handleConfirm}>
              <Check className="icon" size={16} /> Pridėti kontaktus{pendingCount > 0 ? ` (liko ${pendingCount} neišspręstų)` : ''}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
