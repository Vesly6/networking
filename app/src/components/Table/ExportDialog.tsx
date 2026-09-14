import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Column, Row } from '../../types';
import { getColumnByType } from '../../utils/row';
import { buildExportRows, XLSX_MAX_ROWS, type ExportMode } from '../../utils/exportFlatten';
import { runExport, ExportRowLimitError } from '../../utils/exportTableApi';
import { runDemoExport } from '../../utils/exportTableDemo';
import { DEMO_MODE } from '../../utils/demoMode';
import { useToastStore } from '../../store/useToastStore';

interface ExportDialogProps {
  tableId: string;
  columns: Column[]; // full list, incl. hidden — this component filters itself
  allRows: Row[]; // full store rows, incl. hidden — the "of N" unfiltered baseline
  filteredSortedRows: Row[];
  selectedRowIds: Set<string>;
  isFilterActive: boolean;
  canExportContacts: boolean;
  onClose: () => void;
}

type ExportFormat = 'xlsx' | 'csv';
type ExportScope = 'all' | 'selected';

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** "Companies only"/"Companies with contacts" export — a real dialog
 * instead of the old instant one-shape download. Row counts are computed
 * synchronously client-side (buildExportRows over already-in-memory data),
 * so the live preview needs no server round trip. Generation itself always
 * goes through one path per build: the real server route (utils/
 * exportTableApi.ts) in a normal build, or a fully client-side path
 * (utils/exportTableDemo.ts) in the demo build, which has no backend at
 * all — see that module's own doc comment. */
