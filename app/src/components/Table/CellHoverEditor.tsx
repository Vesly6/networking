import { useLayoutEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { parseNoteHistory } from '../../utils/noteHistory';
import {
  parseContacts,
  extractPhoneNumber,
  splitContactDisplayFields,
  joinContactFields,
  contactTextToFields,
  type ContactEntry,
  type ContactFormFields,
} from '../../utils/contacts';
import { formatHistoryTimestamp } from '../../utils/date';
import { parseContactText } from '../../utils/contactsApi';
import { requestCallback } from '../../utils/callsApi';
import { useToastStore } from '../../store/useToastStore';
import { confirmDialog } from '../../store/useConfirmStore';

interface CellHoverEditorProps {
  anchor: HTMLElement;
  mode: 'note' | 'contact';
  value: string;
  onAddNoteEntry: (text: string) => void;
  onUpdateNoteEntry: (id: string, text: string) => void;
  onRemoveNoteEntry: (id: string) => void;
  onAddContact: (text: string) => void;
  onUpdateContact: (id: string, text: string) => void;
  onRemoveContact: (id: string) => void;
  onClose: () => void;
}

const MARGIN = 8;

const EMPTY_CONTACT_FIELDS: ContactFormFields = { firstName: '', lastName: '', position: '', email: '', phone: '' };

// Quick-log buttons for the common one-word entries in a call workflow
// ("sent an email", "had a meeting") — each just adds a new dated note
// entry with this exact text, same as typing it into "Add a note…" and
// hitting Enter, just faster for the entries logged constantly.
const NOTE_TAGS = ['Email', 'Email follow up', 'Meeting', 'Call follow up'];

// Temporarily disabled on explicit request — kept (not deleted) since
// callContact/requestCallback are meant to come back, not go away for
// good. Flip back to true to restore the 📞 button on each contact entry.
const CONTACT_CALL_BUTTON_ENABLED = false;

export function CellHoverEditor({
  anchor,
  mode,
  value,
  onAddNoteEntry,
  onUpdateNoteEntry,
  onRemoveNoteEntry,
  onAddContact,
  onUpdateContact,
  onRemoveContact,
  onClose,
}: CellHoverEditorProps) {
  const showToast = useToastStore((s) => s.show);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const [newEntryDraft, setNewEntryDraft] = useState('');
  const [contactDraft, setContactDraft] = useState('');
  const [parsingContact, setParsingContact] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const skipNoteEditCommitRef = useRef(false);

  const [addFields, setAddFields] = useState<ContactFormFields>(EMPTY_CONTACT_FIELDS);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<ContactFormFields>(EMPTY_CONTACT_FIELDS);

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const minWidth = mode === 'contact' ? 340 : 240;
      const width = Math.max(rect.width, minWidth);
      const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN));
      const top = Math.max(MARGIN, Math.min(rect.top, window.innerHeight - MARGIN - 60));
      // Previously only `top` was clamped into the viewport — nothing capped
      // the editor's own height, so adding enough contacts/notes could grow
      // it past the bottom of the screen. Since it's position:fixed, content
      // past the viewport edge isn't reachable by scrolling the page at all
      // (fixed elements don't move with page scroll) — it just became
      // inaccessible. maxHeight is the actual remaining room below `top`;
      // the CSS makes the contact/note list the one scrolling region within
      // that budget (the add-contact form above it stays fixed in place),
      // so it's "scroll the list," never "scroll the whole screen."
      const maxHeight = window.innerHeight - top - MARGIN;
      setPos({ top, left, width, maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, mode]);

  const commitNewEntry = () => {
    if (newEntryDraft.trim()) {
      onAddNoteEntry(newEntryDraft);
      setNewEntryDraft('');
    }
  };

  const startEditingNote = (id: string, text: string) => {
    setEditingNoteId(id);
    setEditDraft(text);
  };

  const commitNoteEdit = (id: string) => {
    if (skipNoteEditCommitRef.current) {
      skipNoteEditCommitRef.current = false;
    } else if (editDraft.trim()) {
      onUpdateNoteEntry(id, editDraft);
    }
    setEditingNoteId(null);
  };

  const commitContact = () => {
    if (!contactDraft.trim()) return;
    onAddContact(contactDraft);
    setContactDraft('');
  };

  const updateAddField = (key: keyof ContactFormFields, val: string) => setAddFields((f) => ({ ...f, [key]: val }));
  const updateEditField = (key: keyof ContactFormFields, val: string) => setEditFields((f) => ({ ...f, [key]: val }));

  const commitStructuredContact = () => {
    const text = joinContactFields(addFields);
    if (!text) return;
    onAddContact(text);
    setAddFields(EMPTY_CONTACT_FIELDS);
  };

  const startEditingContact = (c: ContactEntry) => {
    setEditingContactId(c.id);
    setEditFields(contactTextToFields(c.text));
  };

  const cancelContactEdit = () => setEditingContactId(null);

  const saveContactEdit = async () => {
    if (!editingContactId) return;
    if (!(await confirmDialog('Save changes to this contact?'))) return;
    const text = joinContactFields(editFields);
    if (text) onUpdateContact(editingContactId, text);
    setEditingContactId(null);
  };

  const removeNoteEntry = async (id: string) => {
    if (await confirmDialog({ message: 'Delete this note entry?', danger: true })) onRemoveNoteEntry(id);
  };

  const removeContact = async (id: string) => {
    if (await confirmDialog({ message: 'Delete this contact?', danger: true })) onRemoveContact(id);
  };

  const handleEditKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') cancelContactEdit();
  };

  // A multi-line paste (Apollo/LinkedIn-style export) gets cleaned up by AI
  // into one line before it lands in the field — a plain single-line paste
  // (or normal typing) is untouched, so this never spends anything on the
  // common case. The user still reviews/edits the result before "+ Add
  // contact" actually saves it — nothing is added automatically.
  const handleContactPaste = async (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text/plain');
    if (!pasted.includes('\n')) return; // let the normal single-line paste happen
    // stopPropagation is required, not optional: this native paste event
    // still bubbles all the way to `document` (portaled content is a real
    // DOM descendant of document.body, React's component-tree bubbling
    // quirk only applies to other React handlers, not this raw listener),
    // where TableView's own paste handler would otherwise ALSO process the
    // same clipboard data as a multi-cell TSV paste into the table.
    e.preventDefault();
    e.stopPropagation();
    setParsingContact(true);
    try {
      const { text } = await parseContactText(pasted);
      setContactDraft(text);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not clean up the pasted contact');
      setContactDraft(pasted.replace(/\s*\n\s*/g, ', ').trim());
    } finally {
      setParsingContact(false);
    }
  };

  const callContact = async (text: string) => {
    const number = extractPhoneNumber(text);
    if (!number) return;
    try {
      await requestCallback(number);
      showToast(`Calling ${number} — pick up your phone`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not start the call');
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} copied`);
    } catch {
      showToast('Could not copy — clipboard access denied');
    }
  };

  const style: CSSProperties = {
    position: 'fixed',
    top: pos?.top ?? -9999,
    left: pos?.left ?? -9999,
    width: pos?.width,
    maxHeight: pos?.maxHeight,
    visibility: pos ? 'visible' : 'hidden',
  };

  return createPortal(
    <div className="cell-hover-editor" style={style} onClick={(e) => e.stopPropagation()}>
      {mode === 'note' ? (
        <>
          <textarea
            className="cell-hover-new-entry"
            autoFocus
            placeholder="Add a note…"
            value={newEntryDraft}
            onChange={(e) => setNewEntryDraft(e.target.value)}
            onBlur={commitNewEntry}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                commitNewEntry();
              }
              if (e.key === 'Escape') {
                setNewEntryDraft('');
                onClose();
              }
            }}
          />
          <div className="cell-hover-tags">
            {NOTE_TAGS.map((tag) => (
              <button type="button" key={tag} className="cell-hover-tag" onClick={() => onAddNoteEntry(tag)}>
                {tag}
              </button>
            ))}
          </div>
          {parseNoteHistory(value).length > 0 && (
            <div className="cell-hover-history">
              {parseNoteHistory(value).map((entry) => (
                <div key={entry.id} className="cell-hover-history-entry">
                  {entry.createdAt > 0 && (
                    <div className="cell-hover-history-time">{formatHistoryTimestamp(entry.createdAt)}</div>
                  )}
                  <div className="cell-hover-history-row">
                    {editingNoteId === entry.id ? (
                      <textarea
                        className="cell-hover-history-edit"
                        autoFocus
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        onBlur={() => commitNoteEdit(entry.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            commitNoteEdit(entry.id);
                          }
                          if (e.key === 'Escape') {
                            skipNoteEditCommitRef.current = true;
                            e.currentTarget.blur();
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="cell-hover-history-text cell-hover-history-text-button"
                        onClick={() => startEditingNote(entry.id, entry.text)}
                      >
                        {entry.text}
                      </button>
                    )}
                    <button
                      type="button"
                      className="cell-hover-history-remove"
                      title="Delete entry"
                      onClick={() => {
                        void removeNoteEntry(entry.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="cell-hover-contact-structured-form">
            <div className="cell-hover-contact-structured-label">Add a contact</div>
            <form
              className="cell-hover-contact-structured-grid"
              onSubmit={(e) => {
                e.preventDefault();
                commitStructuredContact();
              }}
            >
              <input
                placeholder="First name"
                autoFocus
                value={addFields.firstName}
                onChange={(e) => updateAddField('firstName', e.target.value)}
              />
              <input
                placeholder="Last name"
                value={addFields.lastName}
                onChange={(e) => updateAddField('lastName', e.target.value)}
              />
              <input
                placeholder="Position"
                value={addFields.position}
                onChange={(e) => updateAddField('position', e.target.value)}
              />
              <input
                placeholder="Email"
                value={addFields.email}
                onChange={(e) => updateAddField('email', e.target.value)}
              />
              <input
                placeholder="Phone"
                value={addFields.phone}
                onChange={(e) => updateAddField('phone', e.target.value)}
              />
              <button type="submit" className="primary cell-hover-contact-add">
                + Add contact
              </button>
            </form>
          </div>

          <div className="cell-hover-contact-divider">or paste freeform text</div>

          <div className="cell-hover-contact-form">
            <input
              placeholder={parsingContact ? 'Cleaning up…' : 'Name, phone, email…'}
              value={contactDraft}
              // readOnly, not disabled — disabling a *focused* input forces
              // an immediate browser blur, which (via TableView's
              // withinTableFocus() check treating document.body as "still
              // fine") was the actual root cause of the paste-leaking-into-
              // the-table bug above. readOnly blocks typing without ever
              // touching focus.
              readOnly={parsingContact}
              onChange={(e) => setContactDraft(e.target.value)}
              onPaste={(e) => void handleContactPaste(e)}
              onBlur={commitContact}
              onKeyDown={(e) => e.key === 'Enter' && commitContact()}
            />
            <button type="button" className="primary cell-hover-contact-add" onClick={commitContact}>
              + Add contact
            </button>
          </div>
          {parseContacts(value).length > 0 && (
            <div className="cell-hover-history">
              {parseContacts(value).map((c) => {
                const phone = extractPhoneNumber(c.text);
                const isEditing = editingContactId === c.id;
                return (
                  <div key={c.id} className="cell-hover-contact-entry">
                    {isEditing ? (
                      <form
                        className="cell-hover-contact-structured-grid cell-hover-contact-edit-grid"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void saveContactEdit();
                        }}
                      >
                        <input
                          placeholder="First name"
                          autoFocus
                          value={editFields.firstName}
                          onChange={(e) => updateEditField('firstName', e.target.value)}
                          onKeyDown={handleEditKeyDown}
                        />
                        <input
                          placeholder="Last name"
                          value={editFields.lastName}
                          onChange={(e) => updateEditField('lastName', e.target.value)}
                          onKeyDown={handleEditKeyDown}
                        />
                        <input
                          placeholder="Position"
                          value={editFields.position}
                          onChange={(e) => updateEditField('position', e.target.value)}
                          onKeyDown={handleEditKeyDown}
                        />
                        <input
                          placeholder="Email"
                          value={editFields.email}
                          onChange={(e) => updateEditField('email', e.target.value)}
                          onKeyDown={handleEditKeyDown}
                        />
                        <input
                          placeholder="Phone"
                          value={editFields.phone}
                          onChange={(e) => updateEditField('phone', e.target.value)}
                          onKeyDown={handleEditKeyDown}
                        />
                        <div className="cell-hover-contact-edit-actions">
                          <button type="submit" className="primary">
                            💾 Save
                          </button>
                          <button type="button" onClick={cancelContactEdit}>
                            ✕ Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className="cell-hover-contact-info">
                          {splitContactDisplayFields(c.text).map((field, i) => (
                            <div key={i} className={`cell-hover-contact-field cell-hover-contact-field-${field.kind}`}>
                              {field.value}
                              {field.kind === 'phone' && (
                                <button
                                  type="button"
                                  className="cell-hover-contact-copy"
                                  title="Copy phone number"
                                  onClick={() => void copyText(field.value, 'Phone number')}
                                >
                                  📋
                                </button>
                              )}
                              {field.kind === 'email' && (
                                <button
                                  type="button"
                                  className="cell-hover-contact-copy"
                                  title="Copy email"
                                  onClick={() => void copyText(field.value, 'Email')}
                                >
                                  📋
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                        {CONTACT_CALL_BUTTON_ENABLED && phone && (
                          <button
                            type="button"
                            className="cell-hover-contact-call"
                            title={`Call ${phone}`}
                            onClick={() => void callContact(c.text)}
                          >
                            📞
                          </button>
                        )}
                        <button
                          type="button"
                          className="cell-hover-contact-edit"
                          title="Edit contact"
                          onClick={() => startEditingContact(c)}
                        >
                          ✏️
                        </button>
                        <button
                          type="button"
                          className="cell-hover-contact-remove"
                          title="Remove contact"
                          onClick={() => {
                            void removeContact(c.id);
                          }}
                        >
                          ×
                        </button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
