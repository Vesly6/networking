import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import type { Column, Row } from '../../types';
import { useTableStore } from '../../store/useTableStore';
import { useToastStore } from '../../store/useToastStore';
import { combineDateTime, getDatePart, getTimePart } from '../../utils/date';
import { getLatestNoteText } from '../../utils/noteHistory';
import { getContactsSummary, parseContacts, contactTextToFields } from '../../utils/contacts';
import { Popover } from '../Popover';
import { ensureProtocol } from '../../utils/link';
import { highlightMatches } from '../../utils/highlight';
import { EXCEL_CELL_LIMIT } from '../../constants';

interface DataCellProps {
  row: Row;
  column: Column;
  selected: boolean;
  /** selected && not mid drag-select — see TableView: converting to a live
   * `<input>` while the user is still dragging a range would swap
   * button↔input on every cell the drag passes over. */
  editable: boolean;
  inRange: boolean;
  // Used both as onMouseDown (mouse click/drag-start) and, for the
  // dropdown/date/time controls, as onFocus (keyboard tab or a click that
  // native focus handling reports as a FocusEvent, not a MouseEvent) — the
  // union covers both. onExtend is only ever onMouseEnter.
  onSelect: (e: ReactMouseEvent | ReactFocusEvent) => void;
  onExtend: (e: ReactMouseEvent) => void;
  /** note/contact only — opens CellHoverEditor for this cell. Named for
   * what it does, not how it's triggered; see the click handler below. */
  onOpenEditor: (anchor: HTMLElement) => void;
  /** The active search box query, trimmed — only ever set on rows the
   * search has already matched, so this just highlights *where* the match
   * is within that row's cells. Undefined/empty means no active search. */
  highlightQuery?: string;
  /** Raw stored value of this row's `contact`-type column (whichever one,
   * if any — see getColumnByType), for the next-action-date cell's "who to
   * call" picker. Only read by the `date` branch when `column.isNextActionDate`. */
  contactsRaw?: string;
}