export function ExportDialog({
  tableId,
  columns,
  allRows,
  filteredSortedRows,
  selectedRowIds,
  isFilterActive,
  canExportContacts,
  onClose,
}: ExportDialogProps) {
  const showToast = useToastStore((s) => s.show);
  const contactColumn = useMemo(() => getColumnByType(columns, 'contact'), [columns]);

  const [mode, setMode] = useState<ExportMode>('companies_only');
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [includeCompaniesWithoutContacts, setIncludeCompaniesWithoutContacts] = useState(false);
  const [onlyContactsWithEmail, setOnlyContactsWithEmail] = useState(false);
  const [scope, setScope] = useState<ExportScope>('all');
  const [status, setStatus] = useState<'idle' | 'preparing' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const visibleColumns = useMemo(() => columns.filter((c) => !c.hidden), [columns]);
  const visibleAllRows = useMemo(() => allRows.filter((r) => !r.hidden), [allRows]);
  const canShowScopeToggle = selectedRowIds.size >= 2;
  const scopedRows = useMemo(
    () => (scope === 'selected' ? filteredSortedRows.filter((r) => selectedRowIds.has(r.id)) : filteredSortedRows),
    [scope, filteredSortedRows, selectedRowIds],
  );

  const preview = useMemo(
    () =>
      buildExportRows({
        columns: visibleColumns,
        rows: scopedRows,
        mode,
        contactColumnId: contactColumn?.id ?? null,
        includeCompaniesWithoutContacts,
        onlyContactsWithEmail,
      }),
    [visibleColumns, scopedRows, mode, contactColumn, includeCompaniesWithoutContacts, onlyContactsWithEmail],
  );
  const previewCount = preview.dataRows.length;

  // The "of N" baseline — every visible row/contact, ignoring the current
  // filter/selection, so the dialog can show "34 of 120 (filter applied)".
  const totalCount = useMemo(() => {
    if (mode === 'companies_only') return visibleAllRows.length;
    return buildExportRows({
      columns: visibleColumns,
      rows: visibleAllRows,
      mode,
      contactColumnId: contactColumn?.id ?? null,
      includeCompaniesWithoutContacts,
      onlyContactsWithEmail,
    }).dataRows.length;
  }, [mode, visibleAllRows, visibleColumns, contactColumn, includeCompaniesWithoutContacts, onlyContactsWithEmail]);

  const xlsxRowLimitExceeded = previewCount + 1 > XLSX_MAX_ROWS;
  const effectiveFormat: ExportFormat = xlsxRowLimitExceeded ? 'csv' : format;
  const withContactsAllowed = !!contactColumn && canExportContacts;

  const buildFilename = (fmt: ExportFormat): string => {
    const parts = ['irms', 'companies'];
    if (mode === 'with_contacts') parts.push('contacts');
    if (scope === 'selected') parts.push('selected');
    else if (isFilterActive) parts.push('filtered');
    parts.push(todayDateString());
    return `${parts.join('_')}.${fmt}`;
  };

  const handleExportClick = async () => {
    if (status === 'preparing') return;
    setStatus('preparing');
    setErrorMessage(null);
    showToast('Ruošiamas failas…');
    const filename = buildFilename(effectiveFormat);
    try {
      if (DEMO_MODE) {
        await runDemoExport({
          mode,
          format: effectiveFormat,
          columns: visibleColumns,
          rows: scopedRows,
          contactColumnId: contactColumn?.id ?? null,
          includeCompaniesWithoutContacts,
          onlyContactsWithEmail,
          filename,
        });
      } else {
        await runExport({
          tableId,
          mode,
          format: effectiveFormat,
          rowIds: scopedRows.map((r) => r.id),
          columns: visibleColumns.map((c) => ({ id: c.id, name: c.name, type: c.type })),
          includeCompaniesWithoutContacts,
          onlyContactsWithEmail,
          filename,
        });
      }
      showToast('Eksportas paruoštas');
      onClose();
    } catch (err) {
      setStatus('error');
      if (err instanceof ExportRowLimitError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage(err instanceof Error ? err.message : 'Eksportas nepavyko');
      }
      return;
    }
    setStatus('idle');
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal export-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>Eksportuoti</h2>

        <div className="export-dialog-mode">
          <label>
            <input type="radio" checked={mode === 'companies_only'} onChange={() => setMode('companies_only')} />
            <span>
              Companies only
              <span className="export-dialog-mode-hint">Viena eilutė = viena įmonė. Kontaktai neįtraukiami.</span>
            </span>
          </label>
          <label className={!withContactsAllowed ? 'export-dialog-mode-disabled' : undefined}>
            <input
              type="radio"
              checked={mode === 'with_contacts'}
              disabled={!withContactsAllowed}
              onChange={() => setMode('with_contacts')}
            />
            <span>
              Companies with contacts
              <span className="export-dialog-mode-hint">
                {contactColumn
                  ? canExportContacts
                    ? 'Viena eilutė = vienas kontaktas. Įmonės duomenys pakartojami kiekvienoje.'
                    : 'Neturite teisės eksportuoti kontaktų.'
                  : 'Šioje lentelėje nėra kontaktų stulpelio.'}
              </span>
            </span>
          </label>
        </div>

        <div className="export-dialog-count">
          Eksportas: {previewCount} iš {totalCount} {mode === 'companies_only' ? 'įmonių' : 'kontaktų'}
          {scope === 'selected' ? ' (pasirinktos eilutės)' : isFilterActive ? ' (pritaikytas filtras)' : ''}
        </div>

        {mode === 'with_contacts' && withContactsAllowed && (
          <div className="export-dialog-checkboxes">
            <label>
              <input
                type="checkbox"
                checked={includeCompaniesWithoutContacts}
                onChange={(e) => setIncludeCompaniesWithoutContacts(e.target.checked)}
              />
              Include companies without contacts
            </label>
            <label>
              <input type="checkbox" checked={onlyContactsWithEmail} onChange={(e) => setOnlyContactsWithEmail(e.target.checked)} />
              Only contacts with email
            </label>
          </div>
        )}

        {canShowScopeToggle && (
          <div className="export-dialog-scope">
            <label>
              <input type="radio" checked={scope === 'selected'} onChange={() => setScope('selected')} />
              Selected rows ({selectedRowIds.size})
            </label>
            <label>
              <input type="radio" checked={scope === 'all'} onChange={() => setScope('all')} />
              All filtered rows ({filteredSortedRows.length})
            </label>
          </div>
        )}

        <label className="export-dialog-format">
          Format:
          <select value={effectiveFormat} onChange={(e) => setFormat(e.target.value as ExportFormat)} disabled={xlsxRowLimitExceeded}>
            <option value="xlsx">XLSX</option>
            <option value="csv">CSV</option>
          </select>
        </label>
        {xlsxRowLimitExceeded && (
          <p className="merge-contacts-warning">
            Per daug eilučių XLSX formatui ({(previewCount + 1).toLocaleString('lt-LT')} &gt; {XLSX_MAX_ROWS.toLocaleString('lt-LT')}) —
            naudokite CSV formatą arba sumažinkite pasirinktų eilučių kiekį.
          </p>
        )}

        {errorMessage && <p className="search-result-detail-error">{errorMessage}</p>}

        <div className="popover-footer">
          <button type="button" onClick={onClose} disabled={status === 'preparing'}>
            Atšaukti
          </button>
          <button type="button" className="primary" onClick={() => void handleExportClick()} disabled={status === 'preparing' || previewCount === 0}>
            {status === 'preparing' ? 'Ruošiama…' : 'Export'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
