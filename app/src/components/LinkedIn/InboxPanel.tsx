import { useEffect, useState } from 'react';
import { useLinkedInInboxStore } from '../../store/useLinkedInInboxStore';
import { confirmDialog } from '../../store/useConfirmStore';
import { useToastStore } from '../../store/useToastStore';

/** Conversation list + one open thread + reply — reads serve from the
 * local DB (already synced by inbox.ts's background job, every 10 min),
 * "↻ Sinchronizuoti" triggers a fresh live scrape on demand. "🤖 Pasiūlyti
 * atsakymą" (Phase 2) drafts a suggested reply from the visible thread
 * into the textarea below — never sends anything on its own, same "AI
 * drafts, human reviews" rule every other AI feature in this app follows. */
export function InboxPanel() {
  const conversations = useLinkedInInboxStore((s) => s.conversations);
  const conversationsReady = useLinkedInInboxStore((s) => s.conversationsReady);
  const refreshConversations = useLinkedInInboxStore((s) => s.refreshConversations);
  const openConversationId = useLinkedInInboxStore((s) => s.openConversationId);
  const setOpenConversationId = useLinkedInInboxStore((s) => s.setOpenConversationId);
  const messages = useLinkedInInboxStore((s) => s.messages);
  const messagesReady = useLinkedInInboxStore((s) => s.messagesReady);
  const sending = useLinkedInInboxStore((s) => s.sending);
  const sendError = useLinkedInInboxStore((s) => s.sendError);
  const sendReply = useLinkedInInboxStore((s) => s.sendReply);
  const syncing = useLinkedInInboxStore((s) => s.syncing);
  const syncNow = useLinkedInInboxStore((s) => s.syncNow);
  const suggesting = useLinkedInInboxStore((s) => s.suggesting);
  const suggestReplyText = useLinkedInInboxStore((s) => s.suggestReplyText);
  const showToast = useToastStore((s) => s.show);

  const [draft, setDraft] = useState('');

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  // A reply draft is per-conversation in spirit (you wouldn't want half a
  // message meant for Jonas landing in Petras' box just because you
  // switched threads before sending) — draft itself is plain component
  // state, not conversation-scoped, so this clears it explicitly on every
  // conversation switch.
  useEffect(() => {
    setDraft('');
  }, [openConversationId]);

  useEffect(() => {
    if (sendError) showToast(sendError);
  }, [sendError, showToast]);

  const openConversation = conversations.find((c) => c.id === openConversationId);

  const handleSend = async () => {
    if (!openConversationId || !draft.trim()) return;
    const ok = await confirmDialog({
      message: `Siųsti tikrą žinutę į LinkedIn?\n\n"${draft.trim()}"\n\nŠio veiksmo atšaukti negalima.`,
      danger: true,
      confirmLabel: 'Siųsti',
    });
    if (!ok) return;
    const success = await sendReply(openConversationId, draft.trim());
    if (success) {
      showToast('Žinutė išsiųsta');
      setDraft('');
    }
  };

  const handleSuggest = async () => {
    const conversationId = openConversationId;
    if (!conversationId) return;
    const text = await suggestReplyText(conversationId);
    // The user may have switched to a *different* conversation while this
    // was in flight (a real, reproduced race: click "suggest" on A, click
    // conversation B before A's suggestion comes back — draft is plain
    // component state, not scoped per-conversation, so an unguarded
    // setDraft(text) here would land A's suggestion in B's reply box).
    // Re-checking the store's *current* openConversationId right before
    // applying the result is the same guard this app already uses for the
    // Apollo phone-reveal poll's identical "resolves after the user moved
    // on" shape.
    if (useLinkedInInboxStore.getState().openConversationId !== conversationId) return;
    if (text) setDraft(text);
    else showToast(useLinkedInInboxStore.getState().suggestError ?? 'Nepavyko sugeneruoti pasiūlymo');
  };

  return (
    <div className="linkedin-inbox">
      <div className="linkedin-inbox-toolbar">
        <span className="linkedin-hint">{conversations.length} pokalbių</span>
        <button type="button" onClick={() => void syncNow()} disabled={syncing}>
          {syncing ? 'Sinchronizuojama…' : '↻ Sinchronizuoti dabar'}
        </button>
      </div>

      <div className="linkedin-inbox-layout">
        <div className="linkedin-inbox-list">
          {conversationsReady && conversations.length === 0 && (
            <p className="linkedin-hint">Kol kas nėra pokalbių — paspauskite "Sinchronizuoti dabar".</p>
          )}
          {conversations.map((c) => (
            <button
              type="button"
              key={c.id}
              className={`linkedin-inbox-row ${c.id === openConversationId ? 'active' : ''} ${c.unread ? 'unread' : ''}`}
              onClick={() => setOpenConversationId(c.id)}
            >
              <span className="linkedin-inbox-row-name">{c.participantName || c.participantUrl}</span>
              {c.lastMessagePreview && <span className="linkedin-hint">{c.lastMessagePreview}</span>}
              {c.unread && <span className="linkedin-inbox-unread-dot" />}
            </button>
          ))}
        </div>

        <div className="linkedin-inbox-thread">
          {!openConversation && <p className="linkedin-hint">Pasirinkite pokalbį kairėje.</p>}
          {openConversation && (
            <>
              <div className="linkedin-inbox-thread-header">
                <strong>{openConversation.participantName || openConversation.participantUrl}</strong>
                <a href={openConversation.participantUrl} target="_blank" rel="noopener noreferrer">
                  profilis ↗
                </a>
              </div>
              <div className="linkedin-inbox-messages">
                {messagesReady && messages.length === 0 && <p className="linkedin-hint">Kol kas nėra žinučių.</p>}
                {messages.map((m) => (
                  <div key={m.id} className={`linkedin-inbox-message linkedin-inbox-message-${m.direction}`}>
                    {m.content}
                  </div>
                ))}
              </div>
              <div className="linkedin-inbox-reply">
                <textarea
                  placeholder="Rašyti žinutę…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <div className="linkedin-inbox-reply-actions">
                  <button
                    type="button"
                    disabled={suggesting || messages.length === 0}
                    title="AI paruošia atsakymo juodraštį pagal pokalbio istoriją — peržiūrėkite ir pataisykite prieš siunčiant"
                    onClick={() => void handleSuggest()}
                  >
                    {suggesting ? 'Generuojama…' : '🤖 Pasiūlyti atsakymą'}
                  </button>
                  <button type="button" className="primary" disabled={sending || !draft.trim()} onClick={() => void handleSend()}>
                    {sending ? 'Siunčiama…' : '+ Siųsti'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
