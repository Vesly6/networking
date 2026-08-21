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
  type ContactDisplayField,
} from '../../utils/contacts';
import { formatHistoryTimestamp } from '../../utils/date';
import { parseContactText } from '../../utils/contactsApi';
import { requestCallback, sendSms, type SmsLogRecord } from '../../utils/callsApi';
import { insertIntoSoftphone } from '../../utils/softphoneBridge';
import { phoneMatchKey } from '../../utils/phoneMatch';
import { randomUUID } from '../../utils/uuid';
import { contrastTextColor } from '../../utils/color';
import { useToastStore } from '../../store/useToastStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { getAllTranscriptions, saveSmsLogEntry, getAllSmsLog } from '../../db/db';
import { ApolloContactSearchModal } from './ApolloContactSearchModal';
import { SocialLookupModal } from './SocialLookupModal';
import { Popover } from '../Popover';

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
  /** This row's raw Contacts-cell value, if any — feeds the "neatsiliepė"
   * (didn't answer) quick-tag's contact picker in note mode (see
   * NEATSILIEPE_LABEL below). Same computed-once-per-row-in-TableView
   * convention as DataCell's own contactsRaw prop, and undefined/empty just
   * means that one tag has nothing to pick from — every other note feature
   * works unchanged. Not used in contact mode (that mode already has direct
   * access to this row's own contacts via `value`). */
  contactsRaw?: string;
  onAddNoteEntry: (text: string) => void;
  onUpdateNoteEntry: (id: string, text: string) => void;
  onRemoveNoteEntry: (id: string) => void;
  /** `id` is optional and only ever passed by the Apollo modal (see
   * ApolloContactSearchModal.tsx) — it needs to know the new entry's id up
   * front so a background phone-lookup can update that exact entry later. */
  onAddContact: (text: string, id?: string) => void;
  onUpdateContact: (id: string, text: string) => void;
  onRemoveContact: (id: string) => void;
  /** Records that a 🔍 Instagram/Facebook lookup came up with nothing the
   * user confirmed for that platform — see ContactEntry.socialLookup in
   * utils/contacts.ts for why this isn't just another updateContact()
   * call. A *found and confirmed* link doesn't need a dedicated prop — it
   * goes through the existing onUpdateContact above, same as any other
   * text change. */
  onSetContactSocialNotFound: (id: string, platform: 'instagram' | 'facebook') => void;
  onClose: () => void;
}

const MARGIN = 8;
// Enough room to show the new-entry input + the tag row + a couple of
// history entries meaningfully — anything less and the editor is open but
// not actually usable.
const MIN_USABLE_HEIGHT = 220;

const EMPTY_CONTACT_FIELDS: ContactFormFields = {
  firstName: '',
  lastName: '',
  position: '',
  company: '',
  email: '',
  phone: '',
  linkedinUrl: '',
  instagramUrl: '',
  facebookUrl: '',
};

// Quick-log buttons for the common entries in a call/sales workflow (sent
// an email, scheduled a meeting) — each just adds a new dated comment
// entry with this exact text, same as typing it into "Pridėti komentarą…"
// and hitting Enter, just faster for the entries logged constantly. Each
// carries its own muted (never bright) background so the tags are visually
// distinct at a glance in the history list below.
// Real platform logos (from /public/social-icons/, provided assets) rather
// than emoji — used in the compact social-links row below, one shared
// lookup for the icon src + accessible label per platform.
type SocialPlatform = 'linkedin' | 'instagram' | 'facebook';
const SOCIAL_ICON_SRC: Record<SocialPlatform, string> = {
  linkedin: '/social-icons/linkedin.png',
  instagram: '/social-icons/instagram.png',
  facebook: '/social-icons/facebook.png',
};
const SOCIAL_ICON_LABEL: Record<SocialPlatform, string> = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
};

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

