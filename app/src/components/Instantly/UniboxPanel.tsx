import { useEffect, useMemo, useRef, useState } from 'react';
import { useInstantlyInboxStore, type UniboxThread, type UniboxViewMode } from '../../store/useInstantlyInboxStore';
import { useInstantlyAccountsStore } from '../../store/useInstantlyAccountsStore';
import { useInstantlyCampaignsStore } from '../../store/useInstantlyCampaignsStore';
import { useToastStore } from '../../store/useToastStore';
import {
  syncInstantlyRepliesToTable,
  syncAllInstantlyCampaignsRepliesToTable,
  VISI_ATSAKYMAI_TABLE_NAME,
  type AllCampaignsSyncProgress,
} from '../../utils/instantlyReplySync';
import {
  INTEREST_STATUS_LABELS,
  INTEREST_STATUS_COLORS,
  PRIMARY_INTEREST_STATUSES,
  MORE_INTEREST_STATUSES,
  type UniboxThreadEmail,
} from '../../utils/instantlyApi';
import { Inbox, Mail, AlarmClock, Clock, Send, X, Link, ChevronRight, CornerUpRight, CornerUpLeft, Download, type LucideIcon } from 'lucide-react';

/** The "Daugiau" section — originally modeled directly on a screenshot of
 * Instantly's own real "More" menu (Inbox/Unread only/Reminders
 * only/Scheduled emails/Sent, in that order). "Tik neperskaityti" was
 * briefly moved to the very top on a follow-up request when this section
 * was still a click-to-expand submenu — once it became its own
 * always-open sidebar section (second filter block, right after
 * Statusas — see the "сделаем проще" request), that extra prominence
 * stopped being necessary, so it moved back to matching Instantly's own
 * original order (Inbox first, Unread second). Both maps' key order
 * drives the render below directly (Object.keys(VIEW_MODE_LABELS)), so
 * reordering here is the only change needed. */
