import { useState } from 'react';
import { createPortal } from 'react-dom';
import { parseCsvFile } from '../../utils/csv';
import type { NewLead } from '../../utils/linkedinCampaignsApi';

const NONE = '__none__';

interface LeadCsvImportProps {
  onConfirm: (leads: NewLead[]) => void;
  onCancel: () => void;
}

/** A much smaller cousin of the main Table's CsvImportMapping.tsx — leads
 * have a small, fixed set of target fields (not arbitrary user columns),
 * so the mapping runs the opposite direction: pick which CSV header fills
 * each fixed field, rather than deciding a destination per header. Same
 * "parse, then an explicit mapping step, never silent auto-import"
 * principle either way — nothing gets added until the user reviews and
 * confirms. */
export function LeadCsvImport({ onConfirm, onCancel }: LeadCsvImportProps) {
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [rows, setRows] = useState<string[][]>([]);
  const [urlCol, setUrlCol] = useState(NONE);
  const [nameCol, setNameCol] = useState(NONE);
  const [titleCol, setTitleCol] = useState(NONE);
  const [companyCol, setCompanyCol] = useState(NONE);
  const [error, setError] = useState('');

  const handleFile = async (file: File) => {
    setError('');
    try {
      const parsed = await parseCsvFile(file);
      if (parsed.headers.length === 0) {
        setError('Tuščias arba nenuskaitomas CSV failas.');
        return;
      }
      setHeaders(parsed.headers);
      setRows(parsed.rows);
      // Best-effort default guess by header name — still fully
      // overridable below before anything is confirmed.
      const guess = (needle: RegExp) => parsed.headers.find((h) => needle.test(h.trim().toLowerCase())) ?? NONE;
      setUrlCol(guess(/linkedin|profile.?url|url/));
      setNameCol(guess(/^name$|full.?name/));
      setTitleCol(guess(/title|position|pareigos/));
      setCompanyCol(guess(/company|organization|įmonė/));
    } catch {
      setError('Nepavyko nuskaityti CSV failo.');
    }
  };

  const handleConfirm = () => {
    if (!headers || urlCol === NONE) return;
    const urlIdx = headers.indexOf(urlCol);
    const nameIdx = nameCol === NONE ? -1 : headers.indexOf(nameCol);
    const titleIdx = titleCol === NONE ? -1 : headers.indexOf(titleCol);
    const companyIdx = companyCol === NONE ? -1 : headers.indexOf(companyCol);
    const leads: NewLead[] = rows
      .map((row) => ({
        linkedinUrl: row[urlIdx]?.trim() ?? '',
        name: nameIdx >= 0 ? row[nameIdx]?.trim() : undefined,
        title: titleIdx >= 0 ? row[titleIdx]?.trim() : undefined,
        company: companyIdx >= 0 ? row[companyIdx]?.trim() : undefined,
        source: 'csv',
      }))
      .filter((l) => l.linkedinUrl);
    onConfirm(leads);
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Importuoti lyderius iš CSV</h2>
        {!headers ? (
          <div className="linkedin-csv-picker">
            <input type="file" accept=".csv" onChange={(e) => e.target.files?.[0] && void handleFile(e.target.files[0])} />
            {error && <p className="search-result-detail-error">{error}</p>}
          </div>
        ) : (
          <div className="linkedin-csv-mapping">
            <p className="linkedin-hint">
              Rasta {rows.length} eilučių. Pasirinkite, kuris stulpelis atitinka kurį lauką — LinkedIn nuoroda būtina, kiti
              nebūtini.
            </p>
            <label>
              LinkedIn nuoroda (būtina)
              <select value={urlCol} onChange={(e) => setUrlCol(e.target.value)}>
                <option value={NONE}>— pasirinkite —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Vardas
              <select value={nameCol} onChange={(e) => setNameCol(e.target.value)}>
                <option value={NONE}>— nėra —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Pareigos
              <select value={titleCol} onChange={(e) => setTitleCol(e.target.value)}>
                <option value={NONE}>— nėra —</option>
                {headers.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Įmonė
              <select value={companyCol} onChange={(e) => setCompanyCol(e.target.value)}>
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
        <div className="popover-footer">
          <button type="button" onClick={onCancel}>
            ✕ Atšaukti
          </button>
          {headers && (
            <button type="button" className="primary" disabled={urlCol === NONE} onClick={handleConfirm}>
              + Importuoti
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
