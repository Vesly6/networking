import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
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
import { requestCallback, sendSms, type SmsLogRecord } from '../../utils/callsApi';
import { insertIntoSoftphone } from '../../utils/softphoneBridge';
import { phoneMatchKey } from '../../utils/phoneMatch';
import { useToastStore } from '../../store/useToastStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { getAllTranscriptions, saveSmsLogEntry, getAllSmsLog } from '../../db/db';
import { ApolloContactSearchModal } from './ApolloContactSearchModal';

interface CellHoverEditorProps {
  anchor: HTMLElement;
  mode: 'note' | 'contact';
  value: string;
  /** This row's Company-column value, if any — feeds the "🔍 Paieška"
   * Apollo lookup in contact mode (resolve company name -> org id ->
   * people at that company). Undefined/empty just disables that lookup
   * with an explanatory tooltip; contact mode otherwise works unchanged. */
  companyName?: string;
  /** Scrolls to and briefly flashes one specific contact entry once this
   * editor has placed itself — driven by the Calls tab's "🔍 Ieškoti" jump
   * (a missed call matched to a specific person inside this row's Contacts
   * entries, not just the row itself). Not used in note mode. */
  highlightEntryId?: string | null;
  onAddNoteEntry: (text: string) => void;
  onUpdateNoteEntry: (id: string, text: string) => void;
  onRemoveNoteEntry: (id: string) => void;
  /** `id` is optional and only ever passed by the Apollo modal (see
   * ApolloContactSearchModal.tsx) — it needs to know the new entry's id up
   * front so a background phone-lookup can update that exact entry later. */
  onAddContact: (text: string, id?: string) => void;
  onUpdateContact: (id: string, text: string) => void;
  onRemoveContact: (id: string) => void;
  onClose: () => void;
}

const MARGIN = 8;
// Enough room to show the new-entry input + the tag row + a couple of
// history entries meaningfully — anything less and the editor is open but
// not actually usable.
const MIN_USABLE_HEIGHT = 220;

const EMPTY_CONTACT_FIELDS: ContactFormFields = { firstName: '', lastName: '', position: '', email: '', phone: '' };

// Quick-log buttons for the common entries in a call/sales workflow (sent
// an email, scheduled a meeting) — each just adds a new dated comment
// entry with this exact text, same as typing it into "Pridėti komentarą…"
// and hitting Enter, just faster for the entries logged constantly. Each
// carries its own muted (never bright) background so the tags are visually
// distinct at a glance in the history list below.
const NOTE_TAGS: Array<{ label: string; color: string }> = [
  { label: 'Laiškas', color: '#e3ecf7' },
  { label: 'Laiško priminimas', color: '#e1f0ef' },
  { label: 'Pasiūlymas', color: '#e5f0e3' },
  { label: 'Pasiūlymo priminimas', color: '#f3f0dd' },
  { label: 'Susitikimas suderintas', color: '#eee3f3' },
  { label: 'Susitikimas įvykdytas', color: '#f5e3ec' },
  { label: 'Skambutis', color: '#f6e9dd' },
];
// A history entry logged via one of the quick-tag buttons above carries the
// exact tag label as its text — this maps that label back to the same
// color for the history list, so a comment's origin tag stays visually
// identifiable there too. An entry whose text doesn't exactly match a tag
// (typed free text, or a tag entry since edited into something else) just
// falls back to no color — no error, since notes are free text and were
// never guaranteed to match a tag in the first place.
const NOTE_TAG_COLORS: Record<string, string> = Object.fromEntries(NOTE_TAGS.map((t) => [t.label, t.color]));

// Temporarily disabled on explicit request — kept (not deleted) since
// callContact/requestCallback are meant to come back, not go away for
// good. Flip back to true to restore the 📞 button on each contact entry.
const CONTACT_CALL_BUTTON_ENABLED = false;