const VIEW_MODE_LABELS: Record<UniboxViewMode, string> = {
  inbox: 'Inbox',
  unread: 'Tik neperskaityti',
  reminders: 'Tik priminimai',
  scheduled: 'Suplanuoti laiškai',
  sent: 'Išsiųsti',
};
const VIEW_MODE_ICONS: Record<UniboxViewMode, LucideIcon> = {
  inbox: Inbox,
  unread: Mail,
  reminders: AlarmClock,
  scheduled: Clock,
  sent: Send,
};

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString('lt-LT', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function daysAgo(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

/** A message is "ours" (sent by whichever of the connected mailboxes
 * handled this thread) exactly when its own from-address IS the mailbox
 * account — confirmed directly against real data (72/28 split on a real
 * account) rather than trusting the documented-but-unverified `ue_type`
 * enum. */
function isOutgoing(message: UniboxThreadEmail): boolean {
  return message.from_address_email === message.eaccount;
}

interface Party {
  name: string;
  address: string;
}

function party(email: UniboxThreadEmail | undefined, list: 'from' | 'to'): Party | null {
  if (!email) return null;
  const entries = list === 'from' ? email.from_address_json : email.to_address_json;
  const entry = entries?.[0];
  if (entry) return { name: entry.name?.trim() || entry.address, address: entry.address };
  const address = list === 'from' ? email.from_address_email : email.to_address_email_list;
  return address ? { name: address, address } : null;
}

/** The other side of the conversation — whoever isn't "us" on the latest
 * message. This is what the thread list/header should show (a client's
 * real name, not our own mailbox address). */
function otherParty(thread: UniboxThread): Party | null {
  const latest = thread.latest;
  return isOutgoing(latest) ? party(latest, 'to') : party(latest, 'from');
}

function statusKey(status: number | null | undefined): string {
  return status === null || status === undefined ? 'null' : String(status);
}

function initials(name: string): string {
  const ch = name.trim().charAt(0);
  return ch ? ch.toUpperCase() : '?';
}

function stripHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent || '').trim();
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/** Quoted-history HTML for the compose body — real email clients always
 * carry the prior message along under a reply/forward (confirmed
 * directly against this account's own real threads: every incoming
 * message already has several "On ..., X wrote:" layers quoted beneath
 * it), and a reply/forward sent *without* that quote reads as
 * conversation-less to whoever receives it. Deliberately built from
 * *text* (the original message's own body.text, or body.html stripped
 * down to text — see the html fallback below) rather than dropping its
 * raw html straight in — escapeHtml() is what makes this safe to drop
 * into a live, editable contentEditable region on this actual page
 * (unlike EmailBody's read-only, sandboxed iframe elsewhere in this
 * file, there's no sandbox here, so inserting a third party's raw HTML
 * verbatim into real page DOM would be a genuine stored-XSS opening —
 * escaping it and keeping it as plain text-in-a-blockquote closes that
 * off entirely while still giving the recipient the expected quoted
 * trail). Wrapped in `.instantly-quote` specifically so handleSend can
 * tell "the user's own new text" apart from "the quoted part" when
 * deciding whether there's actually anything new to send (see
 * hasUserContent below) — the quote itself always has non-empty text, so
 * a plain "is there any text at all" check would never catch an
 * accidentally-empty reply.
 */
// A real, reported bug: falling straight back to content_preview dropped
// almost the entire message whenever body.text happened to be empty
// (confirmed live — 3 of the first 4 real messages checked had
// body.text: '' despite body.html carrying the real, full content;
// content_preview is a fixed ~60-character teaser, not a fallback body).
// stripHtml(body.html) recovers the actual full text in exactly that
// case — this div is never attached to the document (see stripHtml's own
// definition), so parsing arbitrary third-party HTML into it to read
// .textContent back out never executes anything, same safety reasoning
// as escapeHtml() below.
function quoteBodyText(message: UniboxThreadEmail): string {
  return message.body?.text || stripHtml(message.body?.html ?? '') || message.content_preview || '';
}

/** One quoted message's own "date, sender wrote:" line + blockquoted body. */
function quoteMessageBlock(message: UniboxThreadEmail): string {
  const sender = party(message, 'from');
  const when = formatTimestamp(message.timestamp_email);
  const quotedBody = escapeHtml(quoteBodyText(message)).replace(/\n/g, '<br>');
  return (
    `<div>${when}, ${escapeHtml(sender?.name ?? '')} &lt;${escapeHtml(sender?.address ?? '')}&gt; rašė:</div>` +
    `<blockquote>${quotedBody}</blockquote>`
  );
}

/** Quoted-history HTML for the compose body — real email clients always
 * carry the *entire* prior conversation along under a reply/forward, and
 * a real, reported bug here: quoting only the single message being
 * replied to lost everything earlier the instant that one message's own
 * body didn't already happen to carry the full chain forward itself
 * (true for a message that arrived from someone else's real email
 * client, which typically does embed the whole history as its own plain
 * text — but NOT true for an earlier reply sent through this app's own
 * ComposePanel, which only ever quoted one level). Iterating every
 * message in the thread (oldest first, the natural reading order for a
 * growing quote trail) instead of just `thread.latest` is what actually
 * fixes that — every reply sent from here now carries the complete
 * history forward, regardless of what any single message's own body did
 * or didn't already include.
 *
 * Deliberately built from *text* (each message's own body.text, or
 * body.html stripped down to text — see quoteBodyText above) rather than
 * dropping raw html straight in — escapeHtml() is what makes this safe
 * to drop into a live, editable contentEditable region on this actual
 * page (unlike EmailBody's read-only, sandboxed iframe elsewhere in this
 * file, there's no sandbox here, so inserting a third party's raw HTML
 * verbatim into real page DOM would be a genuine stored-XSS opening —
 * escaping it and keeping it as plain text-in-a-blockquote closes that
 * off entirely while still giving the recipient the expected quoted
 * trail). Wrapped in `.instantly-quote` specifically so handleSend can
 * tell "the user's own new text" apart from "the quoted part" when
 * deciding whether there's actually anything new to send (see
 * hasUserContent below) — the quote itself always has non-empty text, so
 * a plain "is there any text at all" check would never catch an
 * accidentally-empty reply.
 */
function buildQuoteHtml(mode: 'reply' | 'forward', thread: UniboxThread): string {
  const latest = thread.latest;
  const orderedMessages = [...thread.messages].sort((a, b) => a.timestamp_email.localeCompare(b.timestamp_email));
  const historyHtml = orderedMessages.map(quoteMessageBlock).join('<div><br></div>');

  if (mode === 'forward') {
    const sender = party(latest, 'from');
    const recipientParty = party(latest, 'to');
    return (
      `<div class="instantly-quote">` +
      `<div>---------- Persiųstas laiškas ----------</div>` +
      `<div>Nuo: ${escapeHtml(sender?.name ?? '')} &lt;${escapeHtml(sender?.address ?? '')}&gt;</div>` +
      `<div>Data: ${formatTimestamp(latest.timestamp_email)}</div>` +
      `<div>Tema: ${escapeHtml(latest.subject ?? '')}</div>` +
      `<div>Kam: ${escapeHtml(recipientParty?.name ?? '')} &lt;${escapeHtml(recipientParty?.address ?? '')}&gt;</div>` +
      `<div><br></div>` +
      historyHtml +
      `</div>`
    );
  }
  return `<div class="instantly-quote">${historyHtml}</div>`;
}

/** Whether there's real, user-typed content beyond the auto-inserted
 * quote (see buildQuoteHtml) — checked on a clone with .instantly-quote
 * stripped out, since the quote alone always has non-empty text and a
 * plain "any text present" check would never catch an empty reply. */
function hasUserContent(bodyEl: HTMLElement): boolean {
  const clone = bodyEl.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.instantly-quote').forEach((el) => el.remove());
  return stripHtml(clone.innerHTML).length > 0;
}

/** Renders an email's HTML body inside a sandboxed, script-free iframe —
 * the standard safe way a webmail client shows arbitrary third-party HTML
 * without risking XSS: `sandbox="allow-same-origin"` (no `allow-scripts`)
 * means nothing inside can ever execute JS, while still letting this
 * component read `contentDocument.body.scrollHeight` on load to auto-size
 * the frame instead of showing a fixed-height double-scrollbar box. Falls
 * back to a plain pre-wrapped text block when there's no HTML body at all
 * (a lot of real messages, especially auto-replies, are text-only). */
function EmailBody({ html, text }: { html?: string; text?: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);

  if (!html) {
    return <div className="instantly-bubble-body">{text || '(tuščias laiškas)'}</div>;
  }

  return (
    <iframe
      ref={ref}
      className="instantly-bubble-iframe"
      sandbox="allow-same-origin"
      srcDoc={html}
      style={{ height }}
      title="Laiško turinys"
      onLoad={() => {
        const doc = ref.current?.contentDocument;
        if (doc?.body) setHeight(Math.min(doc.body.scrollHeight + 16, 2000));
      }}
    />
  );
}

interface ComposePanelProps {
  mode: 'reply' | 'forward';
  thread: UniboxThread;
  accounts: string[];
  onClose: () => void;
}

/** Modeled directly on a screenshot of Instantly's own real Reply/Forward
 * compose box, on explicit request ("один в один"). Rich text is a plain
 * `contentEditable` div + `document.execCommand`, not a library — matches
 * this codebase's own "no heavy UI dependencies" convention (the Calls/
 * LinkedIn stats charts are hand-rolled SVG for the identical reason).
 * `execCommand` is formally deprecated but still universally supported;
 * pulling in a real rich-text-editor package for four formatting buttons
 * would be a disproportionate dependency for what this needs. */
function ComposePanel({ mode, thread, accounts, onClose }: ComposePanelProps) {
  const latest = thread.latest;
  const recipient = isOutgoing(latest) ? party(latest, 'to') : party(latest, 'from');
  const sendReply = useInstantlyInboxStore((s) => s.sendReply);
  const sendForward = useInstantlyInboxStore((s) => s.sendForward);
  const sendingReply = useInstantlyInboxStore((s) => s.sendingReply);
  const sendingForward = useInstantlyInboxStore((s) => s.sendingForward);
  const showToast = useToastStore((s) => s.show);

  // Reply's primary recipient is implicit in the API (always whoever sent
  // the original message) — shown here for clarity but not removable.
  // Forward has no implicit recipient at all, so its list starts empty
  // and every chip is real/removable.
  const [extraTo, setExtraTo] = useState<string[]>([]);
  const [toInput, setToInput] = useState('');
  const [from, setFrom] = useState(latest.eaccount);
  const [subject, setSubject] = useState(
    mode === 'reply'
      ? latest.subject?.startsWith('Re:')
        ? latest.subject
        : `Re: ${latest.subject ?? ''}`
      : latest.subject?.startsWith('Fwd:')
        ? latest.subject
        : `Fwd: ${latest.subject ?? ''}`,
  );
  const bodyRef = useRef<HTMLDivElement>(null);

  // Seeds the compose body with an empty line to type into, followed by
  // the quoted original message — set imperatively (not via React state)
  // since this is otherwise a plain uncontrolled contentEditable region;
  // this only ever needs to run once, when the panel first mounts. The
  // cursor is placed in that empty first line so typing works
  // immediately without needing to click past the quote first.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.innerHTML = `<div><br></div>${buildQuoteHtml(mode, thread)}`;
    const firstLine = el.firstChild;
    if (firstLine) {
      const range = document.createRange();
      range.setStart(firstLine, 0);
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    el.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addToChip = () => {
    const v = toInput.trim();
    if (v && v.includes('@') && !extraTo.includes(v)) setExtraTo((prev) => [...prev, v]);
    setToInput('');
  };
  const removeToChip = (v: string) => setExtraTo((prev) => prev.filter((x) => x !== v));

  const exec = (cmd: string, value?: string) => {
    bodyRef.current?.focus();
    document.execCommand(cmd, false, value);
  };

  const handleSend = async () => {
    if (!bodyRef.current || !hasUserContent(bodyRef.current)) return;
    const html = bodyRef.current.innerHTML;
    if (mode === 'forward' && extraTo.length === 0) return;
    // Sends immediately on click, no confirmDialog step — on explicit
    // request, a deliberate departure from this app's own usual "confirm
    // before any real, hard-to-undo send" convention (click-to-call, SMS,
    // LinkedIn messages all still confirm) — the user found the extra
    // click friction rather than reassurance for this specific action.
    const ok =
      mode === 'reply'
        ? await sendReply({ replyToUuid: latest.id, eaccount: from, subject, html, additionalRecipients: extraTo })
        : await sendForward({ replyToUuid: latest.id, eaccount: from, to: extraTo, subject, html });
    if (ok) {
      showToast(mode === 'reply' ? 'Atsakymas išsiųstas' : 'Laiškas persiųstas');
      onClose();
    }
  };

  const sending = mode === 'reply' ? sendingReply : sendingForward;

  return (
    // position: sticky (CSS), not a computed scroll — a real, reported
    // bug: this panel renders *below* the existing message bubbles, and
    // two different scroll-to-reveal-it approaches (scrollIntoView, then
    // a direct scrollTo(scrollHeight)) both turned out fragile in
    // practice, sensitive to exactly how tall the message history above
    // happens to be and to the async iframe email bodies resizing
    // themselves after load (EmailBody's own onLoad handler, which can
    // grow the page *after* a one-time scroll already fired, leaving the
    // final position wrong). Pinning the whole compose card to the
    // bottom of .instantly-unibox-detail-pane's own scroll viewport
    // sidesteps the entire class of bug: it's simply always fully
    // visible, however far up the message history you've scrolled,
    // without calculating anything.
    <div className="instantly-compose">
      <div className="instantly-compose-header">
        <h3>{mode === 'reply' ? 'Atsakyti' : 'Persiųsti'}</h3>
        <button type="button" className="instantly-compose-close" onClick={onClose}>
          <X className="icon" size={16} />
        </button>
      </div>

      <div className="instantly-compose-field">
        <span>To</span>
        <div className="instantly-compose-to">
          {mode === 'reply' && recipient && (
            <span className="instantly-compose-chip instantly-compose-chip-fixed" title="Pagrindinis gavėjas — jo negalima pašalinti">
              {recipient.address}
            </span>
          )}
          {extraTo.map((v) => (
            <span className="instantly-compose-chip" key={v}>
              {v}
              <button type="button" onClick={() => removeToChip(v)}>
                <X className="icon" size={12} />
              </button>
            </span>
          ))}
          <input
            type="email"
            placeholder="Enter email address"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addToChip();
              }
            }}
            onBlur={addToChip}
          />
        </div>
      </div>

      <div className="instantly-compose-field">
        <span>From</span>
        <select value={from} onChange={(e) => setFrom(e.target.value)}>
          {(accounts.includes(latest.eaccount) ? accounts : [latest.eaccount, ...accounts]).map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      <div className="instantly-compose-field">
        <span>Subject</span>
        <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </div>

      <div
        ref={bodyRef}
        className="instantly-compose-body"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Start typing here…"
      />

      <div className="instantly-compose-toolbar">
        <button type="button" onClick={() => exec('bold')} title="Paryškinti">
          <b>B</b>
        </button>
        <button type="button" onClick={() => exec('italic')} title="Kursyvas">
          <i>i</i>
        </button>
        <button type="button" onClick={() => exec('underline')} title="Pabraukti">
          <u>U</u>
        </button>
        <button
          type="button"
          onClick={() => {
            const url = window.prompt('Nuoroda (URL):');
            if (url) exec('createLink', url);
          }}
          title="Nuoroda"
        >
          <Link className="icon" size={14} />
        </button>
        <button type="button" onClick={() => exec('removeFormat')} title="Išvalyti formatavimą">
          Tx
        </button>
        <div className="instantly-compose-toolbar-spacer" />
        <button type="button" className="primary" disabled={sending} onClick={() => void handleSend()}>
          {sending ? 'Siunčiama…' : 'Siųsti'}
        </button>
      </div>
    </div>
  );
}

