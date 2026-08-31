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
import { useAuthStore } from '../../store/useAuthStore';
import { useToastStore } from '../../store/useToastStore';
import { combineDateTime, getDatePart, getTimePart } from '../../utils/date';
import { getLatestNoteText } from '../../utils/noteHistory';
import { getContactsSummary, parseContacts, contactTextToFields } from '../../utils/contacts';
import { contrastTextColor } from '../../utils/color';
import { Popover } from '../Popover';
import { ensureProtocol } from '../../utils/link';
import { highlightMatches } from '../../utils/highlight';
import { isCellLockedForWorker } from '../../utils/workerCellLock';
import { EXCEL_CELL_LIMIT } from '../../constants';
import { Clock, FileText, User, ExternalLink, X } from 'lucide-react';

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
  /** Right-click — opens CellContextMenu (TableView.tsx). Not wired onto
   * the `editable` branch's live `<input>` below: right-clicking while
   * actively mid-edit shows the browser's own native text context menu
   * (cut/copy/paste/spellcheck), which is more useful there than a sheet-
   * management menu, matching real Excel/Sheets behavior. */
  onContextMenu: (e: ReactMouseEvent) => void;
  /** note/contact only — opens CellHoverEditor for this cell. Named for
   * what it does, not how it's triggered; see the click handler below. */
  onOpenEditor: (anchor: HTMLElement) => void;
  /** The active search box query and/or committed search tags — only
   * ever set on rows the search has already matched, so this just
   * highlights *where* the match is within that row's cells. An array
   * highlights every term (the live search box text plus every
   * committed tag) at once, so a row matched by several different tags
   * shows all of them. Undefined/empty means no active search. */
  highlightQuery?: string | string[];
  /** Raw stored value of this row's `contact`-type column (whichever one,
   * if any — see getColumnByType), for the next-action-date cell's "who to
   * call" picker. Only read by the `date` branch when `column.isNextActionDate`. */
  contactsRaw?: string;
  /** Which of THIS cell's own mini-popovers (📝 note / 👤 contact-pick — not
   * the 🕐 time input, which is a plain inline toggle, not a floating
   * popover) is open, lifted up to TableView so "click anywhere else
   * closes it" works via the same closePopovers mechanism every other
   * popover in this app already uses. null/undefined means neither is open
   * for this specific cell. */
  activeDatePopover?: 'note' | 'contact' | null;
  onToggleDatePopover?: (kind: 'note' | 'contact', anchor: HTMLElement) => void;
}

