import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { Column, Row } from '../types';
import { parseContacts, addContact, removeContact, getContactsSummary } from '../utils/contacts';
import { parseNoteHistory, addNoteEntry, updateNoteEntry, removeNoteEntry, getLatestNoteText, formatHistoryTimestamp } from '../utils/noteHistory';
import { highlightMatches } from '../utils/highlight';
import { ensureProtocol } from '../utils/link';
import { contrastTextColor } from '../utils/color';
import { confirmDialog } from '../store/useConfirmStore';
import { X, ExternalLink, Search } from 'lucide-react';

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
}

const NOTE_TAGS: Array<{ label: string; color: string }> = [
  { label: 'Email', color: '#e3ecf7' },
  { label: 'Email follow-up', color: '#e1f0ef' },
  { label: 'Meeting scheduled', color: '#eee3f3' },
  { label: 'Meeting completed', color: '#f5e3ec' },
  { label: 'Call', color: '#f6e9dd' },
];
const NOTE_TAG_COLORS: Record<string, string> = Object.fromEntries(NOTE_TAGS.map((t) => [t.label, t.color]));

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
}: DemoDataCellProps) {
  const value = row.cells[column.id] ?? '';
  const [draft, setDraft] = useState(value);
  const [newContactText, setNewContactText] = useState('');
  const [newNoteText, setNewNoteText] = useState('');
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteEditDraft, setNoteEditDraft] = useState('');

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
    return (
      <td className="demo-cell" style={cellStyle}>
        <input type="date" value={value} onChange={(e) => onCommit(e.target.value)} style={cellStyle} />
      </td>
    );
  }

  if (column.type === 'contact') {
    const entries = parseContacts(value);
    const handleRemove = async (id: string, text: string) => {
      const ok = await confirmDialog({ message: `Remove "${text}"?`, danger: true });
      if (ok) onCommit(removeContact(value, id));
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
              {entries.map((entry) => (
                <li key={entry.id} className="demo-contact-entry">
                  <span>{entry.text}</span>
                  <button type="button" onClick={() => void handleRemove(entry.id, entry.text)}>
                    <X size={12} />
                  </button>
                </li>
              ))}
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
  // above, just with a dated history list instead of a flat one, and a
  // row of quick-tag buttons for the handful of things logged constantly
  // in a real cold-calling workflow (matches production's own NOTE_TAGS
  // idea, trimmed to a shorter English set).
  if (column.type === 'note') {
    const entries = parseNoteHistory(value);
    const handleAddTag = (label: string) => onCommit(addNoteEntry(value, label));
    const handleRemove = async (id: string, text: string) => {
      const ok = await confirmDialog({ message: `Delete this note entry?\n"${text}"`, danger: true });
      if (ok) onCommit(removeNoteEntry(value, id));
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
            <div className="demo-note-tags">
              {NOTE_TAGS.map((tag) => (
                <button key={tag.label} type="button" className="demo-note-tag" style={{ background: tag.color }} onClick={() => handleAddTag(tag.label)}>
                  {tag.label}
                </button>
              ))}
            </div>
            <div className="demo-contact-add-row">
              <input
                placeholder="Add a note…"
                value={newNoteText}
                onChange={(e) => setNewNoteText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newNoteText.trim()) {
                    onCommit(addNoteEntry(value, newNoteText.trim()));
                    setNewNoteText('');
                  }
                }}
              />
              <button
                type="button"
                onClick={() => {
                  if (!newNoteText.trim()) return;
                  onCommit(addNoteEntry(value, newNoteText.trim()));
                  setNewNoteText('');
                }}
              >
                Add
              </button>
            </div>
            <ul className="demo-note-history">
              {entries.map((entry) => (
                <li key={entry.id} className="demo-note-entry">
                  {editingNoteId === entry.id ? (
                    <input
                      autoFocus
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
                      style={NOTE_TAG_COLORS[entry.text] ? { background: NOTE_TAG_COLORS[entry.text] } : undefined}
                      onClick={() => {
                        setEditingNoteId(entry.id);
                        setNoteEditDraft(entry.text);
                      }}
                    >
                      {entry.text}
                    </button>
                  )}
                  <span className="demo-note-entry-time">{formatHistoryTimestamp(entry.createdAt)}</span>
                  <button type="button" onClick={() => void handleRemove(entry.id, entry.text)}>
                    <X size={12} />
                  </button>
                </li>
              ))}
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
