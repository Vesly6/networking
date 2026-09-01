import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Row, TableMeta } from '../../types';
import { getTable, loadRowsForTable, saveRows } from '../../db/db';
import { useTableStore, type CellColorUpdate } from '../../store/useTableStore';
import { buildEmailIndex } from '../../utils/emailMatch';
import { REPLY_STORED_FIELD_ORDER, resolveReplyFields, cleanReplyText, extractLatestEmailMessages } from '../../utils/replyHistoryFormat';
import { addNoteEntry } from '../../utils/noteHistory';
import { fetchInstantlyTableMap, saveInstantlyTableMapping } from '../../utils/instantlyTableMap';
import { VISI_ATSAKYMAI_TABLE_NAME } from '../../utils/instantlyReplySync';

interface PushReplyRowsModalProps {
  rows: Row[];
  sourceColumns: TableMeta['columns'];
  tables: TableMeta[];
  currentUserName?: string;
  onClose: () => void;
  onDone: (message: string) => void;
}

// A light, "done"-reading pastel green (same muted-pill palette
// NOTE_TAGS/replyHistoryFormat.ts's own tag colors already use) — marks
// which "Visi atsakymai" rows have already been pushed into a
// destination table's History, on explicit request ("чтоб понимать что
// вообще происходит"), applied across every column so the whole row
// reads as colored, not just one cell.
const PUSHED_ROW_COLOR = '#d7f0da';

/** Resolves the destination table's History column — by NAME first
 * ("History"), falling back to the first note-type column, rather than a
 * bare .find(c => c.type === 'note') — guards against a future table
 * that ends up with more than one note column. */
function resolveHistoryColumnId(table: TableMeta): string | null {
  const byName = table.columns.find((c) => c.name === 'History' && c.type === 'note');
  if (byName) return byName.id;
  const firstNote = table.columns.find((c) => c.type === 'note');
  return firstNote?.id ?? null;
}

/** The "manual + suggestion" export dialog — pushes selected "Visi
 * atsakymai" rows into the matching lead's row (by email) in a chosen
 * destination table's History column. Opened from TableView.tsx's new
 * toolbar button, only visible while the active table is literally "Visi
 * atsakymai" and something is selected. */
