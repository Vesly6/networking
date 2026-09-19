import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { Column, Row } from '../../types';
import { getColumnByType } from '../../utils/row';
import { buildExportRows, XLSX_MAX_ROWS, XLSX_MAX_COLUMNS, type ExportAxisOptions } from '../../utils/exportFlatten';
import { runExport, ExportRowLimitError } from '../../utils/exportTableApi';
import { runDemoExport } from '../../utils/exportTableDemo';
import { DEMO_MODE } from '../../utils/demoMode';
import { useToastStore } from '../../store/useToastStore';
import {
  BASE_DEFAULT_SETTINGS,
  BUILT_IN_PRESETS,
  loadLastUsedSettings,
  loadUserPresets,
  saveLastUsedSettings,
  saveUserPreset,
  deleteUserPreset,
  type ExportSettings,
  type ExportPreset,
} from '../../utils/exportPresets';

interface ExportDialogProps {
  tableId: string;
  columns: Column[]; // full list, incl. hidden — this component filters itself
  allRows: Row[]; // full store rows, incl. hidden — the "of N" unfiltered baseline
  filteredSortedRows: Row[];
  selectedRowIds: Set<string>;
  isFilterActive: boolean;
  canExportContacts: boolean;
  /** A separate, independent permission from canExportContacts — see
   * permissions/registry.ts's own doc comment on export.replies. Gates the
   * "Atsakymai" (replies) axis specifically, not the whole dialog. */
  canExportReplies: boolean;
  onClose: () => void;
}

type ExportScope = 'all' | 'selected';

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Export — three independent axes (contacts/notes/replies, each
 * cell-and/or-columns, freely combinable — see utils/exportFlatten.ts's
 * own header comment) layered on top of the original two-mode row
 * structure (Companies only / Companies with contacts), which is
 * unchanged. Row counts AND column counts are computed synchronously
 * client-side (buildExportRows over already-in-memory data), so the live
 * preview needs no server round trip — the actual file generation still
 * always goes through one path per build: the real server route (utils/
 * exportTableApi.ts) in a normal build, or a fully client-side path
 * (utils/exportTableDemo.ts) in the demo build. */