function DataCellImpl({
  row,
  column,
  selected,
  editable,
  inRange,
  onSelect,
  onExtend,
  onOpenEditor,
  highlightQuery,
  contactsRaw,
}: DataCellProps) {
  const updateCell = useTableStore((s) => s.updateCell);
  const setLinkedContact = useTableStore((s) => s.setLinkedContact);
  const showToast = useToastStore((s) => s.show);
  const storedValue = row.cells[column.id] ?? '';
  const color = row.colors?.[column.id];
  // Declared unconditionally (not just inside the branches that use them)
  // so the hook order stays stable even if this column's type changes.
  const [timeExpanded, setTimeExpanded] = useState(false);
  const [contactPickerAnchor, setContactPickerAnchor] = useState<HTMLElement | null>(null);
  const [draft, setDraft] = useState(storedValue);
  useEffect(() => {
    setDraft(storedValue);
  }, [storedValue]);

  // Autosave for text | phone | company. A plain onBlur isn't reliable on
  // its own: single-clicking a *different* cell flips this cell's `editable`
  // prop to false in the same render pass that reacts to the other cell's
  // mousedown, which unmounts this <input> before the browser's native blur
  // event has a chance to fire — silently dropping the edit. Committing from
  // an effect cleanup keyed on `editable` catches that case too, since
  // cleanups run whenever `editable` flips to false (or on unmount), no
  // matter why. onBlur is kept alongside it for the cases where `editable`
  // doesn't change at all (Enter key, clicking outside the table).
  const skipCommitRef = useRef(false);
  const commitRef = useRef<() => void>(() => {});
  const commit = () => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    if (draft === storedValue) return;
    const truncated = updateCell(row.id, column.id, draft);
    if (truncated) {
      showToast(`Text truncated to Excel's cell limit — ${EXCEL_CELL_LIMIT.toLocaleString('en-US')} characters`);
      setDraft(row.cells[column.id] ?? '');
    }
  };
  commitRef.current = commit;
  useEffect(() => {
    if (!editable) return;
    return () => {
      commitRef.current();
    };
  }, [editable]);

  // `cell-row-bg` opts a cell INTO the zebra-stripe/row-hover background
  // (see App.css) — only when there's no custom color. This is a structural
  // exclusion, not a paint-order bet: a colored `<td>` simply isn't matched
  // by those selectors at all, so nothing can ever repaint over its color,
  // regardless of how any particular browser layers table backgrounds.
  const cellClassName = `cell cell-${column.type} ${selected ? 'cell-selected' : ''} ${inRange ? 'cell-in-range' : ''} ${color ? '' : 'cell-row-bg'}`;
  const cellStyle: CSSProperties | undefined = color ? { backgroundColor: color } : undefined;

  if (column.type === 'dropdown') {
    const optionColor = storedValue ? column.optionColors?.[storedValue] : undefined;
    // The option's own badge color wins if set; otherwise fall back to the
    // cell's generic fill color (from the 🎨 Color tool). Either way this is
    // an inline style on the <select> itself, not just the <td> — needed so
    // it still shows once the select gets focus (see the note by the
    // text/phone/company <input> below for why that matters).
    const selectColor = optionColor ?? color;
    return (
      <td
        className={cellClassName}
        style={cellStyle}
        onMouseDown={onSelect}
        onMouseEnter={onExtend}
      >
        <select
          value={storedValue}
          style={selectColor ? { backgroundColor: selectColor } : undefined}
          onFocus={onSelect}
          onChange={(e) => updateCell(row.id, column.id, e.target.value)}
        >
          <option value="">—</option>
          {(column.options ?? []).map((opt) => (
            <option key={opt} value={opt} style={column.optionColors?.[opt] ? { backgroundColor: column.optionColors[opt] } : undefined}>
              {opt}
            </option>
          ))}
        </select>
      </td>
    );
  }

  if (column.type === 'date') {
    const datePart = getDatePart(storedValue);
    const timePart = getTimePart(storedValue);
    const showTimeInput = timeExpanded || !!timePart;
    return (
      <td
        className={cellClassName}
        style={cellStyle}
        onMouseDown={onSelect}
        onMouseEnter={onExtend}
      >
        <div className="date-cell">
          <input
            type="date"
            style={cellStyle}
            value={datePart}
            onFocus={onSelect}
            onChange={(e) => updateCell(row.id, column.id, combineDateTime(e.target.value, timePart))}
          />
          {showTimeInput ? (
            <span className="date-cell-time-group">
              <input
                type="time"
                className="date-cell-time"
                style={cellStyle}
                value={timePart}
                onFocus={onSelect}
                onChange={(e) => updateCell(row.id, column.id, combineDateTime(datePart, e.target.value))}
              />
              <button
                type="button"
                className="date-cell-clear-time"
                title="Remove time"
                onClick={(e) => {
                  e.stopPropagation();
                  updateCell(row.id, column.id, datePart);
                  setTimeExpanded(false);
                }}
              >
                ×
              </button>
            </span>
          ) : (
            datePart && (
              <button
                type="button"
                className="date-cell-add-time"
                title="Add a specific time"
                onClick={(e) => {
                  e.stopPropagation();
                  setTimeExpanded(true);
                }}
              >
                🕐
              </button>
            )
          )}
          {column.isNextActionDate &&
            datePart &&
            (() => {
              const contacts = parseContacts(contactsRaw ?? '');
              const linked = contacts.find((c) => c.id === row.linkedContactId);
              return (
                <button
                  type="button"
                  className={`date-cell-contact-btn ${linked ? 'date-cell-contact-linked' : ''}`}
                  title={linked ? `Calling: ${linked.text}` : 'Pick who you\'re calling'}
                  onClick={(e) => {
                    e.stopPropagation();
                    const anchor = e.currentTarget;
                    setContactPickerAnchor((prev) => (prev ? null : anchor));
                  }}
                >
                  👤{linked ? ` ${contactTextToFields(linked.text).firstName || linked.text}` : ''}
                </button>
              );
            })()}
        </div>
        {contactPickerAnchor && (
          <Popover anchor={contactPickerAnchor} width={220}>
            <div className="popover-field">
              <span>Who are you calling?</span>
            </div>
            {parseContacts(contactsRaw ?? '').length === 0 ? (
              <div className="date-cell-contact-empty">No contacts on this row yet — add one in the Contacts cell.</div>
            ) : (
              parseContacts(contactsRaw ?? '').map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`date-cell-contact-option ${row.linkedContactId === c.id ? 'date-cell-contact-option-active' : ''}`}
                  onClick={() => {
                    setLinkedContact(row.id, row.linkedContactId === c.id ? null : c.id);
                    setContactPickerAnchor(null);
                  }}
                >
                  {c.text}
                </button>
              ))
            )}
            {row.linkedContactId && (
              <button
                type="button"
                className="date-cell-contact-clear"
                onClick={() => {
                  setLinkedContact(row.id, null);
                  setContactPickerAnchor(null);
                }}
              >
                Clear
              </button>
            )}
          </Popover>
        )}
      </td>
    );
  }

  if (column.type === 'note' || column.type === 'contact') {
    // Click-open (CellHoverEditor) — the two column types that can hold
    // more than fits on a line: a dated history log and a growable people
    // list. onClick is on the <td>, not just the button, so clicking
    // anywhere in the cell opens it (matches the text/phone/company
    // single-click-to-edit cells). A genuine drag-select that starts and
    // ends on *different* cells never triggers this: per the note on
    // synthetic click targets elsewhere in this codebase, that click lands
    // on a shared ancestor, not on either cell's own <td>. stopPropagation
    // is required here — without it this same click keeps bubbling up to
    // `.table-view`'s onClick={closePopovers}, which would immediately
    // clear the very state this just set, in the same batched update.
    const previewText = column.type === 'note' ? getLatestNoteText(storedValue) : getContactsSummary(storedValue);
    return (
      <td
        className={cellClassName}
        style={cellStyle}
        onMouseDown={onSelect}
        onMouseEnter={onExtend}
        onClick={(e) => {
          e.stopPropagation();
          onOpenEditor(e.currentTarget);
        }}
      >
        <button
          type="button"
          className={`cell-preview ${color ? '' : 'cell-preview-hoverable'}`}
          tabIndex={-1}
        >
          {previewText ? (
            highlightQuery ? highlightMatches(previewText, highlightQuery) : previewText
          ) : (
            <span className="cell-empty">{column.type === 'note' ? '+ note' : '+ contact'}</span>
          )}
        </button>
      </td>
    );
  }

  // text | phone | company | link — plain, single-value, single-click-to-edit.
  // Click selects *and* immediately swaps the cell into a live `<input>`
  // (via the `editable` prop, computed by TableView from selection state),
  // matching an ordinary spreadsheet cell. Only the *one* currently-active
  // cell is ever a real `<input>` at a time — every other cell stays a
  // plain button — which is what avoids the earlier bug where a grid full
  // of permanently-live inputs captured trackpad horizontal-scroll deltas
  // as their own internal text scrolling instead of letting it bubble to
  // the table's scroll container.
  if (editable) {
    return (
      <td className={cellClassName} style={cellStyle}>
        <input
          type={column.type === 'phone' ? 'tel' : column.type === 'link' ? 'url' : 'text'}
          autoFocus
          // A custom cell color is set here too, not just on the <td> above —
          // `.cell input:focus` in App.css paints an opaque `var(--bg)` the
          // instant this input gets focus (which, since clicking a cell now
          // enters edit mode immediately, is basically always), and that CSS
          // rule would otherwise hide any custom color for as long as the
          // cell is being edited. Inline style beats a class-based :focus
          // rule regardless of specificity tricks, so this wins unconditionally.
          style={cellStyle}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              skipCommitRef.current = true;
              setDraft(storedValue);
              e.currentTarget.blur();
            }
          }}
        />
      </td>
    );
  }

  // link's non-editable preview needs a second click target (the 🔗 icon)
  // alongside the normal click-to-edit text, so "open the URL" and "edit
  // the URL" are both one click away instead of one interaction fighting
  // the other. Protocol is added only at the point of forming the actual
  // href — the stored value (and what CSV export writes) stays exactly
  // what the user typed, e.g. "google.com" with no "https://".
  if (column.type === 'link') {
    const href = storedValue ? ensureProtocol(storedValue) : null;
    return (
      <td className={cellClassName} style={cellStyle} onMouseDown={onSelect} onMouseEnter={onExtend}>
        <div className="cell-link-inner">
          <button type="button" className={`cell-preview cell-link-text ${color ? '' : 'cell-preview-hoverable'}`} tabIndex={-1}>
            {storedValue ? (
              highlightQuery ? highlightMatches(storedValue, highlightQuery) : storedValue
            ) : (
              <span className="cell-empty">+ link</span>
            )}
          </button>
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="cell-link-open"
              title={href}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              🔗
            </a>
          )}
        </div>
      </td>
    );
  }

  return (
    <td className={cellClassName} style={cellStyle} onMouseDown={onSelect} onMouseEnter={onExtend}>
      <button type="button" className={`cell-preview ${color ? '' : 'cell-preview-hoverable'}`} tabIndex={-1}>
        {highlightQuery ? highlightMatches(storedValue, highlightQuery) : storedValue}
      </button>
    </td>
  );
}