export function CellHoverEditor({
  anchor,
  mode,
  value,
  companyName,
  highlightEntryId,
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
  const [loadingLastSummary, setLoadingLastSummary] = useState(false);
  const [apolloModalOpen, setApolloModalOpen] = useState(false);
  // Which contact entry (by id) currently has the SMS compose box open —
  // one at a time, same "only one thing expanded" convention as
  // editingContactId/editingNoteId elsewhere in this file.
  const [smsComposeFor, setSmsComposeFor] = useState<string | null>(null);
  const [smsDraft, setSmsDraft] = useState('');
  const [sendingSms, setSendingSms] = useState(false);
  // Every past send attempt (success or failure) to *this* phone number,
  // shown right in the compose box — added because there was previously no
  // way at all to check whether a given SMS actually went out (Zadarma's
  // API has no status/history method, and this app didn't persist
  // anything about a send either). Loaded fresh each time compose opens.
  const [smsHistory, setSmsHistory] = useState<SmsLogRecord[]>([]);
  const skipNoteEditCommitRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Scrolls to and flashes the one contact entry the Calls tab's "🔍
  // Ieškoti" jump asked for — highlightEntryId only ever arrives together
  // with this editor already being freshly opened (TableView's
  // focusContact effect calls openCellEditor() right before this), so a
  // short delay is enough for layout to settle before scrollIntoView runs.
  const [flashEntryId, setFlashEntryId] = useState<string | null>(null);
  useEffect(() => {
    if (!highlightEntryId) return;
    const id = highlightEntryId;
    const timer = setTimeout(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-contact-id="${id}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setFlashEntryId(id);
    }, 60);
    const clearFlash = setTimeout(() => setFlashEntryId(null), 2200);
    return () => {
      clearTimeout(timer);
      clearTimeout(clearFlash);
    };
  }, [highlightEntryId]);

  // Neither the "Add a note" box nor the per-entry edit box had any real
  // height beyond the browser's default ~2-row textarea — fine for a short
  // logged line, but a pasted multi-paragraph email (a real, reported use
  // case: a client's reply, quoted into a note) rendered as a couple of
  // visible lines with the rest scrolled out of view inside a cramped box,
  // not editable "neatly." These grow each textarea to fit its actual
  // content (capped by the CSS max-height below, beyond which it falls
  // back to the textarea's own native internal scroll) instead of relying
  // on the user manually dragging the resize handle every single time.
  // Effects (not a plain ref callback) so this also re-fires — and shrinks
  // back down — when the draft is cleared after committing, and when
  // switching which entry is being edited.
  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  };
  const newEntryRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => autoGrow(newEntryRef.current), [newEntryDraft]);
  const editRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => autoGrow(editRef.current), [editDraft, editingNoteId]);

  const [addFields, setAddFields] = useState<ContactFormFields>(EMPTY_CONTACT_FIELDS);
  const [editingContactId, setEditingContactId] = useState<string | null>(null);
  const [editFields, setEditFields] = useState<ContactFormFields>(EMPTY_CONTACT_FIELDS);

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const minWidth = mode === 'contact' ? 340 : 240;
      const width = Math.max(rect.width, minWidth);
      const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN));
      // How tall the editor actually wants to be, measured from its own
      // rendered content (scrollHeight reflects the full content height
      // regardless of any maxHeight/overflow already applied to the node —
      // it's never "capped" by a previous placement). This used to be a
      // flat MIN_USABLE_HEIGHT guess, which fell out of date the moment the
      // contact form grew a Paieška button + results panel: the guess was
      // smaller than the now-taller (non-scrolling) form, so overflow:
      // hidden silently clipped the bottom of the form away on rows near
      // the viewport edge — a real, reported bug ("komentaras"/"kontaktas"
      // still unreachable on the last few rows even after the first fix).
      // Measuring the real content instead of guessing a constant makes
      // this correct regardless of how tall either mode's content gets in
      // the future.
      const naturalHeight = rootRef.current?.scrollHeight ?? MIN_USABLE_HEIGHT;
      const desiredHeight = Math.min(naturalHeight, window.innerHeight - MARGIN * 2);
      // Anchored at the cell's own top edge, growing downward, whenever
      // there's room below it for the full desired height. Once that room
      // is too small — a cell near the very bottom of the viewport, i.e.
      // the last few rows of a tall table — pull `top` up instead so the
      // editor still gets its full desired height, extending above the
      // cell rather than being squeezed under it.
      const availableBelow = window.innerHeight - rect.top - MARGIN;
      const top =
        availableBelow >= desiredHeight
          ? rect.top
          : Math.max(MARGIN, window.innerHeight - MARGIN - desiredHeight);
      // Previously only `top` was clamped into the viewport — nothing capped
      // the editor's own height, so adding enough contacts/notes could grow
      // it past the bottom of the screen. Since it's position:fixed, content
      // past the viewport edge isn't reachable by scrolling the page at all
      // (fixed elements don't move with page scroll) — it just became
      // inaccessible. maxHeight is the actual remaining room below `top`;
      // in the common case that's >= naturalHeight so nothing needs to
      // scroll at all. In the rare case a viewport is short enough that
      // even the fully-flipped-up position doesn't fit the whole natural
      // height, .cell-hover-editor's own overflow-y: auto (App.css) is the
      // last-resort fallback — the editor as a whole becomes scrollable
      // rather than silently clipping content with no way to reach it,
      // which is exactly what "overflow: hidden" used to do here.
      const maxHeight = window.innerHeight - top - MARGIN;
      setPos({ top, left, width, maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    // Content that changes the editor's natural height after the initial
    // placement (Apollo search results appearing, a contact/note entry
    // being added, switching a history entry into its edit textarea, …)
    // needs re-placement too — a ResizeObserver on the editor's own root
    // covers all of these in one place instead of trying to enumerate every
    // state change that can affect height as an effect dependency.
    const ro = new ResizeObserver(place);
    if (rootRef.current) ro.observe(rootRef.current);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      ro.disconnect();
    };
  }, [anchor, mode]);

  const commitNewEntry = () => {
    if (newEntryDraft.trim()) {
      onAddNoteEntry(newEntryDraft);
      setNewEntryDraft('');
    }
  };

  // "Last summary" — the described workflow is Call -> transcription ->
  // Summary -> immediately switch to the table and log it, so this is
  // deliberately "whatever my single most recently generated summary was,"
  // not scoped to this row's own company/phone — the user is acting right
  // after generating it, not searching back through history for one.
  const handleLastSummary = async () => {
    setLoadingLastSummary(true);
    try {
      const all = await getAllTranscriptions();
      const withSummary = all.filter((t) => t.summary && t.summary.trim());
      if (withSummary.length === 0) {
        showToast('Nėra jokios sukurtos santraukos');
        return;
      }
      const latest = withSummary.reduce((max, t) => (t.savedAt > max.savedAt ? t : max));
      onAddNoteEntry(latest.summary!);
    } catch {
      showToast('Nepavyko rasti paskutinės santraukos');
    } finally {
      setLoadingLastSummary(false);
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
    if (!(await confirmDialog('Išsaugoti šio kontakto pakeitimus?'))) return;
    const text = joinContactFields(editFields);
    if (text) onUpdateContact(editingContactId, text);
    setEditingContactId(null);
  };

  const removeNoteEntry = async (id: string) => {
    if (await confirmDialog({ message: 'Ištrinti šį komentaro įrašą?', danger: true })) onRemoveNoteEntry(id);
  };

  const removeContact = async (id: string) => {
    if (await confirmDialog({ message: 'Ištrinti šį kontaktą?', danger: true })) onRemoveContact(id);
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
      showToast(err instanceof Error ? err.message : 'Nepavyko sutvarkyti įklijuoto kontakto');
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
      showToast(`Skambinama ${number} — pakelkite telefoną`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Nepavyko pradėti skambučio');
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} nukopijuotas`);
    } catch {
      showToast('Nepavyko nukopijuoti — nėra prieigos prie iškarpinės');
    }
  };

  // Clicking a contact's phone number (the number itself, not the 📋
  // button — that still just copies, unchanged) sends it straight into
  // the Zadarma softphone's own input so the only thing left to do is
  // press its Call button. Falls back to copying instead, same as the
  // existing button, if the widget isn't on the page at all — no worse
  // than before in that case, not a dead click.
  const callViaSoftphone = async (phone: string) => {
    if (insertIntoSoftphone(phone)) {
      showToast('Numeris nusiųstas į telefono programėlę — spauskite skambinti ten');
      return;
    }
    try {
      await navigator.clipboard.writeText(phone);
      showToast('Telefono programėlė neatidaryta — vietoj to numeris nukopijuotas');
    } catch {
      showToast('Telefono programėlė neatidaryta, ir numerio nukopijuoti taip pat nepavyko');
    }
  };

  const openSmsCompose = async (contactId: string, phone: string) => {
    const willOpen = smsComposeFor !== contactId;
    setSmsComposeFor((prev) => (prev === contactId ? null : contactId));
    setSmsDraft('');
    if (!willOpen) return;
    const key = phoneMatchKey(phone);
    const all = await getAllSmsLog();
    const matching = key ? all.filter((r) => phoneMatchKey(r.phone) === key) : [];
    matching.sort((a, b) => b.sentAt - a.sentAt);
    setSmsHistory(matching);
  };

  // Confirmed before actually sending — same "irreversible, real-world
  // side effect" guard this app already uses for row-delete/note-delete/
  // contact-delete (confirmDialog), just applied here for the first time
  // to something that isn't a deletion: an SMS can't be recalled once
  // Zadarma accepts it, and costs real money per message.
  const handleSendSms = async (phone: string) => {
    const text = smsDraft.trim();
    if (!text) return;
    if (!(await confirmDialog(`Siųsti SMS ${phone}?\n\n${text}`))) return;
    setSendingSms(true);
    const entry: SmsLogRecord = { id: crypto.randomUUID(), phone, message: text, sentAt: Date.now(), success: false };
    try {
      const result = await sendSms(phone, text);
      entry.success = true;
      entry.cost = result.cost;
      entry.currency = result.currency;
      showToast(`SMS išsiųsta ${phone}`);
      setSmsComposeFor(null);
      setSmsDraft('');
    } catch (err) {
      entry.error = err instanceof Error ? err.message : 'Nepavyko išsiųsti SMS';
      showToast(entry.error);
    } finally {
      setSendingSms(false);
      // Logged regardless of outcome — a failed attempt is just as
      // important to have a record of as a successful one (see this
      // handler's own doc comment above and db.ts's smsLog store comment
      // for why this exists at all).
      void saveSmsLogEntry(entry);
      setSmsHistory((prev) => [entry, ...prev]);
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

  return (
    <>
      {createPortal(
        <div className="cell-hover-editor" ref={rootRef} style={style} onClick={(e) => e.stopPropagation()}>
          {mode === 'note' ? (
            <>
              <textarea
                ref={newEntryRef}
                className="cell-hover-new-entry"
                autoFocus
                placeholder="Pridėti komentarą…"
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
                <button
                  type="button"
                  className="cell-hover-tag cell-hover-tag-summary"
                  disabled={loadingLastSummary}
                  onClick={() => void handleLastSummary()}
                >
                  {loadingLastSummary ? 'Ieškoma…' : '🤖 Paskutinė santrauka'}
                </button>
                {NOTE_TAGS.map((tag) => (
                  <button
                    type="button"
                    key={tag.label}
                    className="cell-hover-tag"
                    style={{ backgroundColor: tag.color }}
                    onClick={() => onAddNoteEntry(tag.label)}
                  >
                    {tag.label}
                  </button>
                ))}
              </div>
              {parseNoteHistory(value).length > 0 && (
                <div className="cell-hover-history">
                  {parseNoteHistory(value).map((entry) => (
                    <div
                      key={entry.id}
                      className="cell-hover-history-entry"
                      style={
                        NOTE_TAG_COLORS[entry.text]
                          ? { backgroundColor: NOTE_TAG_COLORS[entry.text], borderRadius: '6px' }
                          : undefined
                      }
                    >
                      {entry.createdAt > 0 && (
                        <div className="cell-hover-history-time">{formatHistoryTimestamp(entry.createdAt)}</div>
                      )}
                      <div className="cell-hover-history-row">
                        {editingNoteId === entry.id ? (
                          <textarea
                            ref={editRef}
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
                          title="Ištrinti įrašą"
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
                <div className="cell-hover-contact-structured-label-row">
                  <div className="cell-hover-contact-structured-label">Pridėti kontaktą</div>
                  <button
                    type="button"
                    className="cell-hover-apollo-search-btn"
                    disabled={!companyName?.trim()}
                    onClick={() => setApolloModalOpen(true)}
                    title={
                      companyName
                        ? `Ieškoti žmonių įmonėje „${companyName}“ (Apollo)`
                        : 'Šiai eilutei nenustatytas įmonės pavadinimas'
                    }
                  >
                    🔍 Paieška
                  </button>
                </div>
                <form
                  className="cell-hover-contact-structured-grid"
                  onSubmit={(e) => {
                    e.preventDefault();
                    commitStructuredContact();
                  }}
                >
                  <input
                    placeholder="Vardas"
                    autoFocus
                    value={addFields.firstName}
                    onChange={(e) => updateAddField('firstName', e.target.value)}
                  />
                  <input
                    placeholder="Pavardė"
                    value={addFields.lastName}
                    onChange={(e) => updateAddField('lastName', e.target.value)}
                  />
                  <input
                    placeholder="Pareigos"
                    value={addFields.position}
                    onChange={(e) => updateAddField('position', e.target.value)}
                  />
                  <input
                    placeholder="El. paštas"
                    value={addFields.email}
                    onChange={(e) => updateAddField('email', e.target.value)}
                  />
                  <input
                    placeholder="Telefonas"
                    value={addFields.phone}
                    onChange={(e) => updateAddField('phone', e.target.value)}
                  />
                  <button type="submit" className="primary cell-hover-contact-add">
                    + Pridėti kontaktą
                  </button>
                </form>
              </div>

              <div className="cell-hover-contact-divider">arba įklijuokite laisvą tekstą</div>

              <div className="cell-hover-contact-form">
                <input
                  placeholder={parsingContact ? 'Tvarkoma…' : 'Vardas, telefonas, el. paštas…'}
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
                  + Pridėti kontaktą
                </button>
              </div>
              {parseContacts(value).length > 0 && (
                <div className="cell-hover-history">
                  {parseContacts(value).map((c) => {
                    const phone = extractPhoneNumber(c.text);
                    const isEditing = editingContactId === c.id;
                    return (
                      <div
                        key={c.id}
                        data-contact-id={c.id}
                        className={`cell-hover-contact-entry ${flashEntryId === c.id ? 'cell-hover-contact-entry-flash' : ''}`}
                      >
                        {isEditing ? (
                          <form
                            className="cell-hover-contact-structured-grid cell-hover-contact-edit-grid"
                            onSubmit={(e) => {
                              e.preventDefault();
                              void saveContactEdit();
                            }}
                          >
                            <input
                              placeholder="Vardas"
                              autoFocus
                              value={editFields.firstName}
                              onChange={(e) => updateEditField('firstName', e.target.value)}
                              onKeyDown={handleEditKeyDown}
                            />
                            <input
                              placeholder="Pavardė"
                              value={editFields.lastName}
                              onChange={(e) => updateEditField('lastName', e.target.value)}
                              onKeyDown={handleEditKeyDown}
                            />
                            <input
                              placeholder="Pareigos"
                              value={editFields.position}
                              onChange={(e) => updateEditField('position', e.target.value)}
                              onKeyDown={handleEditKeyDown}
                            />
                            <input
                              placeholder="El. paštas"
                              value={editFields.email}
                              onChange={(e) => updateEditField('email', e.target.value)}
                              onKeyDown={handleEditKeyDown}
                            />
                            <input
                              placeholder="Telefonas"
                              value={editFields.phone}
                              onChange={(e) => updateEditField('phone', e.target.value)}
                              onKeyDown={handleEditKeyDown}
                            />
                            <div className="cell-hover-contact-edit-actions">
                              <button type="submit" className="primary">
                                💾 Išsaugoti
                              </button>
                              <button type="button" onClick={cancelContactEdit}>
                                ✕ Atšaukti
                              </button>
                            </div>
                          </form>
                        ) : (
                          <>
                            <div className="cell-hover-contact-info">
                              {splitContactDisplayFields(c.text).map((field, i) => (
                                <div key={i} className={`cell-hover-contact-field cell-hover-contact-field-${field.kind}`}>
                                  {field.kind === 'phone' ? (
                                    <button
                                      type="button"
                                      className="cell-hover-contact-phone-value"
                                      title="Siųsti į telefono programėlę"
                                      onClick={() => void callViaSoftphone(field.value)}
                                    >
                                      {field.value}
                                    </button>
                                  ) : (
                                    field.value
                                  )}
                                  {field.kind === 'name' && (
                                    <button
                                      type="button"
                                      className="cell-hover-contact-copy"
                                      title="Kopijuoti vardą"
                                      onClick={() => void copyText(field.value, 'Vardas')}
                                    >
                                      📋
                                    </button>
                                  )}
                                  {field.kind === 'phone' && (
                                    <>
                                      <button
                                        type="button"
                                        className="cell-hover-contact-copy"
                                        title="Kopijuoti telefono numerį"
                                        onClick={() => void copyText(field.value, 'Telefono numeris')}
                                      >
                                        📋
                                      </button>
                                      <button
                                        type="button"
                                        className="cell-hover-contact-copy"
                                        title="Siųsti SMS"
                                        onClick={() => void openSmsCompose(c.id, field.value)}
                                      >
                                        ✉️
                                      </button>
                                    </>
                                  )}
                                  {field.kind === 'email' && (
                                    <button
                                      type="button"
                                      className="cell-hover-contact-copy"
                                      title="Kopijuoti el. paštą"
                                      onClick={() => void copyText(field.value, 'El. paštas')}
                                    >
                                      📋
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                            {smsComposeFor === c.id && phone && (
                              <form
                                className="cell-hover-sms-compose"
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  void handleSendSms(phone);
                                }}
                              >
                                <textarea
                                  autoFocus
                                  placeholder={`Rašyti SMS ${phone}…`}
                                  value={smsDraft}
                                  onChange={(e) => setSmsDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Escape') setSmsComposeFor(null);
                                  }}
                                />
                                <div className="cell-hover-sms-compose-actions">
                                  <button type="submit" className="primary" disabled={sendingSms || !smsDraft.trim()}>
                                    {sendingSms ? 'Siunčiama…' : '✉️ Siųsti'}
                                  </button>
                                  <button type="button" onClick={() => setSmsComposeFor(null)}>
                                    ✕ Atšaukti
                                  </button>
                                </div>
                                {smsHistory.length > 0 && (
                                  <div className="cell-hover-sms-history">
                                    <div className="cell-hover-sms-history-title">Ankstesnės SMS šiam numeriui</div>
                                    {smsHistory.map((r) => (
                                      <div key={r.id} className="cell-hover-sms-history-entry">
                                        <div className="cell-hover-history-time">
                                          {formatHistoryTimestamp(r.sentAt)} —{' '}
                                          {r.success ? (
                                            <span className="cell-hover-sms-history-ok">
                                              išsiųsta{r.cost ? ` (${r.cost} ${r.currency ?? ''})` : ''}
                                            </span>
                                          ) : (
                                            <span className="cell-hover-sms-history-fail">nepavyko: {r.error}</span>
                                          )}
                                        </div>
                                        <div className="cell-hover-sms-history-text">{r.message}</div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </form>
                            )}
                            {CONTACT_CALL_BUTTON_ENABLED && phone && (
                              <button
                                type="button"
                                className="cell-hover-contact-call"
                                title={`Skambinti ${phone}`}
                                onClick={() => void callContact(c.text)}
                              >
                                📞
                              </button>
                            )}
                            <button
                              type="button"
                              className="cell-hover-contact-edit"
                              title="Redaguoti kontaktą"
                              onClick={() => startEditingContact(c)}
                            >
                              ✏️
                            </button>
                            <button
                              type="button"
                              className="cell-hover-contact-remove"
                              title="Pašalinti kontaktą"
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
      )}
      {apolloModalOpen && companyName?.trim() && (
        <ApolloContactSearchModal
          initialCompanyName={companyName}
          onAddContact={onAddContact}
          onUpdateContact={onUpdateContact}
          onClose={() => setApolloModalOpen(false)}
        />
      )}
    </>
  );
}