// "neatsiliepė" (Lithuanian: "didn't answer") is a quick-tag like the ones
// above, but not a fixed label — clicking it opens a small picker of this
// row's own Contacts entries (see contactsRaw prop) so the exact person who
// didn't pick up can be named, e.g. "Andrius Ivanaitis neatsiliepė". Kept
// out of NOTE_TAGS (a plain "add this exact label" list) since its click
// behavior is genuinely different — it opens a picker instead of adding a
// note directly.
const NEATSILIEPE_SUFFIX = 'neatsiliepė';
const NEATSILIEPE_COLOR = '#e2e2e2';

// Same shape as neatsiliepė above, but the contact's name goes *after* the
// tag instead of before ("LinkedIn užklausa Andrius Ivanaitis", not
// "Andrius Ivanaitis LinkedIn užklausa") — matches how the request itself
// reads ("sent a LinkedIn request to X"), on explicit request. A distinct
// LinkedIn-blue-tinted pastel so it doesn't visually blend with "Laiškas"
// above (#e3ecf7), which is close but not identical.
const LINKEDIN_REQUEST_PREFIX = 'LinkedIn užklausa';
const LINKEDIN_REQUEST_COLOR = '#d6e7f7';

interface TaggedEntry {
  color: string;
  /** Just the fixed tag word/phrase — never the name/rest of the text. */
  tagLabel: string;
  /** Everything besides the tag itself (a contact's name for neatsiliepė/
   * LinkedIn entries, '' for a plain fixed-label tag like "Skambutis"). */
  restText: string;
  tagPosition: 'prefix' | 'suffix' | 'whole';
}