// TableView re-renders on every selection change (a plain click moves
// `activeCell` by one cell), which — without this — would re-render every
// DataCell in the grid just to update the one or two cells whose
// selection actually changed. That full re-render (hundreds of cells for
// any table with a realistic number of rows) is what made clicking a cell
// feel noticeably delayed compared to a native spreadsheet's instant
// response. row/column keep stable references for any row/column a given
// action didn't touch (useTableStore's `rows.map` pattern returns the same
// object for untouched rows), so comparing them by reference — plus the
// three boolean props — is enough to know nothing this cell renders from
// actually changed. onSelect/onExtend/onOpenEditor are deliberately NOT
// compared: they're fresh closures every render (they close over this
// cell's row/col index), but behave identically to the previous render's
// closures whenever the compared props are unchanged, so skipping
// re-render on their identity alone is safe. highlightQuery and
// contactsRaw ARE compared — unlike the callbacks, their values actually
// change what gets rendered, and neither is reliably implied by `row`
// alone: contactsRaw is derived from a *different* column (the row's
// Contacts cell, for the next-action-date picker) than the `column` prop
// this particular cell instance has, so adding a Contacts column after a
// date was already set wouldn't otherwise be picked up until some other
// prop changed too.
export const DataCell = memo(DataCellImpl, (prev, next) => {
  return (
    prev.row === next.row &&
    prev.column === next.column &&
    prev.selected === next.selected &&
    prev.editable === next.editable &&
    prev.inRange === next.inRange &&
    prev.highlightQuery === next.highlightQuery &&
    prev.contactsRaw === next.contactsRaw
  );
});
