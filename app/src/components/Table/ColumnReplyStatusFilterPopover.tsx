import { Popover } from '../Popover';
import { INTEREST_LABEL_COLORS } from '../../utils/instantlyApi';

// Sentinel for "filter to rows with a reply entry, any status" — distinct
// from any real INTEREST_STATUS_LABELS value (those are always plain
// label text like "Interested"/"Lead"), same "reserved literal" idea as
// ColumnColorFilterPopover's own NO_COLOR_FILTER_VALUE. One more checkable
// item in the list below, not special-cased in the OR-matching logic —
// see TableView's filteredSortedRows memo.
export const ANY_REPLY_FILTER_VALUE = '__any_reply__';

interface ColumnReplyStatusFilterPopoverProps {
  anchor: HTMLElement;
  columnName: string;
  /** Every distinct lead_status actually present among this column's
   * reply-sourced entries right now (see TableView's own computation) —
   * same "only what's genuinely there, not a fixed palette" rule as
   * ColumnColorFilterPopover's availableColors. */
  availableStatuses: string[];
  /** Every currently-selected value for this column (statuses and/or
   * ANY_REPLY_FILTER_VALUE) — on explicit request, multiple statuses can
   * be checked at once and are OR'd together (a row matches if it has a
   * reply matching ANY checked value), not AND'd. Empty array/absent from
   * the parent map both mean "no filter on this column". */
  current: string[];
  /** Toggles one value in/out of `current` — the popover stays open after
   * this (unlike the old single-select version, which applied-and-closed
   * on one click), since picking several statuses needs several clicks in
   * a row. */
  onToggle: (value: string) => void;
  /** Checks every value currently listed (every available status plus the
   * "any reply" row) — distinct from onClear: this still requires a row
   * to have *some* reply, just no longer narrows by which status; onClear
   * removes the filter on this column entirely (rows without any reply
   * show again too). */
  onSelectAll: () => void;
  onClear: () => void;
  /** Same one-time/permanent semantics as the header A→Z/Z→A sort (see
   * TableView's commitSort) — clicking commits a real row order right
   * away rather than holding a separate "currently sorted" mode. 'asc' =
   * oldest reply first ("1st received email → 2nd → 3rd…", the ordering
   * asked for), 'desc' = newest first. Rows with no reply entry in this
   * column always sort to the end regardless of direction, same
   * blanks-last convention commitSort already uses for a numeric column.
   * Independent of the status selection above — sorting and filtering are
   * separate operations here, same as everywhere else in this app. */
  onSortByReceivedDate: (direction: 'asc' | 'desc') => void;
  onClose: () => void;
}

/** "Filtruoti pagal atsakymo statusą" — additive alongside search/sort/the
 * numeric range filter/the color filter, same "additive, not a
 * replacement" idea as all three. Deliberately scoped to entries carrying
 * `replyFields` (see NoteEntry's own doc comment in noteHistory.ts) — a
 * hand-typed comment has no lead_status at all and never matches here,
 * which is the whole point: the user's own manual notes and
 * PushReplyRowsModal's pushed campaign replies share one History column,
 * but only the latter carries an interest status worth filtering by.
 *
 * Multi-select, OR'd together — on explicit request ("[Interesting] +
 * [Not interesting] → show contacts with either status"), not AND (a
 * single reply entry only ever has one status, so requiring a row to
 * match *every* checked status at once could never show anything once
 * more than one box is checked). Each row is a checkbox rather than the
 * earlier click-applies-and-closes button, since building up a selection
 * of several statuses needs the popover to stay open between clicks. */
export function ColumnReplyStatusFilterPopover({
  anchor,
  columnName,
  availableStatuses,
  current,
  onToggle,
  onSelectAll,
  onClear,
  onSortByReceivedDate,
  onClose,
}: ColumnReplyStatusFilterPopoverProps) {
  const sort = (direction: 'asc' | 'desc') => {
    onSortByReceivedDate(direction);
    onClose();
  };
  const isChecked = (value: string) => current.includes(value);
  return (
    <Popover anchor={anchor}>
      <div className="popover-field-label">Filtruoti „{columnName}“ (atsakymo statusas)</div>
      <div className="column-reply-status-filter-select-row">
        <button type="button" onClick={onSelectAll}>
          Pasirinkti visus
        </button>
        <button type="button" onClick={onClear}>
          Išvalyti pasirinkimą
        </button>
      </div>
      <div className="column-reply-status-filter-list">
        <label className="column-reply-status-filter-item">
          <input type="checkbox" checked={isChecked(ANY_REPLY_FILTER_VALUE)} onChange={() => onToggle(ANY_REPLY_FILTER_VALUE)} />
          Turi atsakymą (bet kokio statuso)
        </label>
        {availableStatuses.map((status) => (
          <label key={status} className="column-reply-status-filter-item">
            <input type="checkbox" checked={isChecked(status)} onChange={() => onToggle(status)} />
            <span className="column-reply-status-filter-dot" style={{ backgroundColor: INTEREST_LABEL_COLORS[status] ?? '#8a8f98' }} />
            {status}
          </label>
        ))}
        {availableStatuses.length === 0 && <div className="column-reply-status-filter-empty">Šiame stulpelyje dar nėra atsakymų su statusu.</div>}
      </div>
      <div className="popover-field-label">Rikiuoti atsakymus pagal gavimo datą</div>
      <div className="column-reply-status-filter-sort-row">
        <button type="button" onClick={() => sort('asc')}>
          1 → N (seniausias pirmas)
        </button>
        <button type="button" onClick={() => sort('desc')}>
          N → 1 (naujausias pirmas)
        </button>
      </div>
      <div className="popover-footer">
        <button
          type="button"
          onClick={() => {
            onClear();
            onClose();
          }}
        >
          Išvalyti filtrą
        </button>
      </div>
    </Popover>
  );
}