export function UniboxPanel() {
  const threads = useInstantlyInboxStore((s) => s.threads);
  const ready = useInstantlyInboxStore((s) => s.ready);
  const error = useInstantlyInboxStore((s) => s.error);
  const nextCursor = useInstantlyInboxStore((s) => s.nextCursor);
  const loadMoreLoading = useInstantlyInboxStore((s) => s.loadMoreLoading);
  const refresh = useInstantlyInboxStore((s) => s.refresh);
  const loadMore = useInstantlyInboxStore((s) => s.loadMore);
  const viewMode = useInstantlyInboxStore((s) => s.viewMode);
  const setViewMode = useInstantlyInboxStore((s) => s.setViewMode);
  const filterMailbox = useInstantlyInboxStore((s) => s.filterMailbox);
  const setFilterMailbox = useInstantlyInboxStore((s) => s.setFilterMailbox);
  const filterCampaignId = useInstantlyInboxStore((s) => s.filterCampaignId);
  const setFilterCampaignId = useInstantlyInboxStore((s) => s.setFilterCampaignId);
  const openThreadId = useInstantlyInboxStore((s) => s.openThreadId);
  const setOpenThreadId = useInstantlyInboxStore((s) => s.setOpenThreadId);
  const markingThreadIds = useInstantlyInboxStore((s) => s.markingThreadIds);
  const markThreadRead = useInstantlyInboxStore((s) => s.markThreadRead);
  const markThreadUnread = useInstantlyInboxStore((s) => s.markThreadUnread);
  const unreadCount = useInstantlyInboxStore((s) => s.unreadCount);
  const replyError = useInstantlyInboxStore((s) => s.replyError);
  const forwardError = useInstantlyInboxStore((s) => s.forwardError);
  const updatingStatusThreadIds = useInstantlyInboxStore((s) => s.updatingStatusThreadIds);
  const updateThreadInterestStatus = useInstantlyInboxStore((s) => s.updateThreadInterestStatus);
  const showToast = useToastStore((s) => s.show);

  const accounts = useInstantlyAccountsStore((s) => s.accounts);
  const refreshAccounts = useInstantlyAccountsStore((s) => s.refresh);

  const campaigns = useInstantlyCampaignsStore((s) => s.campaigns);
  const refreshCampaigns = useInstantlyCampaignsStore((s) => s.refresh);

  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<'primary' | 'others'>('primary');
  const [statusFilter, setStatusFilter] = useState<number | null | 'all'>('all');
  const [showMoreStatuses, setShowMoreStatuses] = useState(false);
  const [composeMode, setComposeMode] = useState<'reply' | 'forward' | null>(null);
  const [campaignsOpen, setCampaignsOpen] = useState(false);
  const [campaignSearch, setCampaignSearch] = useState('');
  const [syncingReplies, setSyncingReplies] = useState(false);
  // "Eksportuoti visas kampanijas" — a single-button alternative to the
  // per-campaign flow above, see syncAllInstantlyCampaignsRepliesToTable's
  // own doc comment for why. null while idle; set to the live progress
  // while a full run is in flight, so the button can show "Kampanija 3
  // iš 12: Q3 Outreach…" instead of a bare spinner that's easy to mistake
  // for a hang on a run that can legitimately take many minutes.
  const [allCampaignsProgress, setAllCampaignsProgress] = useState<AllCampaignsSyncProgress | null>(null);
  const [syncingAllCampaigns, setSyncingAllCampaigns] = useState(false);
  // Two INDEPENDENT collapse toggles — not one combined listVisible flag
  // like an earlier version of this had. That version auto-collapsed the
  // whole filters+list column the instant a thread opened, on the
  // reasoning that a phone-width screen can't show 3 columns side by side
  // at once ("Unibox в телефоне не оптимизирован") — but the automatic
  // part of that was explicitly rejected on a direct follow-up ("я не
  // хочу чтобы она автоматически сворачивалась... это буду делать я
  // сам" — collapsing should be something the user does themselves, never
  // automatic). The *reason* for making the two blocks collapsible at all
  // still stands, though — on a narrow screen, the Statusas filter block
  // and the thread-list block stacked vertically ate all the space before
  // any actual email content was visible ("я вообще не вижу содержимого
  // клиентов"), and neither block on its own was collapsible, only the
  // whole column together. The fix is these two separate toggles (each
  // block gets its own small header with a caret — see the sidebar/main
  // render below), collapsible one at a time, independently, on both
  // mobile and desktop equally ("это тоже должно быть и в компьютере") —
  // never triggered by anything other than the user clicking that block's
  // own header.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [threadListCollapsed, setThreadListCollapsed] = useState(false);

  useEffect(() => {
    void refresh();
    void refreshAccounts();
    void refreshCampaigns();
    // Only on mount — filter changes trigger their own refresh() from the
    // store's setViewMode/setFilterMailbox/setFilterCampaignId actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (error) showToast(error);
  }, [error, showToast]);
  useEffect(() => {
    if (replyError) showToast(replyError);
  }, [replyError, showToast]);
  useEffect(() => {
    if (forwardError) showToast(forwardError);
  }, [forwardError, showToast]);

  useEffect(() => {
    setComposeMode(null);
  }, [openThreadId]);

  // Primary/Others (is_focused) and the status sidebar both filter over
  // what's already loaded, same "plain client-side filter" reasoning as
  // search below — Instantly's own GET /emails has no is_focused query
  // param to push this server-side.
  const tabFiltered = useMemo(
    () => threads.filter((t) => (tab === 'primary' ? t.latest.is_focused !== 0 : t.latest.is_focused === 0)),
    [threads, tab],
  );
  const statusFiltered = useMemo(
    () => (statusFilter === 'all' ? tabFiltered : tabFiltered.filter((t) => (t.latest.i_status ?? null) === statusFilter)),
    [tabFiltered, statusFilter],
  );
  // "Sent" and "Reminders only" (the "More" menu) are re-checked
  // client-side on top of whatever the server-side has_reminder/
  // scheduled_only params did — confirmed live those two silently no-op
  // server-side rather than actually filtering, so this is what actually
  // makes them correct rather than just cosmetic. "Sent" has no server
  // param at all; isOutgoing() (already used for bubble direction) is
  // the same reliable signal reused here.
  const viewModeFiltered = useMemo(() => {
    if (viewMode === 'sent') return statusFiltered.filter((t) => isOutgoing(t.latest));
    if (viewMode === 'reminders') return statusFiltered.filter((t) => t.messages.some((m) => m.reminder_ts));
    return statusFiltered;
  }, [statusFiltered, viewMode]);
  const filteredThreads = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return viewModeFiltered;
    return viewModeFiltered.filter((t) => {
      const other = otherParty(t);
      return (
        other?.name.toLowerCase().includes(q) ||
        other?.address.toLowerCase().includes(q) ||
        t.latest.subject?.toLowerCase().includes(q) ||
        t.latest.content_preview?.toLowerCase().includes(q)
      );
    });
  }, [viewModeFiltered, search]);

  const openThread = threads.find((t) => t.threadId === openThreadId);

  // The sidebar's "Lead" row is the reset/all-inclusive bucket — it does
  // NOT mean "only leads with no status set", it means "every status,
  // full stop" (on explicit clarification: "Lead статус берёт в себя все
  // статусы"). Every other row narrows to its own exact i_status value.
  //
  // No per-row count badge (removed on explicit follow-up request — "они
  // збивают с толку", the numbers were confusing rather than useful).
  const renderStatusRow = (status: number | null) => {
    const isLeadRow = status === null;
    const key = statusKey(status);
    const active = isLeadRow ? statusFilter === 'all' : statusFilter === status;
    return (
      <button
        type="button"
        key={key}
        className={`instantly-status-row ${active ? 'active' : ''}`}
        onClick={() => setStatusFilter(isLeadRow ? 'all' : active ? 'all' : status)}
      >
        <span className="instantly-status-dot" style={{ background: INTEREST_STATUS_COLORS[key] }} />
        {INTEREST_STATUS_LABELS[key]}
      </button>
    );
  };

  const accountEmails = accounts.map((a) => a.email);
  // Most recently active first (timestamp_updated, not timestamp_created)
  // — on explicit request ("от самых актуальных до самых неактуальных").
  // updated, not created, is the better proxy for "actual/relevant": an
  // old campaign that's still getting replies today has a recent
  // timestamp_updated even though it was created long ago, while a
  // campaign nobody's touched in months sinks toward the bottom
  // regardless of when it was first set up.
  const filteredCampaigns = campaigns
    .filter((c) => c.name.toLowerCase().includes(campaignSearch.trim().toLowerCase()))
    .slice()
    .sort((a, b) => b.timestamp_updated.localeCompare(a.timestamp_updated));
  const activeCampaign = campaigns.find((c) => c.id === filterCampaignId);

  return (
    <div className="instantly-panel instantly-unibox-layout">
      {/* Sidebar and thread-list are two INDEPENDENT collapsible blocks
       * (sidebarCollapsed/threadListCollapsed — see their own doc comment
       * above), each with its own header/caret below, rather than one
       * combined toggle — on explicit request. Still grouped in one
       * wrapping div purely for the row-layout CSS (.instantly-unibox-
       * list-col), not for any shared show/hide behavior. */}
      <div className="instantly-unibox-list-col">
      <aside className={`instantly-unibox-sidebar ${sidebarCollapsed ? 'instantly-unibox-block-collapsed' : ''}`}>
        <button
          type="button"
          className="instantly-unibox-block-header"
          onClick={() => setSidebarCollapsed((v) => !v)}
        >
          <span className={`instantly-expand-caret ${!sidebarCollapsed ? 'instantly-expand-caret-open' : ''}`}><ChevronRight className="icon" size={14} /></span>
          <span className="instantly-unibox-block-header-label">Filtrai</span>
        </button>
        {!sidebarCollapsed && (
          <>
            <div className="instantly-unibox-sidebar-title">Statusas</div>
            <div className="instantly-status-list">
              {PRIMARY_INTEREST_STATUSES.map(renderStatusRow)}
              <button type="button" className="instantly-status-row instantly-status-more" onClick={() => setShowMoreStatuses((v) => !v)}>
                ⋯ {showMoreStatuses ? 'Mažiau' : 'Daugiau'}
              </button>
              {showMoreStatuses && MORE_INTEREST_STATUSES.map(renderStatusRow)}
            </div>

            {/* Second filter section, always expanded — on explicit
             * request ("сделаем проще"): this used to be a collapsed-by-
             * default toggle way down after Kampanijos/Pašto dėžutė, but
             * view mode (especially "Tik neperskaityti") is used often
             * enough that hiding it behind both a scroll and a click was
             * more friction than it was worth. No moreOpen state anymore —
             * every row just renders directly. */}
            <div className="instantly-unibox-sidebar-title">Daugiau</div>
            <div className="instantly-status-list">
              {(Object.keys(VIEW_MODE_LABELS) as UniboxViewMode[]).map((mode) => {
                const ModeIcon = VIEW_MODE_ICONS[mode];
                return (
                  <button
                    type="button"
                    key={mode}
                    className={`instantly-status-row ${viewMode === mode ? 'active' : ''}`}
                    onClick={() => setViewMode(mode)}
                  >
                    <ModeIcon className="icon" size={16} /> {VIEW_MODE_LABELS[mode]}
                    {mode === 'unread' && unreadCount > 0 && <span className="instantly-status-count">{unreadCount}</span>}
                  </button>
                );
              })}
            </div>

            <div className="instantly-unibox-sidebar-title">Kampanijos</div>
            <div className="instantly-status-list">
              <button
                type="button"
                className={`instantly-status-row ${!filterCampaignId ? 'active' : ''}`}
                onClick={() => setCampaignsOpen((v) => !v)}
              >
                <span className={`instantly-expand-caret ${campaignsOpen ? 'instantly-expand-caret-open' : ''}`}><ChevronRight className="icon" size={14} /></span>
                {activeCampaign ? activeCampaign.name : 'Visos kampanijos'}
              </button>
              {campaignsOpen && (
                <div className="instantly-campaign-expand">
                  <input
                    type="search"
                    placeholder="Ieškoti kampanijos…"
                    value={campaignSearch}
                    onChange={(e) => setCampaignSearch(e.target.value)}
                  />
                  {filterCampaignId && (
                    <button
                      type="button"
                      className="instantly-status-row"
                      onClick={() => {
                        setFilterCampaignId(null);
                        setCampaignsOpen(false);
                      }}
                    >
                      <X className="icon" size={14} /> Išvalyti filtrą
                    </button>
                  )}
                  {filteredCampaigns.map((c) => (
                    <button
                      type="button"
                      key={c.id}
                      className={`instantly-status-row ${filterCampaignId === c.id ? 'active' : ''}`}
                      onClick={() => {
                        setFilterCampaignId(filterCampaignId === c.id ? null : c.id);
                        setCampaignsOpen(false);
                      }}
                    >
                      {c.name}
                    </button>
                  ))}
                  {filteredCampaigns.length === 0 && <p className="instantly-hint">Kampanijų nerasta.</p>}
                </div>
              )}
              {/* Pulls every reply (not our own sends) for the filtered
               * campaign into a plain CRM table — on explicit request. One
               * campaign at a time (matches the filter above), manually
               * triggered; see instantlyReplySync.ts's own doc comment for
               * why this isn't a background job yet. Re-running it is
               * safe — already-pulled replies are skipped, not
               * duplicated. */}
              {filterCampaignId && (
                <button
                  type="button"
                  className="instantly-status-row"
                  disabled={syncingReplies}
                  onClick={async () => {
                    setSyncingReplies(true);
                    try {
                      const result = await syncInstantlyRepliesToTable(filterCampaignId, VISI_ATSAKYMAI_TABLE_NAME);
                      showToast(
                        `„${result.tableName}": pridėta ${result.created} atsakymų (rasta ${result.repliesFound}, praleista pasikartojančių: ${result.skippedDuplicate})`,
                      );
                    } catch (err) {
                      showToast(err instanceof Error ? err.message : 'Nepavyko sinchronizuoti atsakymų');
                    } finally {
                      setSyncingReplies(false);
                    }
                  }}
                >
                  {syncingReplies ? 'Sinchronizuojama…' : <><Download className="icon" size={16} /> Eksportuoti atsakymus į lentelę</>}
                </button>
              )}
              {/* "Eksportuoti VISAS kampanijas" — doesn't need a campaign
               * selected first, on explicit request: picking one campaign
               * before this button even renders (above) was a real,
               * reported point of confusion (a page reload silently clears
               * that selection, so the button just disappears). Runs every
               * campaign one after another — see
               * syncAllInstantlyCampaignsRepliesToTable's own doc comment
               * for why this can legitimately take a long time and why
               * that's shown as live progress, not a bare spinner. */}
              <button
                type="button"
                className="instantly-status-row"
                disabled={syncingReplies || syncingAllCampaigns}
                onClick={async () => {
                  setSyncingAllCampaigns(true);
                  setAllCampaignsProgress(null);
                  try {
                    const result = await syncAllInstantlyCampaignsRepliesToTable(VISI_ATSAKYMAI_TABLE_NAME, setAllCampaignsProgress);
                    const failureNote =
                      result.campaignsFailed > 0 ? `, nepavyko: ${result.campaignsFailed} kampanij(ų)` : '';
                    showToast(
                      `„${result.tableName}": apdorota ${result.campaignsProcessed} kampanijų, pridėta ${result.totalCreated} atsakymų ` +
                        `(rasta ${result.totalFound}, praleista pasikartojančių: ${result.totalSkippedDuplicate}${failureNote})`,
                    );
                  } catch (err) {
                    showToast(err instanceof Error ? err.message : 'Nepavyko sinchronizuoti visų kampanijų');
                  } finally {
                    setSyncingAllCampaigns(false);
                    setAllCampaignsProgress(null);
                  }
                }}
              >
                {syncingAllCampaigns ? (
                  allCampaignsProgress
                    ? `Kampanija ${allCampaignsProgress.campaignIndex} iš ${allCampaignsProgress.campaignCount}: ${allCampaignsProgress.campaignName}…`
                    : 'Kraunamas kampanijų sąrašas…'
                ) : (
                  <>
                    <Download className="icon" size={16} /> Eksportuoti VISAS kampanijas
                  </>
                )}
              </button>
            </div>

            <div className="instantly-unibox-sidebar-title">Pašto dėžutė</div>
            <select value={filterMailbox ?? ''} onChange={(e) => setFilterMailbox(e.target.value || null)}>
              <option value="">Visos</option>
              {accountEmails.map((email) => (
                <option key={email} value={email}>
                  {email}
                </option>
              ))}
            </select>
          </>
        )}
      </aside>

      <div className={`instantly-unibox-main ${threadListCollapsed ? 'instantly-unibox-block-collapsed' : ''}`}>
        <button
          type="button"
          className="instantly-unibox-block-header"
          onClick={() => setThreadListCollapsed((v) => !v)}
        >
          <span className={`instantly-expand-caret ${!threadListCollapsed ? 'instantly-expand-caret-open' : ''}`}><ChevronRight className="icon" size={14} /></span>
          <span className="instantly-unibox-block-header-label">Pokalbiai</span>
        </button>
        {!threadListCollapsed && (
          <>
        <div className="instantly-unibox-tabs">
          <button type="button" className={tab === 'primary' ? 'active' : ''} onClick={() => setTab('primary')}>
            Primary
          </button>
          <button type="button" className={tab === 'others' ? 'active' : ''} onClick={() => setTab('others')}>
            Others
          </button>
        </div>

        <div className="instantly-toolbar">
          <input
            type="search"
            placeholder="Ieškoti pagal vardą, el. paštą, temą…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {ready && filteredThreads.length === 0 && <p className="instantly-hint">Pokalbių nerasta.</p>}

        <div className="instantly-list">
          {filteredThreads.map((thread) => {
            const other = otherParty(thread);
            const needsReply = !isOutgoing(thread.latest);
            const statusColor = INTEREST_STATUS_COLORS[statusKey(thread.latest.i_status)];
            return (
              <button
                type="button"
                key={thread.threadId}
                className={`instantly-thread-row ${thread.hasUnread ? 'instantly-thread-unread' : ''} ${thread.threadId === openThreadId ? 'instantly-thread-row-active' : ''}`}
                onClick={() => {
                  setOpenThreadId(thread.threadId);
                  if (thread.hasUnread && !markingThreadIds.has(thread.threadId)) void markThreadRead(thread.threadId);
                }}
              >
                <span className="instantly-thread-status-dot" style={{ background: statusColor }} />
                <div className="instantly-thread-main">
                  <div className="instantly-thread-top-row">
                    <span className="instantly-thread-name-row">
                      {thread.hasUnread && <span className="instantly-thread-unread-dot" title="Neperskaityta" />}
                      <span className="instantly-thread-subject">{other?.name ?? '—'}</span>
                    </span>
                    <span className="instantly-thread-meta">{formatTimestamp(thread.latest.timestamp_email)}</span>
                  </div>
                  {thread.latest.subject && <span className="instantly-thread-subject-line">{thread.latest.subject}</span>}
                  {needsReply && thread.hasUnread && (
                    <span className="instantly-thread-needs-reply">Gauta prieš {daysAgo(thread.latest.timestamp_email)} d. Atsakyti?</span>
                  )}
                  <span className="instantly-thread-preview">
                    {isOutgoing(thread.latest) ? 'Jūs: ' : ''}
                    {thread.latest.content_preview || ''}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {nextCursor && (
          <button type="button" className="instantly-load-more" disabled={loadMoreLoading} onClick={() => void loadMore()}>
            {loadMoreLoading ? 'Kraunama…' : 'Rodyti daugiau'}
          </button>
        )}
          </>
        )}
      </div>
      </div>

      {openThread &&
        (() => {
          const latest = openThread.latest;
          const recipient = isOutgoing(latest) ? party(latest, 'to') : party(latest, 'from');
          const leadEmail = recipient?.address ?? latest.lead ?? '';
          const statusVal = latest.i_status ?? null;
          return (
            <div className="instantly-unibox-detail-pane">
              <div className="instantly-thread-detail-header">
                <div className="instantly-thread-avatar">{initials(recipient?.name ?? '?')}</div>
                <div className="instantly-thread-header-info">
                  <span className="instantly-row-title">{recipient?.name ?? '—'}</span>
                  <span className="instantly-row-subtitle">{recipient?.address}</span>
                </div>
                <select
                  className="instantly-status-select"
                  style={{ borderColor: INTEREST_STATUS_COLORS[statusKey(statusVal)], color: INTEREST_STATUS_COLORS[statusKey(statusVal)] }}
                  disabled={!leadEmail || updatingStatusThreadIds.has(openThread.threadId)}
                  value={statusKey(statusVal)}
                  onChange={(e) => {
                    const raw = e.target.value;
                    void updateThreadInterestStatus(openThread, leadEmail, raw === 'null' ? null : Number(raw));
                  }}
                >
                  {[...PRIMARY_INTEREST_STATUSES, ...MORE_INTEREST_STATUSES].map((s) => (
                    <option key={statusKey(s)} value={statusKey(s)}>
                      {INTEREST_STATUS_LABELS[statusKey(s)]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="instantly-detail-mark-unread"
                  title="Pažymėti kaip neperskaitytą — grįžkite prie jo vėliau"
                  disabled={markingThreadIds.has(openThread.threadId)}
                  onClick={() => void markThreadUnread(openThread.threadId)}
                >
                  <Mail className="icon" size={16} /> Neperskaityta
                </button>
                <button type="button" className="instantly-detail-close" onClick={() => setOpenThreadId(null)}>
                  <X className="icon" size={16} />
                </button>
              </div>
              <p className="instantly-thread-subject-heading">{latest.subject || '(be temos)'}</p>
              <div className="instantly-thread-detail">
                {openThread.messages.map((m) => {
                  const outgoing = isOutgoing(m);
                  const sender = party(m, 'from');
                  return (
                    <div className={`instantly-bubble-row ${outgoing ? 'instantly-bubble-row-out' : 'instantly-bubble-row-in'}`} key={m.id}>
                      <div className={`instantly-bubble ${outgoing ? 'instantly-bubble-out' : 'instantly-bubble-in'}`}>
                        <div className="instantly-bubble-header">
                          <span>{outgoing ? `Jūs (${m.eaccount})` : sender?.name}</span>
                          <span>{formatTimestamp(m.timestamp_email)}</span>
                        </div>
                        <EmailBody html={m.body?.html} text={m.body?.text || m.content_preview || undefined} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {composeMode ? (
                <ComposePanel mode={composeMode} thread={openThread} accounts={accountEmails} onClose={() => setComposeMode(null)} />
              ) : (
                <div className="instantly-compose-trigger-row">
                  <button type="button" onClick={() => setComposeMode('forward')}>
                    <CornerUpRight className="icon" size={16} /> Persiųsti
                  </button>
                  <button type="button" className="primary" onClick={() => setComposeMode('reply')}>
                    <CornerUpLeft className="icon" size={16} /> Atsakyti
                  </button>
                </div>
              )}
            </div>
          );
        })()}
    </div>
  );
}
