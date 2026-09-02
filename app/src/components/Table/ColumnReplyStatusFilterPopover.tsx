import { Popover } from '../Popover';
import { INTEREST_LABEL_COLORS } from '../../utils/instantlyApi';

// Sentinel for "filter to rows with a reply entry, any status" — distinct
// from any real INTEREST_STATUS_LABELS value (those are always plain
// label text like "Interested"/"Lead"), same "reserved literal" idea as
// ColumnColorFilterPopover's own NO_COLOR_FILTER_VALUE.
export const ANY_REPLY_FILTER_VALUE = '__any_reply__';

interface ColumnReplyStatusFilterPopoverProps {
  anchor: HTMLElement;
  columnName: string;
  /** Every distinct lead_status actually present among this column's
   * reply-sourced entries right now (see TableView's own computation) —
   * same "only what's genuinely there, not a fixed palette" rule as
   * ColumnColorFilterPopover's availableColors. */
  availableStatuses: string[];
  current: string | undefined;
  onApply: (value: string) => void;
  onClear: () => void;
  /** Same one-time/permanent semantics as the header A→Z/Z→A sort (see
   * TableView's commitSort) — clicking commits a real row order right
   * away rather than holding a separate "currently sorted" mode. 'asc' =
   * oldest reply first ("1st received email → 2nd → 3rd…", the ordering
   * asked for), 'desc' = newest first. Rows with no reply entry in this
   * column always sort to the end regardless of direction, same
   * blanks-last convention commitSort already uses for a numeric column. */
  onSortByReceivedDate: (direction: 'asc' | 'desc') => void;
  onClose: () => void;
}

/** "Filtruoti pagal atsakymo statusą" — additive alongside search/sort/the
 * numeric range filter/the color filter, same one-click-applies shape as
 * all three. Deliberately scoped to entries carrying `replyFields` (see
 * NoteEntry's own doc comment in noteHistory.ts) — a hand-typed comment
 * has no lead_status at all and never matches here, which is the whole
 * point: the user's own manual notes and PushReplyRowsModal's pushed
 * campaign replies share one History column, but only the latter carries
 * an interest status worth filtering by. "Turi atsakymą" (ANY_REPLY_
 * FILTER_VALUE) covers "has a reply at all, any status" — the first,
 * coarser half of the ask; picking one of the statuses below narrows
 * further to that specific one. */
export function ColumnReplyStatusFilterPopover({
  anchor,
  columnName,
  availableStatuses,
  current,
  onApply,
  onClear,
  onSortByReceivedDate,
  onClose,
}: ColumnReplyStatusFilterPopoverProps) {
  const apply = (value: string) => {
    onApply(value);
    onClose();
  };
  const sort = (direction: 'asc' | 'desc') => {
    onSortByReceivedDate(direction);
    onClose();
  };
  return (
    <Popover anchor={anchor}>
      <div className="popover-field-label">Filtruoti „{columnName}“ (atsakymo statusas)</div>
      <div className="column-reply-status-filter-list">
        <button
          type="button"
          className={`column-reply-status-filter-item ${current === ANY_REPLY_FILTER_VALUE ? 'active' : ''}`}
          onClick={() => apply(ANY_REPLY_FILTER_VALUE)}
        >
          Turi atsakymą (bet kokio statuso)
        </button>
        {availableStatuses.map((status) => (
          <button
            key={status}
            type="button"
            className={`column-reply-status-filter-item ${current === status ? 'active' : ''}`}
            onClick={() => apply(status)}
          >
            <span className="column-reply-status-filter-dot" style={{ backgroundColor: INTEREST_LABEL_COLORS[status] ?? '#8a8f98' }} />
            {status}
          </button>
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
