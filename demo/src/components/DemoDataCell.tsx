import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { Column, Row } from '../types';
import {
  parseContacts,
  addContact,
  removeContact,
  updateContact,
  getContactsSummary,
  extractPhoneNumber,
  extractEmail,
  contactTextToFields,
} from '../utils/contacts';
import {
  parseNoteHistory,
  addNoteEntry,
  updateNoteEntry,
  removeNoteEntry,
  getLatestNoteText,
  formatHistoryTimestamp,
  parseTaggedEntry,
  NOTE_TAGS,
  NO_ANSWER_SUFFIX,
  NO_ANSWER_COLOR,
  LINKEDIN_REQUEST_PREFIX,
  LINKEDIN_REQUEST_COLOR,
} from '../utils/noteHistory';
import { getDatePart, getTimePart, combineDateTime } from '../utils/date';
import { highlightMatches } from '../utils/highlight';
import { ensureProtocol } from '../utils/link';
import { contrastTextColor } from '../utils/color';
import { confirmDialog } from '../store/useConfirmStore';
import { useToastStore } from '../store/useToastStore';
import { Popover } from './Popover';
import { X, ExternalLink, Search, Clock, FileText, User, Copy, PenLine, Check, Mic, Bot } from 'lucide-react';

const NOT_CONFIGURED_MESSAGE = 'This integration isn’t configured — available in the full product';

/** Which contact-picker is currently open under the note tag row — one
 * shared anchor/state slot for all three picker flavors (a plain tag, the
 * "Didn't answer" suffix-tag, or the "LinkedIn request" prefix-tag), same
 * "anchor captured at click time" pattern the color-fill picker elsewhere
 * in this app already uses. */
type NotePickerKind = { kind: 'tag'; tag: { label: string; color: string } } | { kind: 'noAnswer' } | { kind: 'linkedin' };

interface DemoDataCellProps {
  row: Row;
  column: Column;
  editable: boolean;
  highlightQuery: string;
  onSelect: (e: ReactMouseEvent) => void;
  onCommit: (value: string) => void;
  /** Opens this cell's expanded editor (contact list / note history) —
   * shared by both the `contact` and `note` branches below, keyed by
   * {rowId, columnId} in DemoTableView so a row with more than one of
   * either column type doesn't show every one of them open at once. */
  onOpenEditor: () => void;
  editorOpen: boolean;
  onCloseEditor: () => void;
  /** The row's own Contacts-column raw string, computed once per row in
   * DemoTableView (not per cell) — same "read fresh from a sibling
   * column, not per cell" reasoning as production's own DataCell.tsx.
   * Only used by the next-action-date cell's 👤 picker. */
  contactsRaw?: string;
  onSetLinkedContact: (contactId: string | null) => void;
  onSetNextActionNote: (note: string | null) => void;
}

/** A right-sized rebuild of the real DataCell.tsx for the demo's own
 * feature scope — same click-to-edit convention (text/company/phone/link
 * become a live input; dropdown/date stay native always-interactive
 * controls; contact/note open an inline expanding surface), the same
 * `link` 🔗 open-in-new-tab and `company` 🔍 Google-search second
 * click-targets shipped in production this session, and the same
 * search-match highlighting — but without the worker-permission/
 * social-lookup machinery none of this demo needs. */