// On request — a tagged entry used to color its *entire* row's background,
// which read as "the whole line is shouting one color" for an entry that's
// mostly a name ("Andrius Ivanaitis neatsiliepė"). Splitting the tag word
// out from the rest of the text lets the render below show it as a small
// chip next to plain text instead, closer to how the quick-tag buttons
// above already look. This is purely a *display* change — entries are
// still stored as one plain string (parseNoteHistory/addNoteEntry
// untouched), this just parses that same string differently when
// rendering; a prefix/suffix check is still the only way to find a
// neatsiliepė/LinkedIn-request entry, since neither has a fixed stored
// flag for it — see the original getHistoryEntryColor this replaced.
function parseTaggedEntry(text: string): TaggedEntry | null {
  if (NOTE_TAG_COLORS[text]) {
    return { color: NOTE_TAG_COLORS[text], tagLabel: text, restText: '', tagPosition: 'whole' };
  }
  if (text.endsWith(` ${NEATSILIEPE_SUFFIX}`)) {
    return {
      color: NEATSILIEPE_COLOR,
      tagLabel: NEATSILIEPE_SUFFIX,
      restText: text.slice(0, -(NEATSILIEPE_SUFFIX.length + 1)),
      tagPosition: 'suffix',
    };
  }
  if (text.startsWith(`${LINKEDIN_REQUEST_PREFIX} `)) {
    return {
      color: LINKEDIN_REQUEST_COLOR,
      tagLabel: LINKEDIN_REQUEST_PREFIX,
      restText: text.slice(LINKEDIN_REQUEST_PREFIX.length + 1),
      tagPosition: 'prefix',
    };
  }
  return null;
}

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
  contactsRaw,
  onAddNoteEntry,
  onUpdateNoteEntry,
  onRemoveNoteEntry,
  onAddContact,
  onUpdateContact,
  onRemoveContact,
  onSetContactSocialNotFound,
  onClose,
}: CellHoverEditorProps) {
  const showToast = useToastStore((s) => s.show);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const [newEntryDraft, setNewEntryDraft] = useState('');
  const [contactDraft, setContactDraft] = useState('');
  const [parsingContact, setParsingContact] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [neatsiliepeAnchor, setNeatsiliepeAnchor] = useState<HTMLElement | null>(null);
  const [linkedinRequestAnchor, setLinkedinRequestAnchor] = useState<HTMLElement | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [loadingLastSummary, setLoadingLastSummary] = useState(false);
  const [apolloModalOpen, setApolloModalOpen] = useState(false);
  // Collapsed by default (rarely used — most contacts get added through
  // the Apollo search instead). Local state rather than reusing
  // FilterAccordionSection here: that component's whole header row is
  // itself a <button>, which the "🔍 Paieška" button couldn't sit inside
  // (invalid, un-clickable nested <button>-in-<button> markup) — this
  // keeps the same collapsible look (same CSS classes) but as a sibling
  // of Paieška in one flex row instead, so the two sit level with each
  // other, on explicit request ("кнопка поиск была бы на уровне с текстом
  // добавить контакт").
  // Collapsed by default — briefly defaulted to open while a separate,
  // real bug (crypto.randomUUID() throwing on a plain-HTTP LAN address —
  // see utils/uuid.ts) made adding a contact silently fail, which looked
  // at the time like the accordion itself was just too easy to miss.
  // With that actual bug fixed, collapsed-by-default is what's wanted
  // again — the form doesn't need to eat screen space every time a
  // contact cell is opened just to browse existing entries.
  const [manualContactFormOpen, setManualContactFormOpen] = useState(false);
  // Which contact entry (by id) currently has SocialLookupModal open —
  // one at a time, same convention as smsComposeFor/editingContactId below.
  const [socialLookupFor, setSocialLookupFor] = useState<string | null>(null);
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
  // Every SMS ever logged, prefetched once so a per-contact "✉️³" badge can
  // show *whether* history exists for a number before the user opens
  // compose — the compose box itself already loaded a phone-filtered copy
  // on open (openSmsCompose below), but with no badge there was no way to
  // know history existed at all short of clicking ✉️ speculatively, which
  // is exactly what got reported as "I don't see any SMS history anywhere."
  const [allSmsHistory, setAllSmsHistory] = useState<SmsLogRecord[]>([]);
  useEffect(() => {
    if (mode !== 'contact') return;
    let cancelled = false;
    void getAllSmsLog().then((all) => {
      if (!cancelled) setAllSmsHistory(all);
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);
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
      // The table is virtualized (TableView.tsx) — scrolling far enough
      // that this editor's own row leaves the rendered window unmounts
      // its <tr>/<td>s entirely, turning `anchor` into a detached DOM
      // node. getBoundingClientRect() on a detached node returns an
      // all-zero rect, which without this check made the editor visibly
      // snap to the viewport's top-left corner mid-scroll — a real,
      // reported bug ("the note window jumps to the left side"). Once the
      // anchor is gone there's no sensible cell left to stay anchored to,
      // so this closes the editor instead of rendering it somewhere
      // meaningless.
      if (!anchor.isConnected) {
        onClose();
        return;
      }
      const rect = anchor.getBoundingClientRect();
      // A second, related case confirmed live while testing the fix
      // above: on a table with few enough rows that the virtualizer's
      // overscan keeps *every* row mounted regardless of scroll position,
      // the anchor never actually disconnects — but scrolling far enough
      // still moves its rect deeply outside the viewport (e.g. top:
      // -730px, still "connected"). Without this check that negative top
      // was used as-is, rendering the editor as a huge, disconnected-
      // looking overlay pinned near the viewport edge instead of tracking
      // any real cell. Once the anchor isn't visible at all anymore
      // (scrolled fully above/below/left/right of the viewport), there's
      // equally nothing sensible left to anchor to, so this closes too.
      if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) {
        onClose();
        return;
      }
      // Doubled from 240 on explicit request ("увеличим в размере на два
      // раза") — the note editor's single-line comment input + tag row
      // read as cramped at the old width. Contact mode's 340 is unrelated
      // and untouched; the request was specifically about notes.
      //
      // That desktop-oriented width had no ceiling, though — on an actual
      // phone (innerWidth ~375-430px) a flat 480px popup simply doesn't
      // fit: `left` below clamps to stay on-screen, but the box itself
      // stayed 480px wide regardless, so its right edge still ran well
      // past the viewport (real, reported complaint — "заходит за
      // рамку"). Capping at the same MARGIN-based budget `desiredHeight`
      // already uses below fixes this on mobile while leaving desktop
      // completely unaffected (innerWidth there is always well above
      // 480+2*MARGIN, so this min() never actually engages).
      const minWidth = mode === 'contact' ? 340 : 480;
      const maxWidth = window.innerWidth - MARGIN * 2;
      const width = Math.min(Math.max(rect.width, minWidth), maxWidth);
      const left = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - width - MARGIN));
      // Prefer the VisualViewport's height over window.innerHeight for
      // every height calculation below. The two diverge specifically when
      // an on-screen keyboard is open: some browsers/viewport-meta
      // configurations shrink window.innerHeight right along with the
      // keyboard ("resizes-content" behavior, the traditional default —
      // window.innerHeight already correctly reflects the smaller usable
      // area there), but others leave window.innerHeight at its full,
      // pre-keyboard size and only report the shrunk usable area through
      // VisualViewport ("resizes-visual" behavior). Using innerHeight
      // unconditionally meant that on the second kind, this editor kept
      // sizing/positioning itself against a viewport taller than what was
      // actually visible the instant the keyboard opened — its own
      // controls (the "+ Pridėti kontaktą" button, the tag row) could end
      // up positioned underneath the keyboard, unreachable. This is a
      // strict improvement either way: when the two already match (no
      // keyboard, or a browser using resizes-content), visualViewport's
      // height equals innerHeight and nothing changes.
      const rawViewportHeight = window.visualViewport?.height ?? window.innerHeight;
      // On a phone with a gesture-navigation bar (most current Android
      // phones) or a home indicator (iPhone X and later), that strip
      // along the very bottom of the screen is reserved by the OS — a
      // tap landing there gets intercepted by system gesture handling
      // before it ever reaches the page, even though the element is
      // genuinely rendered and its coordinates look perfectly valid to
      // both this code and to Playwright's own automation, which is
      // exactly why this couldn't be caught by testing alone. Real,
      // reported complaint: buttons near the bottom of this popup
      // ("не разрешает даже нажать на кнопку") not responding to a real
      // tap. Reading it via a CSS custom property (env() isn't directly
      // readable from JS) — see index.css and index.html's own
      // viewport-fit=cover, required for this to report anything but 0.
      const safeAreaBottom = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--safe-area-inset-bottom') || '0',
      );
      const viewportHeight = rawViewportHeight - (Number.isFinite(safeAreaBottom) ? safeAreaBottom : 0);
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
      const desiredHeight = Math.min(naturalHeight, viewportHeight - MARGIN * 2);
      // Anchored at the cell's own top edge, growing downward, whenever
      // there's room below it for the full desired height. Once that room
      // is too small — a cell near the very bottom of the viewport, i.e.
      // the last few rows of a tall table — pull `top` up instead so the
      // editor still gets its full desired height, extending above the
      // cell rather than being squeezed under it.
      const availableBelow = viewportHeight - rect.top - MARGIN;
      const top =
        availableBelow >= desiredHeight
          ? rect.top
          : Math.max(MARGIN, viewportHeight - MARGIN - desiredHeight);
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
      const maxHeight = viewportHeight - top - MARGIN;
      setPos({ top, left, width, maxHeight });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    // On mobile, opening the on-screen keyboard doesn't reliably fire a
    // plain `resize` on `window` — Chrome/Android and Safari/iOS both
    // increasingly report keyboard-driven size changes through the
    // VisualViewport API instead, leaving `window.innerHeight` as the
    // full (pre-keyboard) height in that case. Without this, `place()`'s
    // math above (top/maxHeight computed from `window.innerHeight`) stays
    // anchored to a taller viewport than what's actually visible once the
    // keyboard is up — real, reported complaint ("не могу добавить
    // заметку/контакт с телефона") that this editor's own controls could
    // end up positioned underneath the keyboard, unreachable, with
    // nothing about it looking visibly broken from a screenshot alone.
    //
    // Deliberately `resize` only, not also `scroll` — `visualViewport`'s
    // `scroll` event fires on essentially every pixel of scroll momentum
    // and every browser-chrome show/hide animation on mobile, far more
    // often than the plain `window.addEventListener('scroll', place,
    // true)` below already handles. Adding a second, more trigger-happy
    // listener calling the same fairly expensive place() (getBoundingClientRect
    // + getComputedStyle + a React state update) on top of that was a real
    // regression on an actual phone's weaker CPU, not visible in desktop-
    // based testing at all: a real, reported "button stops responding to
    // taps entirely" complaint that only showed up after this was added.
    window.visualViewport?.addEventListener('resize', place);
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
      window.visualViewport?.removeEventListener('resize', place);
      ro.disconnect();
    };
    // onClose intentionally excluded — it's a fresh inline closure every
    // render (TableView's `() => { setExpandedCell(null); ... }`), so
    // including it would re-run this positioning effect (and briefly flash
    // the editor to its -9999 hidden position) on every unrelated parent
    // re-render. It's parameter-free and doesn't close over anything
    // row/column-specific, so calling whichever version happened to be
    // captured is always equivalent — this effect is meant to re-run only
    // when the anchored cell itself changes (anchor/mode), same as before
    // the anchor.isConnected check above was added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // One compact row per contact for LinkedIn/Instagram/Facebook (real
  // logo icons, not text lines) — consolidated out of the per-field list
  // below on explicit request ("соц сети тоже по дефолту будут ближе"):
  // three separate full-width text lines read as far apart, especially
  // once each carried its own copy button. `field` present means a
  // confirmed/typed link exists (rendered as a clickable icon + copy
  // button); `notFound` (Instagram/Facebook only — LinkedIn has no AI
  // search, so no not-found state) renders the same logo faded and
  // non-interactive, so a person who was checked and came up empty still
  // shows *something* rather than nothing at all.
  const renderSocialIcon = (platform: SocialPlatform, field: ContactDisplayField | undefined, notFound?: boolean) => {
    if (field) {
      return (
        <span key={platform} className="cell-hover-social-icon-wrap">
          <a
            href={field.value}
            target="_blank"
            rel="noopener noreferrer"
            title={`Atidaryti ${SOCIAL_ICON_LABEL[platform]} profilį`}
            onClick={(e) => e.stopPropagation()}
          >
            <img src={SOCIAL_ICON_SRC[platform]} alt={SOCIAL_ICON_LABEL[platform]} className="cell-hover-social-icon" />
          </a>
          <button
            type="button"
            className="cell-hover-contact-copy"
            title={`Kopijuoti ${SOCIAL_ICON_LABEL[platform]} nuorodą`}
            onClick={() => void copyText(field.value, `${SOCIAL_ICON_LABEL[platform]} nuoroda`)}
          >
            📋
          </button>
        </span>
      );
    }
    if (notFound) {
      return (
        <img
          key={platform}
          src={SOCIAL_ICON_SRC[platform]}
          alt={SOCIAL_ICON_LABEL[platform]}
          title={`AI paieška atlikta — ${SOCIAL_ICON_LABEL[platform]} profilis nerastas. Spauskite 🔍, kad bandytumėte dar kartą.`}
          className="cell-hover-social-icon cell-hover-social-icon-not-found"
        />
      );
    }
    return null;
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
    const entry: SmsLogRecord = { id: randomUUID(), phone, message: text, sentAt: Date.now(), success: false };
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
      // Keeps the ✉️ badge count (allSmsHistory, prefetched once on mount)
      // live for a send that happens during this same session, without
      // needing to close and reopen the editor to see the count update.
      setAllSmsHistory((prev) => [entry, ...prev]);
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
        <div
          className="cell-hover-editor"
          ref={rootRef}
          style={style}
          onClick={(e) => {
            e.stopPropagation();
            setNeatsiliepeAnchor(null);
            setLinkedinRequestAnchor(null);
          }}
        >
          {mode === 'note' ? (
            <>
              <div className="cell-hover-new-entry-row">
                <textarea
                  ref={newEntryRef}
                  className="cell-hover-new-entry"
                  autoFocus
                  placeholder="Pridėti komentarą…"
                  value={newEntryDraft}
                  onChange={(e) => setNewEntryDraft(e.target.value)}
                  onBlur={commitNewEntry}
                  onKeyDown={(e) => {
                    // e.keyCode is deprecated but still the one property
                    // that reliably reports 13 on some Android keyboards'
                    // IME composition flow, where e.key can come through
                    // as "Unidentified" instead of "Enter" — a real,
                    // known mobile quirk this codebase can't fully
                    // reproduce in desktop-based testing. Checking both
                    // is strictly more permissive, never less.
                    if ((e.key === 'Enter' || e.keyCode === 13) && !e.shiftKey) {
                      e.preventDefault();
                      commitNewEntry();
                    }
                    if (e.key === 'Escape') {
                      setNewEntryDraft('');
                      onClose();
                    }
                  }}
                />
                {/* Explicit, always-visible save action — real, reported
                    complaint that relying on Enter/blur alone didn't
                    reliably save from a phone. Not conditionally shown
                    only when there's a draft either — an always-present
                    button is a much clearer, more discoverable affordance
                    than one that pops in and out. */}
                <button
                  type="button"
                  className="cell-hover-new-entry-save"
                  title="Išsaugoti"
                  onClick={() => commitNewEntry()}
                >
                  ✓
                </button>
              </div>
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
                    style={{ backgroundColor: tag.color, color: contrastTextColor(tag.color) }}
                    onClick={() => onAddNoteEntry(tag.label)}
                  >
                    {tag.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="cell-hover-tag"
                  style={{ backgroundColor: NEATSILIEPE_COLOR, color: contrastTextColor(NEATSILIEPE_COLOR) }}
                  disabled={parseContacts(contactsRaw ?? '').length === 0}
                  title={
                    parseContacts(contactsRaw ?? '').length === 0
                      ? 'Šioje eilutėje dar nėra kontaktų'
                      : 'Pasirinkite, kas neatsiliepė'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    const anchorEl = e.currentTarget;
                    setNeatsiliepeAnchor((prev) => (prev ? null : anchorEl));
                  }}
                >
                  {NEATSILIEPE_SUFFIX}
                </button>
                <button
                  type="button"
                  className="cell-hover-tag"
                  style={{ backgroundColor: LINKEDIN_REQUEST_COLOR, color: contrastTextColor(LINKEDIN_REQUEST_COLOR) }}
                  disabled={parseContacts(contactsRaw ?? '').length === 0}
                  title={
                    parseContacts(contactsRaw ?? '').length === 0
                      ? 'Šioje eilutėje dar nėra kontaktų'
                      : 'Pasirinkite, kam išsiųsta LinkedIn užklausa'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    const anchorEl = e.currentTarget;
                    setLinkedinRequestAnchor((prev) => (prev ? null : anchorEl));
                  }}
                >
                  {LINKEDIN_REQUEST_PREFIX}
                </button>
              </div>
              {neatsiliepeAnchor && (
                <Popover anchor={neatsiliepeAnchor} width={220}>
                  <div className="popover-field">
                    <span>Kas neatsiliepė?</span>
                  </div>
                  {parseContacts(contactsRaw ?? '').map((c) => {
                    const { firstName, lastName } = contactTextToFields(c.text);
                    const name = `${firstName} ${lastName}`.trim() || c.text;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className="date-cell-contact-option"
                        onClick={() => {
                          onAddNoteEntry(`${name} ${NEATSILIEPE_SUFFIX}`);
                          setNeatsiliepeAnchor(null);
                        }}
                      >
                        {name}
                      </button>
                    );
                  })}
                </Popover>
              )}
              {linkedinRequestAnchor && (
                <Popover anchor={linkedinRequestAnchor} width={220}>
                  <div className="popover-field">
                    <span>Kam išsiųsta LinkedIn užklausa?</span>
                  </div>
                  {parseContacts(contactsRaw ?? '').map((c) => {
                    const { firstName, lastName } = contactTextToFields(c.text);
                    const name = `${firstName} ${lastName}`.trim() || c.text;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        className="date-cell-contact-option"
                        onClick={() => {
                          onAddNoteEntry(`${LINKEDIN_REQUEST_PREFIX} ${name}`);
                          setLinkedinRequestAnchor(null);
                        }}
                      >
                        {name}
                      </button>
                    );
                  })}
                </Popover>
              )}
              {parseNoteHistory(value).length > 0 && (
                <div className="cell-hover-history">
                  {parseNoteHistory(value).map((entry) => {
                    const tagged = parseTaggedEntry(entry.text);
                    return (
                    <div key={entry.id} className="cell-hover-history-entry">
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
                            {/* On request — a tag used to color the whole
                                entry's background, which read as "the
                                whole line shouting one color" for an
                                entry that's mostly a name ("Andrius
                                Ivanaitis neatsiliepė"). Now only the tag
                                word itself renders as a small colored
                                chip (matching the quick-tag buttons
                                above), with any name/rest of the text
                                staying plain — the entry itself is never
                                colored anymore, so it no longer needs its
                                own contrastTextColor fix either. */}
                            {!tagged ? (
                              entry.text
                            ) : tagged.tagPosition === 'suffix' ? (
                              <>
                                {tagged.restText && `${tagged.restText} `}
                                <span
                                  className="cell-hover-history-tag-chip"
                                  style={{ backgroundColor: tagged.color, color: contrastTextColor(tagged.color) }}
                                >
                                  {tagged.tagLabel}
                                </span>
                              </>
                            ) : tagged.tagPosition === 'prefix' ? (
                              <>
                                <span
                                  className="cell-hover-history-tag-chip"
                                  style={{ backgroundColor: tagged.color, color: contrastTextColor(tagged.color) }}
                                >
                                  {tagged.tagLabel}
                                </span>
                                {tagged.restText && ` ${tagged.restText}`}
                              </>
                            ) : (
                              <span
                                className="cell-hover-history-tag-chip"
                                style={{ backgroundColor: tagged.color, color: contrastTextColor(tagged.color) }}
                              >
                                {tagged.tagLabel}
                              </span>
                            )}
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
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="cell-hover-contact-header-row">
                <button
                  type="button"
                  className="filter-accordion-header cell-hover-contact-manual-toggle"
                  onClick={() => setManualContactFormOpen((v) => !v)}
                >
                  <span className="filter-accordion-title">+ Pridėti kontaktą rankiniu būdu</span>
                  <span className={`filter-accordion-chevron ${manualContactFormOpen ? 'filter-accordion-chevron-open' : ''}`}>
                    ▾
                  </span>
                </button>
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
              {manualContactFormOpen && (
                <div className="filter-accordion-body cell-hover-contact-manual-body">
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
                      placeholder="Įmonė"
                      value={addFields.company}
                      onChange={(e) => updateAddField('company', e.target.value)}
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
                    <input
                      placeholder="LinkedIn nuoroda"
                      value={addFields.linkedinUrl}
                      onChange={(e) => updateAddField('linkedinUrl', e.target.value)}
                    />
                    <button type="submit" className="primary cell-hover-contact-add">
                      + Pridėti kontaktą
                    </button>
                  </form>

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
                </div>
              )}
              {parseContacts(value).length > 0 && (
                <div className="cell-hover-history">
                  {parseContacts(value).map((c) => {
                    const phone = extractPhoneNumber(c.text);
                    const isEditing = editingContactId === c.id;
                    const fields = splitContactDisplayFields(c.text);
                    const linkedinField = fields.find((f) => f.kind === 'linkedin');
                    const instagramField = fields.find((f) => f.kind === 'instagram');
                    const facebookField = fields.find((f) => f.kind === 'facebook');
                    const showSocialRow =
                      linkedinField ||
                      instagramField ||
                      facebookField ||
                      c.socialLookup?.instagramNotFound ||
                      c.socialLookup?.facebookNotFound;
                    // Only actually needed while this entry's
                    // SocialLookupModal is open, but computing it
                    // unconditionally here (once) is simpler and cheaper
                    // than three separate contactTextToFields() calls
                    // inline in the modal's props below.
                    const socialLookupFields = contactTextToFields(c.text);
                    const phoneSmsCount = phone
                      ? allSmsHistory.filter((r) => phoneMatchKey(r.phone) === phoneMatchKey(phone)).length
                      : 0;
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
                              placeholder="Įmonė"
                              value={editFields.company}
                              onChange={(e) => updateEditField('company', e.target.value)}
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
                            <input
                              placeholder="LinkedIn nuoroda"
                              value={editFields.linkedinUrl}
                              onChange={(e) => updateEditField('linkedinUrl', e.target.value)}
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
                            <div className="cell-hover-contact-main-row">
                              <div className="cell-hover-contact-info">
                                {fields
                                  .filter((f) => f.kind !== 'linkedin' && f.kind !== 'instagram' && f.kind !== 'facebook')
                                  .map((field, i) => (
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
                                            title={
                                              phoneSmsCount > 0
                                                ? `Siųsti SMS (yra ${phoneSmsCount} ankstesnė(-ų) šiam numeriui — spauskite, kad matytumėte)`
                                                : 'Siųsti SMS'
                                            }
                                            onClick={() => void openSmsCompose(c.id, field.value)}
                                          >
                                            ✉️{phoneSmsCount > 0 && <span className="cell-hover-contact-sms-badge">{phoneSmsCount}</span>}
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
                                {showSocialRow && (
                                  <div className="cell-hover-contact-social-links">
                                    {renderSocialIcon('linkedin', linkedinField)}
                                    {renderSocialIcon('instagram', instagramField, c.socialLookup?.instagramNotFound)}
                                    {renderSocialIcon('facebook', facebookField, c.socialLookup?.facebookNotFound)}
                                  </div>
                                )}
                              </div>
                              <div className="cell-hover-contact-actions">
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
                                  className="cell-hover-contact-social-search"
                                  title="Ieškoti Instagram / Facebook (AI)"
                                  onClick={() => setSocialLookupFor(c.id)}
                                >
                                  🔍
                                </button>
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
                              </div>
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
                          </>
                        )}
                        {socialLookupFor === c.id && (
                          <SocialLookupModal
                            firstName={socialLookupFields.firstName}
                            lastName={socialLookupFields.lastName}
                            company={socialLookupFields.company}
                            onConfirm={(platform, url) => {
                              if (url) {
                                onUpdateContact(c.id, [c.text, url].filter(Boolean).join(', '));
                              } else {
                                onSetContactSocialNotFound(c.id, platform);
                              }
                            }}
                            onClose={() => setSocialLookupFor(null)}
                          />
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
          existingContactsRaw={value}
          onAddContact={onAddContact}
          onUpdateContact={onUpdateContact}
          onClose={() => setApolloModalOpen(false)}
        />
      )}
    </>
  );
}