export function ExportDialog({
  tableId,
  columns,
  allRows,
  filteredSortedRows,
  selectedRowIds,
  isFilterActive,
  canExportContacts,
  canExportReplies,
  onClose,
}: ExportDialogProps) {
  const showToast = useToastStore((s) => s.show);
  const contactColumn = useMemo(() => getColumnByType(columns, 'contact'), [columns]);

  const [settings, setSettings] = useState<ExportSettings>(() => loadLastUsedSettings() ?? BASE_DEFAULT_SETTINGS);
  const [scope, setScope] = useState<ExportScope>('all');
  const [status, setStatus] = useState<'idle' | 'preparing' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [structureOpen, setStructureOpen] = useState(false);
  const [presetNameDraft, setPresetNameDraft] = useState('');
  const [userPresets, setUserPresets] = useState<ExportPreset[]>(() => loadUserPresets());

  const patch = (p: Partial<ExportSettings>) => setSettings((s) => ({ ...s, ...p }));
  const { mode, format, includeCompaniesWithoutContacts, onlyContactsWithEmail, prettyFormat, contactsCell, contactsColumns, notesCell, notesColumns, repliesCell, repliesColumns, limits } = settings;

  const visibleColumns = useMemo(() => columns.filter((c) => !c.hidden), [columns]);
  const hasNoteColumn = useMemo(() => visibleColumns.some((c) => c.type === 'note'), [visibleColumns]);
  const visibleAllRows = useMemo(() => allRows.filter((r) => !r.hidden), [allRows]);
  const canShowScopeToggle = selectedRowIds.size >= 2;
  const scopedRows = useMemo(
    () => (scope === 'selected' ? filteredSortedRows.filter((r) => selectedRowIds.has(r.id)) : filteredSortedRows),
    [scope, filteredSortedRows, selectedRowIds],
  );

  const withContactsAllowed = !!contactColumn && canExportContacts;
  // The contacts axis (cell/columns) only ever applies to companies_only
  // mode — with_contacts already IS the row-per-contact expansion (see
  // the account owner's own spec, section 8's compatibility table).
  // Rendered disabled-with-explanation rather than hidden when
  // unavailable, same "explain, don't just hide" rule section 8 asks for.
  const contactsAxisAvailable = mode === 'companies_only' && !!contactColumn && canExportContacts;
  const repliesAxisAvailable = hasNoteColumn && canExportReplies;

  const axis: ExportAxisOptions = useMemo(
    () => ({
      contactsCell: contactsAxisAvailable && contactsCell,
      contactsColumns: contactsAxisAvailable && contactsColumns,
      notesCell: hasNoteColumn && notesCell,
      notesColumns: hasNoteColumn && notesColumns,
      repliesCell: repliesAxisAvailable && repliesCell,
      repliesColumns: repliesAxisAvailable && repliesColumns,
      limits,
      prettyFormat,
    }),
    [contactsAxisAvailable, contactsCell, contactsColumns, hasNoteColumn, notesCell, notesColumns, repliesAxisAvailable, repliesCell, repliesColumns, limits, prettyFormat],
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
        axis,
      }),
    [visibleColumns, scopedRows, mode, contactColumn, includeCompaniesWithoutContacts, onlyContactsWithEmail, axis],
  );
  const previewCount = preview.dataRows.length;
  const columnCount = preview.headerRow.length;

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
      axis,
    }).dataRows.length;
  }, [mode, visibleAllRows, visibleColumns, contactColumn, includeCompaniesWithoutContacts, onlyContactsWithEmail, axis]);

  const xlsxRowLimitExceeded = previewCount + 1 > XLSX_MAX_ROWS;
  const xlsxColumnLimitExceeded = columnCount > XLSX_MAX_COLUMNS;
  const xlsxColumnLimitClose = !xlsxColumnLimitExceeded && columnCount > XLSX_MAX_COLUMNS * 0.8;
  const effectiveFormat: 'csv' | 'xlsx' = xlsxRowLimitExceeded || xlsxColumnLimitExceeded ? 'csv' : format;

  const buildFilename = (fmt: 'csv' | 'xlsx'): string => {
    const parts = ['irms', 'companies'];
    if (mode === 'with_contacts') parts.push('contacts');
    if (scope === 'selected') parts.push('selected');
    else if (isFilterActive) parts.push('filtered');
    parts.push(todayDateString());
    return `${parts.join('_')}.${fmt}`;
  };

  const applyPreset = (preset: ExportPreset) => {
    setSettings(preset.settings);
  };

  const handleSavePreset = () => {
    const name = presetNameDraft.trim();
    if (!name) return;
    saveUserPreset({ name, settings });
    setUserPresets(loadUserPresets());
    setPresetNameDraft('');
    showToast(`Presetas „${name}“ išsaugotas`);
  };

  const handleDeletePreset = (name: string) => {
    deleteUserPreset(name);
    setUserPresets(loadUserPresets());
  };

  const handleExportClick = async () => {
    if (status === 'preparing') return;
    setStatus('preparing');
    setErrorMessage(null);
    showToast('Ruošiamas failas…');
    const filename = buildFilename(effectiveFormat);
    saveLastUsedSettings(settings);
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
          axis,
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
          axis,
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

  const overflowMessages: string[] = [];
  if (preview.overflow.contacts) overflowMessages.push(`Kai kurios įmonės turi daugiau nei ${limits.contacts} kontaktų — likusieji sudėti į paskutinį stulpelį.`);
  if (preview.overflow.notes) overflowMessages.push(`Kai kurios eilutės turi daugiau nei ${limits.notes} pastabų — likusios sudėtos į paskutinį stulpelį.`);
  if (preview.overflow.replies) overflowMessages.push(`Kai kurios eilutės turi daugiau nei ${limits.replies} atsakymų — likę sudėti į paskutinį stulpelį.`);

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal export-dialog export-dialog-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Eksportuoti</h2>

        {/* A real, reported bug in the shared .modal base class, not just
            this dialog: .modal sets max-height but never overflow-y, so
            content taller than that budget doesn't scroll — it visually
            spills out past the dialog's own bottom border instead,
            carrying the Atšaukti/Export buttons down below the visible
            box with it ("кнопки уезжают на низ"). Every other .modal user
            (ConfirmDialog, CsvImportMapping, …) never had content tall
            enough to hit this; three independent axis sections pushed
            this one past that threshold, but the fix is scoped to just
            this dialog (a body wrapper that scrolls on its own, with the
            title and footer buttons kept OUTSIDE it so they stay pinned
            and always reachable) rather than changing the shared base
            class's behavior for every other modal at once. */}
        <div className="export-dialog-body">
        <div className="export-dialog-presets">
          <span>Presetas:</span>
          <select
            value=""
            onChange={(e) => {
              const all = [...BUILT_IN_PRESETS, ...userPresets];
              const found = all.find((p) => p.name === e.target.value);
              if (found) applyPreset(found);
            }}
          >
            <option value="" disabled>
              Pasirinkti…
            </option>
            {BUILT_IN_PRESETS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
            {userPresets.length > 0 && (
              <>
                <option value="" disabled>
                  ──────────
                </option>
                {userPresets.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </>
            )}
          </select>
          <input
            type="text"
            className="export-dialog-preset-name"
            placeholder="Naujo preseto pavadinimas…"
            value={presetNameDraft}
            onChange={(e) => setPresetNameDraft(e.target.value)}
          />
          <button type="button" onClick={handleSavePreset} disabled={!presetNameDraft.trim()}>
            Išsaugoti
          </button>
          {userPresets.some((p) => p.name === presetNameDraft.trim()) && (
            <button type="button" onClick={() => handleDeletePreset(presetNameDraft.trim())} title="Ištrinti šį presetą">
              Trinti
            </button>
          )}
        </div>

        <div className="export-dialog-section-title">Eilučių struktūra</div>
        <div className="export-dialog-mode">
          <label>
            <input type="radio" checked={mode === 'companies_only'} onChange={() => patch({ mode: 'companies_only' })} />
            <span>
              Companies only
              <span className="export-dialog-mode-hint">Viena eilutė = viena įmonė. Kontaktai neįtraukiami (nebent pažymėta žemiau).</span>
            </span>
          </label>
          <label className={!withContactsAllowed ? 'export-dialog-mode-disabled' : undefined}>
            <input
              type="radio"
              checked={mode === 'with_contacts'}
              disabled={!withContactsAllowed}
              onChange={() => patch({ mode: 'with_contacts' })}
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

        {!!contactColumn && canExportContacts && (
          <div className="export-dialog-axis">
            <div className="export-dialog-axis-title">
              Kontaktai {mode !== 'companies_only' && <span className="export-dialog-axis-disabled-hint">(pasiekiama tik su „Companies only“)</span>}
            </div>
            <label className={mode !== 'companies_only' ? 'export-dialog-mode-disabled' : undefined}>
              <input type="checkbox" checked={contactsCell} disabled={mode !== 'companies_only'} onChange={(e) => patch({ contactsCell: e.target.checked })} />
              Visi kontaktai vienoje ląstelėje
            </label>
            <label className={mode !== 'companies_only' ? 'export-dialog-mode-disabled' : undefined}>
              <input
                type="checkbox"
                checked={contactsColumns}
                disabled={mode !== 'companies_only'}
                onChange={(e) => patch({ contactsColumns: e.target.checked })}
              />
              Kiekvienas kontaktas atskiru stulpeliu (Kontaktas 1, Kontaktas 2…)
            </label>
            {mode === 'companies_only' && contactsColumns && (
              <label className="export-dialog-limit">
                Maksimalus kontaktų kiekis stulpeliuose:
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={limits.contacts}
                  onChange={(e) => patch({ limits: { ...limits, contacts: Math.max(1, Number(e.target.value) || 1) } })}
                />
              </label>
            )}
          </div>
        )}

        {hasNoteColumn && (
          <div className="export-dialog-axis">
            <div className="export-dialog-axis-title">Pastabos</div>
            <label>
              <input type="checkbox" checked={notesCell} onChange={(e) => patch({ notesCell: e.target.checked })} />
              Visos pastabos vienoje ląstelėje
            </label>
            <label>
              <input type="checkbox" checked={notesColumns} onChange={(e) => patch({ notesColumns: e.target.checked })} />
              Kiekviena pastaba atskiru stulpeliu (Pastaba 1 = naujausia)
            </label>
            {notesColumns && (
              <label className="export-dialog-limit">
                Maksimalus pastabų kiekis stulpeliuose:
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={limits.notes}
                  onChange={(e) => patch({ limits: { ...limits, notes: Math.max(1, Number(e.target.value) || 1) } })}
                />
              </label>
            )}
          </div>
        )}

        {hasNoteColumn && (
          <div className="export-dialog-axis">
            <div className="export-dialog-axis-title">
              Atsakymų istorija {!canExportReplies && <span className="export-dialog-axis-disabled-hint">(neturite teisės)</span>}
            </div>
            <label className={!canExportReplies ? 'export-dialog-mode-disabled' : undefined}>
              <input type="checkbox" checked={repliesCell} disabled={!canExportReplies} onChange={(e) => patch({ repliesCell: e.target.checked })} />
              Visi atsakymai vienoje ląstelėje
            </label>
            <label className={!canExportReplies ? 'export-dialog-mode-disabled' : undefined}>
              <input
                type="checkbox"
                checked={repliesColumns}
                disabled={!canExportReplies}
                onChange={(e) => patch({ repliesColumns: e.target.checked })}
              />
              Kiekvienas laiškas atskiru stulpeliu (Laiškas 1 = naujausias)
            </label>
            {canExportReplies && repliesColumns && (
              <label className="export-dialog-limit">
                Maksimalus laiškų kiekis stulpeliuose:
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={limits.replies}
                  onChange={(e) => patch({ limits: { ...limits, replies: Math.max(1, Number(e.target.value) || 1) } })}
                />
              </label>
            )}
          </div>
        )}

        {hasNoteColumn && (
          <label
            className="export-dialog-pretty-notes"
            title="Kaip atrodo pastabų/atsakymų TEKSTAS pasirinktuose stulpeliuose/ląstelėse aukščiau — data/autorius prie kiekvieno įrašo, o ne raide tvarko, ar jie apskritai įtraukiami."
          >
            <input type="checkbox" checked={prettyFormat} onChange={(e) => patch({ prettyFormat: e.target.checked })} />
            Gražiai suformatuoti pastabas ir atsakymus (data, autorius) — vietoje grynojo teksto
          </label>
        )}

        <div className="export-dialog-count">
          Eksportas: {previewCount} iš {totalCount} {mode === 'companies_only' ? 'įmonių' : 'kontaktų'} × {columnCount} stulpelių
          {scope === 'selected' ? ' (pasirinktos eilutės)' : isFilterActive ? ' (pritaikytas filtras)' : ''}
        </div>

        <button type="button" className="export-dialog-structure-toggle" onClick={() => setStructureOpen((v) => !v)}>
          {structureOpen ? <ChevronUp className="icon" size={14} /> : <ChevronDown className="icon" size={14} />}
          Rodyti struktūrą
        </button>
        {structureOpen && (
          <div className="export-dialog-structure-table-wrap">
            <table className="export-dialog-structure-table">
              <thead>
                <tr>
                  {preview.headerRow.map((h, i) => (
                    <th key={`${h}-${i}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.dataRows.slice(0, 5).map((row, ri) => (
                  <tr key={ri}>
                    {row.map((value, ci) => (
                      <td key={ci} title={value}>
                        {value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.dataRows.length > 5 && (
              <div className="export-dialog-structure-more">… ir dar {(preview.dataRows.length - 5).toLocaleString('lt-LT')} eilučių</div>
            )}
          </div>
        )}

        {overflowMessages.length > 0 && (
          <div className="export-dialog-overflow-warning">
            {overflowMessages.map((m) => (
              <p key={m}>{m}</p>
            ))}
          </div>
        )}

        {mode === 'with_contacts' && withContactsAllowed && (
          <div className="export-dialog-checkboxes">
            <label>
              <input
                type="checkbox"
                checked={includeCompaniesWithoutContacts}
                onChange={(e) => patch({ includeCompaniesWithoutContacts: e.target.checked })}
              />
              Include companies without contacts
            </label>
            <label>
              <input type="checkbox" checked={onlyContactsWithEmail} onChange={(e) => patch({ onlyContactsWithEmail: e.target.checked })} />
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
          <select value={effectiveFormat} onChange={(e) => patch({ format: e.target.value as 'csv' | 'xlsx' })} disabled={xlsxRowLimitExceeded || xlsxColumnLimitExceeded}>
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
        {xlsxColumnLimitExceeded && (
          <p className="merge-contacts-warning">
            Per daug stulpelių XLSX formatui ({columnCount.toLocaleString('lt-LT')} &gt; {XLSX_MAX_COLUMNS.toLocaleString('lt-LT')}) — naudokite
            CSV formatą arba sumažinkite pažymėtų ašių kiekį/limitus.
          </p>
        )}
        {xlsxColumnLimitClose && !xlsxColumnLimitExceeded && (
          <p className="export-dialog-column-warning">
            Artėjama prie XLSX stulpelių limito ({columnCount.toLocaleString('lt-LT')} iš {XLSX_MAX_COLUMNS.toLocaleString('lt-LT')}).
          </p>
        )}
        </div>

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
