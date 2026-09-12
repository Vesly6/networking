import { useEffect, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import type { Column, Row } from '../types';
import { parseContacts, addContact, removeContact, getContactsSummary } from '../utils/contacts';
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
  onOpenContacts: () => void;
  contactsOpen: boolean;
  onCloseContacts: () => void;
}

/** A right-sized rebuild of the real DataCell.tsx for the demo's own
 * feature scope — same click-to-edit convention (text/company/phone/link
 * become a live input; dropdown/date stay native always-interactive
 * controls; contact opens an inline expanding list), the same `link` 🔗
 * open-in-new-tab and `company` 🔍 Google-search second click-targets
 * shipped in production this session, and the same search-match
 * highlighting — but without the worker-permission/note-history/
 * social-lookup machinery none of this demo needs. */
export function DemoDataCell({
  row,
  column,
  editable,
  highlightQuery,
  onSelect,
  onCommit,
  onOpenContacts,
  contactsOpen,
  onCloseContacts,
}: DemoDataCellProps) {
  const value = row.cells[column.id] ?? '';
  const [draft, setDraft] = useState(value);
  const [newContactText, setNewContactText] = useState('');

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
        <button type="button" className="demo-cell-preview demo-cell-preview-hoverable" tabIndex={-1} onClick={onOpenContacts}>
          {getContactsSummary(value) ? highlightMatches(getContactsSummary(value), highlightQuery) : <span className="demo-cell-empty">+ add contact</span>}
        </button>
        {contactsOpen && (
          <div className="demo-contact-popover" onClick={(e) => e.stopPropagation()}>
            <div className="demo-contact-popover-header">
              <span>Decision makers</span>
              <button type="button" className="demo-contact-popover-close" onClick={onCloseContacts}>
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

  if (editable) {
    return (
      <td className="demo-cell" style={cellStyle}>
        <input
          autoFocus
          type={column.type === 'phone' ? 'tel' : column.type === 'link' ? 'url' : 'text'}
          value={draft}
          style={cellStyle}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommit(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
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