export function PushReplyRowsModal({ rows, sourceColumns, tables, currentUserName, onClose, onDone }: PushReplyRowsModalProps) {
  const destinationOptions = useMemo(() => tables.filter((t) => t.name !== VISI_ATSAKYMAI_TABLE_NAME), [tables]);
  const [destTableId, setDestTableId] = useState('');
  const [rememberMapping, setRememberMapping] = useState(true);
  const [pushing, setPushing] = useState(false);

  // Only suggest/offer to remember a mapping when every selected row
  // shares exactly one campaign_name — nothing sensible to remember for a
  // mixed selection.
  const singleCampaignName = useMemo(() => {
    const names = new Set(rows.map((r) => resolveReplyFields(r, sourceColumns).campaign_name));
    return names.size === 1 ? [...names][0] : null;
  }, [rows, sourceColumns]);

  useEffect(() => {
    if (!singleCampaignName) return;
    let cancelled = false;
    void fetchInstantlyTableMap().then(({ map }) => {
      if (cancelled) return;
      const suggestedName = map[singleCampaignName];
      if (!suggestedName) return;
      const suggested = destinationOptions.find((t) => t.name === suggestedName);
      if (suggested) setDestTableId(suggested.id);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [singleCampaignName]);

  const handleConfirm = async () => {
    if (!destTableId) return;
    setPushing(true);
    try {
      const destTable = await getTable(destTableId);
      if (!destTable) {
        onDone('Pasirinkta lentelė nerasta.');
        return;
      }
      const historyColId = resolveHistoryColumnId(destTable);
      if (!historyColId) {
        onDone(`„${destTable.name}“ neturi Istorijos (note) stulpelio — nėra kur įrašyti.`);
        return;
      }
      const destRows = await loadRowsForTable(destTableId);
      const emailIndex = buildEmailIndex(destRows, destTable.columns);

      // Oldest-first before processing: addNoteEntry always PREPENDS, so
      // walking replies oldest-to-newest means the final History list
      // still reads newest-first, even when several selected replies
      // (e.g. a 10-message back-and-forth from one lead) all land in the
      // same destination row.
      const sortedRows = [...rows].sort(
        (a, b) => resolveReplyFields(a, sourceColumns).received_at.localeCompare(resolveReplyFields(b, sourceColumns).received_at),
      );
      const sortedFields = sortedRows.map((r) => resolveReplyFields(r, sourceColumns));
      // One batched call for every selected row's raw reply_text (see
      // extractLatestEmailMessages' own doc comment for why — a real
      // reply's reply_text is the whole quoted thread, not just the new
      // message) — falls back to the original raw texts on failure, so a
      // slow/unavailable AI step never blocks the push itself.
      const cleanedReplyTexts = await extractLatestEmailMessages(sortedFields.map((f) => f.reply_text));

      // Accumulates progressively per destination row id — reading
      // match.cells[historyColId] fresh every time (instead of tracking
      // what's already been added THIS run) would silently overwrite an
      // earlier iteration's entry whenever two+ selected replies share
      // the same destination row: a real bug caught before it shipped —
      // multiple replies from one lead used to only keep the LAST one.
      const historyByRowId = new Map<string, string>();
      const matchedRows = new Map<string, Row>();
      const pushedSourceRowIds: string[] = [];
      let pushed = 0;
      let skipped = 0;

      for (let i = 0; i < sortedRows.length; i++) {
        const replyRow = sortedRows[i];
        const fields = sortedFields[i];
        const email = fields.lead_email.trim().toLowerCase();
        const match = email ? emailIndex.get(email) : undefined;
        if (!match) {
          skipped++;
          continue;
        }
        const current = historyByRowId.get(match.id) ?? (match.cells[historyColId] ?? '');
        const replyFields: Record<string, string> = {};
        for (const key of REPLY_STORED_FIELD_ORDER) replyFields[key] = fields[key];
        // A real, caught bug: addNoteEntry silently no-ops on an empty/
        // whitespace-only body (a deliberate guard against an accidental
        // blank hand-typed submission elsewhere) — but a genuine Instantly
        // reply can legitimately have no body text at all (confirmed live:
        // several real rows had reply_text === "\n"), and the tags alone
        // (subject/date/campaign/etc.) are still real, wanted information.
        // Falling through to that guard meant "pridėta" over-reported —
        // the row was found and counted as pushed, but nothing was
        // actually written. The placeholder guarantees addNoteEntry's
        // trim-check always passes for a genuine match.
        const bodyText = cleanReplyText(cleanedReplyTexts[i] ?? fields.reply_text) || '(nėra teksto)';
        const next = addNoteEntry(current, bodyText, currentUserName, replyFields);
        historyByRowId.set(match.id, next);
        matchedRows.set(match.id, match);
        pushedSourceRowIds.push(replyRow.id);
        pushed++;
      }

      const toSave = [...matchedRows.values()].map((row) => ({
        ...row,
        cells: { ...row.cells, [historyColId]: historyByRowId.get(row.id)! },
        updatedAt: Date.now(),
      }));
      if (toSave.length > 0) await saveRows(toSave);

      // Color the pushed SOURCE rows (in "Visi atsakymai", the currently
      // active table) — on explicit request, a visible marker for which
      // replies have already been exported, across every column so the
      // whole row reads as colored at a glance, same mechanism the "🎨
      // Color" toolbar fill already uses.
      if (pushedSourceRowIds.length > 0) {
        const colorUpdates: CellColorUpdate[] = [];
        for (const rowId of pushedSourceRowIds) {
          for (const col of sourceColumns) colorUpdates.push({ rowId, columnId: col.id, color: PUSHED_ROW_COLOR });
        }
        useTableStore.getState().setCellColors(colorUpdates);
      }

      if (rememberMapping && singleCampaignName) await saveInstantlyTableMapping(singleCampaignName, destTable.name);

      onDone(`„${destTable.name}“: pridėta ${pushed}, praleista (nerasta atitikmens): ${skipped}`);
    } catch (err) {
      onDone(err instanceof Error ? err.message : 'Nepavyko perkelti į lentelę');
    } finally {
      setPushing(false);
    }
  };

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal push-reply-rows-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Perkelti į lentelę</h2>
        <p className="csv-import-mapping-hint">
          Pasirinktos eilutės ({rows.length}) bus ieškomos pagal el. paštą pasirinktoje lentelėje ir įrašytos į
          atitinkamos eilutės Istoriją.
        </p>
        <select value={destTableId} onChange={(e) => setDestTableId(e.target.value)}>
          <option value="">— Pasirinkite lentelę —</option>
          {destinationOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {singleCampaignName && (
          <label className="push-reply-rows-remember">
            <input type="checkbox" checked={rememberMapping} onChange={(e) => setRememberMapping(e.target.checked)} />
            Įsiminti šį susiejimą kampanijai „{singleCampaignName}“
          </label>
        )}
        <div className="popover-footer">
          <button type="button" onClick={onClose}>
            Atšaukti
          </button>
          <button type="button" className="primary" disabled={!destTableId || pushing} onClick={() => void handleConfirm()}>
            {pushing ? 'Perkeliama…' : 'Perkelti'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