function DataCellImpl({
  row,
  column,
  selected,
  editable,
  inRange,
  onSelect,
  onExtend,
  onContextMenu,
  onOpenEditor,
  highlightQuery,
  contactsRaw,
  activeDatePopover,
  onToggleDatePopover,
}: DataCellProps) {
  const updateCell = useTableStore((s) => s.updateCell);
  const setLinkedContact = useTableStore((s) => s.setLinkedContact);
  const setNextActionNote = useTableStore((s) => s.setNextActionNote);
  const showToast = useToastStore((s) => s.show);
  const currentUser = useAuthStore((s) => s.user);
  const storedValue = row.cells[column.id] ?? '';
  const color = row.colors?.[column.id];
  // text/phone/company/link cells are append-only for a worker — this is
  // the client-side half of the rule (server/src/tableData/db.ts's
  // sanitizeRowForWorker is the real, unconditional enforcement; without
  // this, a worker could still type into and "save" a filled cell, only to
  // have it silently revert on the next reload with no explanation, which
  // is exactly the confusing failure mode this guard exists to avoid). A
  // brand-new, still-empty cell stays freely fillable regardless of role —
  // only *overwriting* an existing value is ever blocked. Shared with
  // TableView.tsx's Delete/Backspace handler via workerCellLock.ts, so the
  // same rule applies everywhere a cell's value could change, not just
  // this one click-to-edit path — see that file's own doc comment for why
  // that sharing turned out to matter (a real, reported Delete-key bypass).
  const isAppendOnlyLocked = isCellLockedForWorker(column, storedValue, currentUser);
  // Declared unconditionally (not just inside the branches that use them)
  // so the hook order stays stable even if this column's type changes.
  const [timeExpanded, setTimeExpanded] = useState(false);
  const isContactPickerOpen = activeDatePopover === 'contact';
  const isNoteOpen = activeDatePopover === 'note';
  const [noteDraft, setNoteDraft] = useState(row.nextActionNote ?? '');
  // Same Escape-vs-blur race documented at length elsewhere in this
  // codebase for note/text editing: Enter/Escape both close the popover
  // synchronously, unmounting the textarea, and whether the browser's
  // native blur fires before or after that unmount isn't guaranteed —
  // Escape's own onKeyDown branch sets this so the (possibly still-firing)
  // onBlur discards the edit instead of re-saving the draft it just reset.
  const skipNoteCommitRef = useRef(false);
  // The note popover can now also close because a *different* cell/button
  // was clicked (activeDatePopover flipping away from 'note', lifted up to
  // TableView — see the prop doc comment above) — not just this cell's own
  // Enter/Escape/blur. commitNoteRef always holds the latest commit
  // closure; the effect below fires it from cleanup whenever isNoteOpen
  // flips to false, for any reason, mirroring the exact pattern already
  // established for text/phone/company autosave elsewhere in this file.
  const commitNoteRef = useRef<() => void>(() => {});
  const commitNote = () => {
    if (skipNoteCommitRef.current) {
      skipNoteCommitRef.current = false;
      return;
    }
    setNextActionNote(row.id, noteDraft);
  };
  commitNoteRef.current = commitNote;
  useEffect(() => {
    if (!isNoteOpen) return;
    return () => commitNoteRef.current();
  }, [isNoteOpen]);
  // Popover needs a live anchor *element*, but the lifted activeDatePopover
  // prop only carries which kind is open (not the DOM node — TableView has
  // no reason to hold onto raw HTMLElements in its own state). These two
  // buttons are always the same DOM node across this cell's re-renders (as
  // long as the row/column identity doesn't change), so a plain ref
  // populated on every render is simpler and sufficient — no need to
  // capture/store anything at click time.
  const noteBtnRef = useRef<HTMLButtonElement | null>(null);
  const contactBtnRef = useRef<HTMLButtonElement | null>(null);
  const [draft, setDraft] = useState(storedValue);
  useEffect(() => {
    setDraft(storedValue);
  }, [storedValue]);
  useEffect(() => {
    setNoteDraft(row.nextActionNote ?? '');
  }, [row.nextActionNote]);

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
      showToast(`Tekstas apkarpytas iki Excel langelio ribos — ${EXCEL_CELL_LIMIT.toLocaleString('lt-LT')} simbolių`);
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
  // color (both here and text: contrastTextColor(color)) is computed once
  // here rather than per cell-type branch below, since every branch
  // (text/phone/company input, date cell, note/contact preview, the <td>
  // wrapper itself) applies the same cellStyle object — the same real bug
  // the dropdown badge fix above addresses applies identically here: a
  // custom cell fill (🎨 Color tool, PRESET_COLORS — all light pastels) is
  // a plain hex value with no relationship to useThemeStore at all, so
  // once dark mode makes the surrounding `color: var(--text)` light, any
  // colored cell's own text became light-on-light-pastel and unreadable.
  const cellStyle: CSSProperties | undefined = color ? { backgroundColor: color, color: contrastTextColor(color) } : undefined;

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
        onContextMenu={onContextMenu}
      >
        <select
          value={storedValue}
          style={
            selectColor ? { backgroundColor: selectColor, color: contrastTextColor(selectColor) } : undefined
          }
          onFocus={onSelect}
          onChange={(e) => updateCell(row.id, column.id, e.target.value)}
        >
          <option value="">—</option>
          {(column.options ?? []).map((opt) => {
            const optColor = column.optionColors?.[opt];
            return (
              <option key={opt} value={opt} style={optColor ? { backgroundColor: optColor, color: contrastTextColor(optColor) } : undefined}>
                {opt}
              </option>
            );
          })}
        </select>
      </td>
    );
  }

  if (column.type === 'date') {
    const datePart = getDatePart(storedValue);
    const timePart = getTimePart(storedValue);
    // Collapsed by default even once a time is set — deliberately NOT
    // `timeExpanded || !!timePart` (the earlier behavior): a set time used
    // to permanently occupy a second, always-visible input in the table
    // cell, which was a real, reported complaint ("не хочу чтобы
    // отображалась в табеле — оно видно только в календаре"). The time is
    // still fully visible in the calendar/task-list views (getTimePart());
    // in the table, the 🕐 button below is the only entry point, toggled
    // open/closed explicitly rather than tied to whether a time exists.
    const showTimeInput = timeExpanded;
    return (
      <td
        className={cellClassName}
        style={cellStyle}
        onMouseDown={onSelect}
        onMouseEnter={onExtend}
        onContextMenu={onContextMenu}
      >
        <div className="date-cell">
          <input
            type="date"
            style={cellStyle}
            value={datePart}
            onFocus={onSelect}
            onChange={(e) => updateCell(row.id, column.id, combineDateTime(e.target.value, timePart))}
          />
          {datePart && (
            <button
              type="button"
              className={`date-cell-add-time ${timePart ? 'date-cell-add-time-set' : ''}`}
              title={timePart ? `Laikas: ${timePart} (spustelėkite peržiūrėti/keisti)` : 'Nurodyti konkretų laiką'}
              onClick={(e) => {
                e.stopPropagation();
                setTimeExpanded((v) => !v);
              }}
            >
              <Clock className="icon" size={14} />
            </button>
          )}
          {showTimeInput && (
            <input
              type="time"
              className="date-cell-time"
              style={cellStyle}
              value={timePart}
              onFocus={onSelect}
              onChange={(e) => updateCell(row.id, column.id, combineDateTime(datePart, e.target.value))}
            />
          )}
          {column.isNextActionDate && datePart && (
            <button
              ref={noteBtnRef}
              type="button"
              className={`date-cell-note-btn ${row.nextActionNote ? 'date-cell-note-set' : ''}`}
              title={row.nextActionNote ? `Užrašas: ${row.nextActionNote}` : 'Pridėti užrašą apie šį skambutį'}
              // TableView's handleCellMouseDown clears dateCellPopover on
              // *every* cell mousedown (mirroring how it already clears
              // expandedCell) — necessary so clicking away actually closes
              // this popover (see the doc comment there), but mousedown
              // fires and fully re-renders *before* this button's own
              // onClick runs, so without stopping it here, clicking this
              // exact button to toggle its own popover *closed* would see
              // dateCellPopover already cleared by its own mousedown and
              // re-open instead. Stopping propagation here only skips the
              // generic mousedown-triggered clear for this one button — the
              // click below still runs and decides open/closed correctly
              // from whatever state existed before this press.
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onToggleDatePopover?.('note', e.currentTarget);
              }}
            >
              <FileText className="icon" size={14} />
            </button>
          )}
          {column.isNextActionDate &&
            datePart &&
            (() => {
              const contacts = parseContacts(contactsRaw ?? '');
              // No entry point at all when the row has no contacts yet —
              // there's nothing to pick, so showing the button just to
              // immediately tell the user that in the popover was pure
              // friction. It reappears the moment a contact gets added.
              if (contacts.length === 0) return null;
              const linked = contacts.find((c) => c.id === row.linkedContactId);
              return (
                <button
                  ref={contactBtnRef}
                  type="button"
                  className={`date-cell-contact-btn ${linked ? 'date-cell-contact-linked' : ''}`}
                  title={
                    linked
                      ? `Skambinama: ${contactTextToFields(linked.text).firstName || linked.text}`
                      : 'Pasirinkite, kam skambinate'
                  }
                  // See the 📝 button's identical comment above — same
                  // mousedown-vs-click-toggle race, same fix.
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleDatePopover?.('contact', e.currentTarget);
                  }}
                >
                  <User className="icon" size={14} />
                </button>
              );
            })()}
          {datePart && (
            <button
              type="button"
              className="date-cell-clear-all"
              title="Išvalyti datą, laiką, susietą kontaktą ir užrašą"
              onClick={(e) => {
                e.stopPropagation();
                updateCell(row.id, column.id, '');
                setTimeExpanded(false);
                if (column.isNextActionDate && row.linkedContactId) setLinkedContact(row.id, null);
                if (column.isNextActionDate && row.nextActionNote) setNextActionNote(row.id, null);
              }}
            >
              <X className="icon" size={14} />
            </button>
          )}
        </div>
        {isNoteOpen && noteBtnRef.current && (
          <Popover anchor={noteBtnRef.current} width={260}>
            <div className="popover-field">
              <span>Užrašas apie šį skambutį</span>
              <textarea
                autoFocus
                className="date-cell-note-textarea"
                rows={3}
                placeholder="Pvz.: paklausti apie biudžeto patvirtinimą"
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    setNextActionNote(row.id, noteDraft);
                    onToggleDatePopover?.('note', e.currentTarget);
                  }
                  if (e.key === 'Escape') {
                    skipNoteCommitRef.current = true;
                    setNoteDraft(row.nextActionNote ?? '');
                    onToggleDatePopover?.('note', e.currentTarget);
                  }
                }}
                onBlur={() => {
                  if (skipNoteCommitRef.current) {
                    skipNoteCommitRef.current = false;
                    return;
                  }
                  setNextActionNote(row.id, noteDraft);
                }}
              />
            </div>
          </Popover>
        )}
        {isContactPickerOpen && contactBtnRef.current && (
          <Popover anchor={contactBtnRef.current} width={220}>
            <div className="popover-field">
              <span>Kam skambinate?</span>
            </div>
            {parseContacts(contactsRaw ?? '').map((c) => (
              <button
                key={c.id}
                type="button"
                className={`date-cell-contact-option ${row.linkedContactId === c.id ? 'date-cell-contact-option-active' : ''}`}
                onClick={(e) => {
                  setLinkedContact(row.id, row.linkedContactId === c.id ? null : c.id);
                  onToggleDatePopover?.('contact', e.currentTarget);
                }}
              >
                {c.text}
              </button>
            ))}
            {row.linkedContactId && (
              <button
                type="button"
                className="date-cell-contact-clear"
                onClick={(e) => {
                  setLinkedContact(row.id, null);
                  onToggleDatePopover?.('contact', e.currentTarget);
                }}
              >
                Išvalyti
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
        // Only note/contact cells need these — they're the one place
        // something outside the normal click flow (the Calls tab's "find
        // this caller in my contacts" jump) needs to locate a specific
        // cell's real DOM node to use as CellHoverEditor's popup anchor,
        // for a row that may not even be mounted yet (virtualized) at the
        // time the jump is requested. See TableView.tsx's focusContact
        // effect for the query that reads these back.
        data-row-id={row.id}
        data-column-id={column.id}
        onMouseDown={onSelect}
        onMouseEnter={onExtend}
        onContextMenu={onContextMenu}
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
            <span className="cell-empty">{column.type === 'note' ? '+ komentaras' : '+ kontaktas'}</span>
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
  if (editable && !isAppendOnlyLocked) {
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
      <td className={cellClassName} style={cellStyle} onMouseDown={onSelect} onMouseEnter={onExtend} onContextMenu={onContextMenu}>
        <div className="cell-link-inner">
          <button
            type="button"
            className={`cell-preview cell-link-text ${color ? '' : 'cell-preview-hoverable'}`}
            tabIndex={-1}
            title={isAppendOnlyLocked ? 'Jau turi reikšmę — darbuotojas negali jos perrašyti' : undefined}
          >
            {storedValue ? (
              highlightQuery ? highlightMatches(storedValue, highlightQuery) : storedValue
            ) : (
              <span className="cell-empty">+ nuoroda</span>
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
              <ExternalLink className="icon" size={13} />
            </a>
          )}
        </div>
      </td>
    );
  }

  return (
    <td className={cellClassName} style={cellStyle} onMouseDown={onSelect} onMouseEnter={onExtend} onContextMenu={onContextMenu}>
      <button
        type="button"
        className={`cell-preview ${color ? '' : 'cell-preview-hoverable'}`}
        tabIndex={-1}
        title={isAppendOnlyLocked ? 'Jau turi reikšmę — darbuotojas negali jos perrašyti' : undefined}
      >
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
// re-render on their identity alone is safe. highlightQuery, contactsRaw,
// and activeDatePopover ARE compared — unlike the callbacks, their values
// actually change what gets rendered, and none is reliably implied by
// `row` alone: contactsRaw is derived from a *different* column (the row's
// Contacts cell, for the next-action-date picker) than the `column` prop
// this particular cell instance has, so adding a Contacts column after a
// date was already set wouldn't otherwise be picked up until some other
// prop changed too. activeDatePopover is TableView's own state, entirely
// independent of both row and column — omitting it here was a real,
// reproduced bug: clicking 📝/👤 correctly updated TableView's state and
// called onToggleDatePopover, but this comparator had no idea that
// mattered, so React skipped re-rendering the cell and the popover never
// actually appeared.
// highlightQuery can now be an array (the live search text plus every
// committed search tag — see TableView's searchTags) — TableView passes
// a fresh array literal on every render, so comparing by `===` would
// never consider two equivalent arrays equal and this memo would stop
// doing anything for every row once any tag existed. Joined into a
// single string with a separator that can't appear in a real query
// (search terms are plain user text) so the comparison stays a cheap
// primitive `===` either way.
function highlightKey(v: string | string[] | undefined): string {
  return Array.isArray(v) ? v.join('\u0000') : (v ?? '');
}

export const DataCell = memo(DataCellImpl, (prev, next) => {
  return (
    prev.row === next.row &&
    prev.column === next.column &&
    prev.selected === next.selected &&
    prev.editable === next.editable &&
    prev.inRange === next.inRange &&
    highlightKey(prev.highlightQuery) === highlightKey(next.highlightQuery) &&
    prev.activeDatePopover === next.activeDatePopover &&
    prev.contactsRaw === next.contactsRaw
  );
});