export function DemoDataCell({
  row,
  column,
  editable,
  highlightQuery,
  onSelect,
  onCommit,
  onOpenEditor,
  editorOpen,
  onCloseEditor,
  contactsRaw,
  onSetLinkedContact,
  onSetNextActionNote,
}: DemoDataCellProps) {
  const value = row.cells[column.id] ?? '';
  const [draft, setDraft] = useState(value);
  const [newContactText, setNewContactText] = useState('');
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [contactEditDraft, setContactEditDraft] = useState('');
  const showToast = useToastStore((s) => s.show);
  const [newNoteText, setNewNoteText] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState('');
  const [notePicker, setNotePicker] = useState<{ anchor: HTMLElement; picker: NotePickerKind } | null>(null);
  const [timeExpanded, setTimeExpanded] = useState(false);
  const [dateCellPopover, setDateCellPopover] = useState<'note' | 'contact' | null>(null);
  const [dateNoteDraft, setDateNoteDraft] = useState(row.nextActionNote ?? '');
  const noteBtnRef = useRef<HTMLButtonElement>(null);
  const contactBtnRef = useRef<HTMLButtonElement>(null);

  // Cell fill color (🎨 Color tool) — same "inline style wins over both
  // the :focus rule and the option's own badge color logic" approach as
  // production's DataCell.tsx, including applying it to the <input> too
  // (see this component's editable branch below), not just the <td> —
  // production's own doc comment on this exact class of bug explains why
  // that second application matters: a colored cell visibly loses its
  // color the moment it's clicked into edit mode otherwise.
  const color = row.colors?.[column.id];
  const cellStyle: CSSProperties | undefined = color ? { backgroundColor: color, color: contrastTextColor(color) } : undefined;

  // Re-sync the draft to the current stored value whenever it changes —
  // matches production's own DataCell.tsx exactly (dependency on
  // `value`, not `editable`). This has to fire on *any* external change,
  // not just "the cell just became editable": since a selected cell now
  // stays editable/mounted as an <input> even after committing (its
  // activeCell doesn't get cleared on commit — see DemoTableView's own
  // onCommit), an Undo/Redo affecting this exact cell while it's still
  // selected has to visibly update the input's value too. Keying this off
  // `editable` alone (the original version, before Undo/Redo existed)
  // missed exactly that case: the effect only re-ran when editable
  // flipped false→true, never while it stayed continuously true.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    setDateNoteDraft(row.nextActionNote ?? '');
  }, [row.nextActionNote]);

  // A plain onBlur is NOT reliable on its own — this was a real, reported
  // bug ("текст не сохраняется"): clicking a *different* cell fires that
  // cell's onSelect, which calls e.preventDefault() on its own mousedown
  // (necessary so the newly-clicked cell's default button-focus behavior
  // doesn't race with React swapping it to an <input> — see the plain
  // preview button's own comment below). preventDefault() on a mousedown
  // also suppresses the *previously* focused element's blur — a real,
  // spec'd browser behavior — so clicking directly from one editable cell
  // to another (no Enter first, the single most natural way to use a
  // spreadsheet) let `editable` flip to false and unmount this <input>
  // *without ever firing blur*, silently discarding whatever was typed.
  // Exactly production's own DataCell.tsx fix: commitRef holds the latest
  // commit closure (reassigned every render, so it's never stale), and a
  // cleanup effect keyed on `editable` commits when it flips to false,
  // regardless of whether a native blur happened first. onBlur stays too,
  // for the cases where `editable` doesn't change at all (Enter key,
  // clicking the search box).
  const skipCommitRef = useRef(false);
  const commitRef = useRef<() => void>(() => {});
  const commit = () => {
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      return;
    }
    if (draft === value) return;
    onCommit(draft);
  };
  commitRef.current = commit;
  useEffect(() => {
    if (!editable) return;
    return () => {
      commitRef.current();
    };
  }, [editable]);

  if (column.type === 'dropdown') {
    const optionColor = value ? column.optionColors?.[value] : undefined;
    const selectColor = optionColor ?? color;
    return (
      <td className="demo-cell demo-cell-dropdown" style={cellStyle}>
        <select
          value={value}
          style={selectColor ? { backgroundColor: selectColor, color: contrastTextColor(selectColor) } : undefined}
          onChange={(e) => onCommit(e.target.value)}
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
    const datePart = getDatePart(value);
    const timePart = getTimePart(value);
    const contacts = column.isNextActionDate ? parseContacts(contactsRaw ?? '') : [];
    const linkedContact = contacts.find((c) => c.id === row.linkedContactId);
    return (
      <td className="demo-cell" style={cellStyle} onMouseDown={onSelect}>
        <div className="date-cell">
          <input
            type="date"
            style={cellStyle}
            value={datePart}
            onChange={(e) => onCommit(combineDateTime(e.target.value, timePart))}
          />
          {datePart && (
            <button
              type="button"
              className={`date-cell-add-time ${timePart ? 'date-cell-add-time-set' : ''}`}
              title={timePart ? `Time: ${timePart} (click to view/change)` : 'Set a specific time'}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setTimeExpanded((v) => !v);
              }}
            >
              <Clock size={14} />
            </button>
          )}
          {timeExpanded && (
            <input
              type="time"
              className="date-cell-time"
              style={cellStyle}
              value={timePart}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => onCommit(combineDateTime(datePart, e.target.value))}
            />
          )}
          {column.isNextActionDate && datePart && (
            <button
              ref={noteBtnRef}
              type="button"
              className={`date-cell-note-btn ${row.nextActionNote ? 'date-cell-note-set' : ''}`}
              title={row.nextActionNote ? `Note: ${row.nextActionNote}` : 'Add a note about this call'}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setDateCellPopover((prev) => (prev === 'note' ? null : 'note'));
              }}
            >
              <FileText size={14} />
            </button>
          )}
          {column.isNextActionDate && datePart && contacts.length > 0 && (
            <button
              ref={contactBtnRef}
              type="button"
              className={`date-cell-contact-btn ${linkedContact ? 'date-cell-contact-linked' : ''}`}
              title={linkedContact ? `Calling: ${linkedContact.text}` : 'Pick who this call is for'}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setDateCellPopover((prev) => (prev === 'contact' ? null : 'contact'));
              }}
            >
              <User size={14} />
            </button>
          )}
          {datePart && (
            <button
              type="button"
              className="date-cell-clear-all"
              title="Clear date, time, linked contact, and note"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onCommit('');
                setTimeExpanded(false);
                if (column.isNextActionDate && row.linkedContactId) onSetLinkedContact(null);
                if (column.isNextActionDate && row.nextActionNote) onSetNextActionNote(null);
              }}
            >
              <X size={14} />
            </button>
          )}
        </div>
        {dateCellPopover === 'note' && noteBtnRef.current && (
          <Popover anchor={noteBtnRef.current} width={260}>
            <div className="popover-field">
              <span>Note about this call</span>
              <textarea
                autoFocus
                className="date-cell-note-textarea"
                rows={3}
                placeholder="e.g. ask about budget approval"
                value={dateNoteDraft}
                onChange={(e) => setDateNoteDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onSetNextActionNote(dateNoteDraft);
                    setDateCellPopover(null);
                  }
                  if (e.key === 'Escape') {
                    setDateNoteDraft(row.nextActionNote ?? '');
                    setDateCellPopover(null);
                  }
                }}
                onBlur={() => onSetNextActionNote(dateNoteDraft)}
              />
            </div>
          </Popover>
        )}
        {dateCellPopover === 'contact' && contactBtnRef.current && (
          <Popover anchor={contactBtnRef.current} width={220}>
            <div className="popover-field">
              <span>Who are you calling?</span>
            </div>
            {contacts.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`date-cell-contact-option ${row.linkedContactId === c.id ? 'date-cell-contact-option-active' : ''}`}
                onClick={() => {
                  onSetLinkedContact(row.linkedContactId === c.id ? null : c.id);
                  setDateCellPopover(null);
                }}
              >
                {c.text}
              </button>
            ))}
            {row.linkedContactId && (
              <button
                type="button"
                className="date-cell-contact-clear"
                onClick={() => {
                  onSetLinkedContact(null);
                  setDateCellPopover(null);
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

  if (column.type === 'contact') {
    const entries = parseContacts(value);
    const handleRemove = async (id: string, text: string) => {
      const ok = await confirmDialog({ message: `Remove "${text}"?`, danger: true });
      if (ok) onCommit(removeContact(value, id));
    };
    const handleCopy = (fieldValue: string, label: string) => {
      void navigator.clipboard.writeText(fieldValue);
      showToast(`${label} copied`);
    };
    return (
      <td className="demo-cell demo-cell-contact" style={cellStyle} onMouseDown={onSelect}>
        <button type="button" className="demo-cell-preview demo-cell-preview-hoverable" tabIndex={-1} onClick={onOpenEditor}>
          {getContactsSummary(value) ? highlightMatches(getContactsSummary(value), highlightQuery) : <span className="demo-cell-empty">+ add contact</span>}
        </button>
        {editorOpen && (
          <div className="demo-contact-popover" onClick={(e) => e.stopPropagation()}>
            <div className="demo-contact-popover-header">
              <span>Decision makers</span>
              <button type="button" className="demo-contact-popover-close" onClick={onCloseEditor}>
                <X size={14} />
              </button>
            </div>
            <ul className="demo-contact-list">
              {entries.map((entry) => {
                const entryPhone = extractPhoneNumber(entry.text);
                const entryEmail = extractEmail(entry.text);
                return (
                  <li key={entry.id} className="demo-contact-entry">
                    {editingContactId === entry.id ? (
                      <input
                        autoFocus
                        className="demo-contact-edit-input"
                        value={contactEditDraft}
                        onChange={(e) => setContactEditDraft(e.target.value)}
                        onBlur={() => {
                          if (contactEditDraft.trim()) onCommit(updateContact(value, entry.id, contactEditDraft));
                          setEditingContactId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') e.currentTarget.blur();
                          if (e.key === 'Escape') setEditingContactId(null);
                        }}
                      />
                    ) : (
                      <span className="demo-contact-entry-text">{entry.text}</span>
                    )}
                    <div className="demo-contact-entry-actions">
                      {entryPhone && (
                        <button type="button" title="Copy phone" onClick={() => handleCopy(entryPhone, 'Phone')}>
                          <Copy size={12} />
                        </button>
                      )}
                      {entryEmail && (
                        <button type="button" title="Copy email" onClick={() => handleCopy(entryEmail, 'Email')}>
                          <Copy size={12} />
                        </button>
                      )}
                      <button
                        type="button"
                        title="Find on Instagram / Facebook"
                        onClick={() => showToast('This integration isn’t configured — available in the full product')}
                      >
                        <Search size={12} />
                      </button>
                      <button
                        type="button"
                        title="Edit contact"
                        onClick={() => {
                          setEditingContactId(entry.id);
                          setContactEditDraft(entry.text);
                        }}
                      >
                        <PenLine size={12} />
                      </button>
                      <button type="button" title="Remove contact" onClick={() => void handleRemove(entry.id, entry.text)}>
                        <X size={12} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="demo-contact-add-row">
              <input
                placeholder="Name, title, email, phone…"
                value={newContactText}
                onChange={(e) => setNewContactText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newContactText.trim()) {
                    onCommit(addContact(value, newContactText.trim()));
                    setNewContactText('');
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (!newContactText.trim()) return;
                  onCommit(addContact(value, newContactText.trim()));
                  setNewContactText('');
                }}
              >
                Add
              </button>
            </div>
          </div>
        )}
      </td>
    );
  }

  // A note cell's stored value is a JSON array of dated entries (see
  // utils/noteHistory.ts) — same click-to-expand pattern as `contact`
  // above, just with a dated history list instead of a flat one. Matches
  // production's *current* Notes/History feature (CellHoverEditor.tsx):
  // every quick-tag opens a contact picker and composes "{tag} {name}"
  // (or "{name} Didn't answer" for the one suffix-shaped tag) — a tag is
  // never logged standalone anymore, and existing entries render with
  // just the tag word as a small inline chip (parseTaggedEntry), not a
  // whole-entry background color.
  if (column.type === 'note') {
    const entries = parseNoteHistory(value);
    const rowContacts = parseContacts(contactsRaw ?? '');
    const noContacts = rowContacts.length === 0;
    const handleRemove = async (id: string, text: string) => {
      const ok = await confirmDialog({ message: `Delete this note entry?\n"${text}"`, danger: true });
      if (ok) onCommit(removeNoteEntry(value, id));
    };
    const commitNewEntry = () => {
      if (!newNoteText.trim()) return;
      onCommit(addNoteEntry(value, newNoteText.trim()));
      setNewNoteText('');
    };
    const contactDisplayName = (c: { text: string }) => {
      const { firstName, lastName } = contactTextToFields(c.text);
      return `${firstName} ${lastName}`.trim() || c.text;
    };
    const pickerTitle =
      notePicker?.picker.kind === 'tag'
        ? `Who is "${notePicker.picker.tag.label}" about?`
        : notePicker?.picker.kind === 'noAnswer'
          ? 'Who didn’t answer?'
          : 'Who was the LinkedIn request sent to?';
    const composeAndAdd = (picker: NotePickerKind, name: string) => {
      const text =
        picker.kind === 'tag' ? `${picker.tag.label} ${name}` : picker.kind === 'noAnswer' ? `${name} ${NO_ANSWER_SUFFIX}` : `${LINKEDIN_REQUEST_PREFIX} ${name}`;
      onCommit(addNoteEntry(value, text));
      setNotePicker(null);
    };
    return (
      <td className="demo-cell demo-cell-note" style={cellStyle} onMouseDown={onSelect}>
        <button type="button" className="demo-cell-preview demo-cell-preview-hoverable" tabIndex={-1} onClick={onOpenEditor}>
          {getLatestNoteText(value) ? highlightMatches(getLatestNoteText(value), highlightQuery) : <span className="demo-cell-empty">+ add note</span>}
        </button>
        {editorOpen && (
          <div className="demo-contact-popover demo-note-popover" onClick={(e) => e.stopPropagation()}>
            <div className="demo-contact-popover-header">
              <span>Notes</span>
              <button type="button" className="demo-contact-popover-close" onClick={onCloseEditor}>
                <X size={14} />
              </button>
            </div>
            <div className="demo-note-new-entry-row">
              <textarea
                className="demo-note-new-entry"
                placeholder="Add a comment…"
                value={newNoteText}
                onChange={(e) => setNewNoteText(e.target.value)}
                onBlur={commitNewEntry}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commitNewEntry();
                  }
                }}
              />
              <button type="button" className="demo-note-new-entry-save" title="Save" onClick={commitNewEntry}>
                <Check size={14} />
              </button>
              <button
                type="button"
                className="demo-note-voice-btn"
                title="Record a voice note"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => showToast(NOT_CONFIGURED_MESSAGE)}
              >
                <Mic size={14} />
              </button>
            </div>
            <div className="demo-note-tags">
              <button type="button" className="demo-note-tag demo-note-tag-summary" onClick={() => showToast(NOT_CONFIGURED_MESSAGE)}>
                <Bot size={14} /> Last summary
              </button>
              {NOTE_TAGS.map((tag) => (
                <button
                  key={tag.label}
                  type="button"
                  className="demo-note-tag"
                  style={{ backgroundColor: tag.color, color: contrastTextColor(tag.color) }}
                  disabled={noContacts}
                  title={noContacts ? 'No contacts on this row yet' : `Who is "${tag.label}" about?`}
                  onClick={(e) => {
                    e.stopPropagation();
                    const anchor = e.currentTarget;
                    setNotePicker((prev) => (prev?.picker.kind === 'tag' && prev.picker.tag.label === tag.label ? null : { anchor, picker: { kind: 'tag', tag } }));
                  }}
                >
                  {tag.label}
                </button>
              ))}
              <button
                type="button"
                className="demo-note-tag"
                style={{ backgroundColor: NO_ANSWER_COLOR, color: contrastTextColor(NO_ANSWER_COLOR) }}
                disabled={noContacts}
                title={noContacts ? 'No contacts on this row yet' : 'Who didn’t answer?'}
                onClick={(e) => {
                  e.stopPropagation();
                  const anchor = e.currentTarget;
                  setNotePicker((prev) => (prev?.picker.kind === 'noAnswer' ? null : { anchor, picker: { kind: 'noAnswer' } }));
                }}
              >
                {NO_ANSWER_SUFFIX}
              </button>
              <button
                type="button"
                className="demo-note-tag"
                style={{ backgroundColor: LINKEDIN_REQUEST_COLOR, color: contrastTextColor(LINKEDIN_REQUEST_COLOR) }}
                disabled={noContacts}
                title={noContacts ? 'No contacts on this row yet' : 'Who was the LinkedIn request sent to?'}
                onClick={(e) => {
                  e.stopPropagation();
                  const anchor = e.currentTarget;
                  setNotePicker((prev) => (prev?.picker.kind === 'linkedin' ? null : { anchor, picker: { kind: 'linkedin' } }));
                }}
              >
                {LINKEDIN_REQUEST_PREFIX}
              </button>
            </div>
            {notePicker && (
              <Popover anchor={notePicker.anchor} width={220}>
                <div className="popover-field">
                  <span>{pickerTitle}</span>
                </div>
                {rowContacts.map((c) => (
                  <button key={c.id} type="button" className="date-cell-contact-option" onClick={() => composeAndAdd(notePicker.picker, contactDisplayName(c))}>
                    {contactDisplayName(c)}
                  </button>
                ))}
              </Popover>
            )}
            <ul className="demo-note-history">
              {entries.map((entry) => {
                const tagged = parseTaggedEntry(entry.text);
                return (
                  <li key={entry.id} className="demo-note-entry">
                    <div className="demo-note-entry-time">
                      <span className="demo-note-entry-author">Account Owner</span>
                      {entry.createdAt > 0 && ` · ${formatHistoryTimestamp(entry.createdAt)}`}
                    </div>
                    <div className="demo-note-entry-row">
                      {editingNoteId === entry.id ? (
                        <input
                          autoFocus
                          className="demo-note-entry-edit"
                          value={noteEditDraft}
                          onChange={(e) => setNoteEditDraft(e.target.value)}
                          onBlur={() => {
                            if (noteEditDraft.trim()) onCommit(updateNoteEntry(value, entry.id, noteEditDraft));
                            setEditingNoteId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') e.currentTarget.blur();
                            if (e.key === 'Escape') setEditingNoteId(null);
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className="demo-note-entry-text"
                          onClick={() => {
                            setEditingNoteId(entry.id);
                            setNoteEditDraft(entry.text);
                          }}
                        >
                          {!tagged ? (
                            entry.text
                          ) : tagged.tagPosition === 'suffix' ? (
                            <>
                              {tagged.restText && `${tagged.restText} `}
                              <span className="demo-note-history-tag-chip" style={{ backgroundColor: tagged.color, color: contrastTextColor(tagged.color) }}>
                                {tagged.tagLabel}
                              </span>
                            </>
                          ) : tagged.tagPosition === 'prefix' ? (
                            <>
                              <span className="demo-note-history-tag-chip" style={{ backgroundColor: tagged.color, color: contrastTextColor(tagged.color) }}>
                                {tagged.tagLabel}
                              </span>
                              {tagged.restText && ` ${tagged.restText}`}
                            </>
                          ) : (
                            <span className="demo-note-history-tag-chip" style={{ backgroundColor: tagged.color, color: contrastTextColor(tagged.color) }}>
                              {tagged.tagLabel}
                            </span>
                          )}
                        </button>
                      )}
                      <button type="button" onClick={() => void handleRemove(entry.id, entry.text)}>
                        <X size={12} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </td>
    );
  }

  if (editable) {
    return (
      <td className="demo-cell" style={cellStyle}>
        <input
          autoFocus
          type={column.type === 'phone' ? 'tel' : column.type === 'link' ? 'url' : 'text'}
          value={draft}
          style={cellStyle}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              skipCommitRef.current = true;
              setDraft(value);
              e.currentTarget.blur();
            }
          }}
        />
      </td>
    );
  }

  // link's non-editable preview gets a second click-target — the 🔗 opens
  // the URL in a new tab, same as production's DataCell.tsx.
  if (column.type === 'link') {
    const href = value ? ensureProtocol(value) : null;
    return (
      <td className="demo-cell" style={cellStyle} onMouseDown={onSelect}>
        <div className="demo-cell-link-inner">
          <button type="button" className="demo-cell-preview demo-cell-preview-hoverable" tabIndex={-1}>
            {value ? highlightMatches(value, highlightQuery) : <span className="demo-cell-empty">—</span>}
          </button>
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="demo-cell-link-open"
              title={href}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <ExternalLink size={13} />
            </a>
          )}
        </div>
      </td>
    );
  }

  // company's non-editable preview gets the same second-click-target
  // treatment — 🔍 searches the exact company name on Google in a new
  // tab, same pattern shipped in production this session.
  if (column.type === 'company') {
    const query = value.trim();
    const searchHref = query ? `https://www.google.com/search?q=${encodeURIComponent(query)}` : null;
    return (
      <td className="demo-cell" style={cellStyle} onMouseDown={onSelect}>
        <div className="demo-cell-link-inner">
          <button type="button" className="demo-cell-preview demo-cell-preview-hoverable" tabIndex={-1}>
            {value ? highlightMatches(value, highlightQuery) : <span className="demo-cell-empty">—</span>}
          </button>
          {searchHref && (
            <a
              href={searchHref}
              target="_blank"
              rel="noreferrer"
              className="demo-cell-link-open"
              title={`Search "${query}" on Google`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <Search size={13} />
            </a>
          )}
        </div>
      </td>
    );
  }

  return (
    <td className="demo-cell" style={cellStyle} onMouseDown={onSelect}>
      {/* tabIndex={-1} matters, not just for tab-order tidiness: without
          it, the browser's own default mousedown-focus behavior for a
          <button> races against React's synchronous re-render (this
          same mousedown swaps this button for a live <input> — see the
          editable branch above), and can steal focus back to document
          body right after the input auto-focuses, firing a spurious
          blur that immediately re-collapses the cell before a real user
          ever gets a chance to type. Confirmed live: without this, a
          mousedown+mouseup sequence opened and then instantly closed
          edit mode in the same gesture. */}
      <button type="button" className="demo-cell-preview demo-cell-preview-hoverable" tabIndex={-1}>
        {value ? highlightMatches(value, highlightQuery) : <span className="demo-cell-empty">—</span>}
      </button>
    </td>
  );
}
