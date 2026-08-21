import { useEffect, useState } from 'react';
import { useCallsStore } from '../../store/useCallsStore';
import { useToastStore } from '../../store/useToastStore';
import type { CallRecord } from '../../utils/callsApi';
import { getCallDispositionLabel } from '../../utils/callDispositionLabels';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Zadarma's PBX statistics endpoint (see CLAUDE.md's "otherParty" section)
// always hands back otherParty as a bare digit run, whether it came from
// `destination` (outbound) or was extracted out of `clid` (inbound) — the
// leading "+" never survives either path. Purely a display/copy concern:
// phoneMatchKey (used for CRM row/contact matching elsewhere) already
// compares last-7-digit suffixes, so it doesn't care either way.
function withLeadingPlus(phone: string): string {
  const trimmed = phone.trim();
  if (!trimmed || trimmed.startsWith('+') || !/^\d+$/.test(trimmed)) return trimmed;
  return `+${trimmed}`;
}

interface CallRowProps {
  call: CallRecord;
  matchedRow?: { rowId: string; label: string };
  /** A specific person (not just the row's own Phone column) whose
   * Contacts-entry number matched this call — see CallsView.tsx's
   * phoneToContact for how this is resolved. */
  matchedContact?: { rowId: string; columnId: string; contactId: string; label: string };
  onJumpToRow: (rowId: string) => void;
  onJumpToContact: (rowId: string, columnId: string, contactId: string) => void;
}

export function CallRow({ call, matchedRow, matchedContact, onJumpToRow, onJumpToContact }: CallRowProps) {
  const showToast = useToastStore((s) => s.show);
  const fetchRecording = useCallsStore((s) => s.fetchRecording);
  const recordingLink = useCallsStore((s) => s.recordingLinks[call.call_id]);
  const recordingError = useCallsStore((s) => s.recordingErrors[call.call_id]);

  const transcript = useCallsStore((s) => s.transcripts[call.call_id]);
  const transcribing = useCallsStore((s) => s.transcribingIds[call.call_id]);
  const transcribeError = useCallsStore((s) => s.transcribeErrors[call.call_id]);
  const transcribe = useCallsStore((s) => s.transcribe);
  const hydrateTranscription = useCallsStore((s) => s.hydrateTranscription);
  const summarizing = useCallsStore((s) => s.summarizingIds[call.call_id]);
  const summarizeError = useCallsStore((s) => s.summarizeErrors[call.call_id]);
  const summarize = useCallsStore((s) => s.summarize);
  // Expanded by default the moment a transcript exists (freshly finished,
  // or hydrated from the IndexedDB cache) — long calls make for a long
  // block of text per row, so once you've read it there needs to be a way
  // to collapse it back down without losing the "transcribed" state.
  const [showTranscript, setShowTranscript] = useState(true);

  useEffect(() => {
    void hydrateTranscription(call.call_id);
    // Only ever hydrate once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.call_id]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(`${label} nukopijuotas`);
    } catch {
      showToast('Nepavyko nukopijuoti — nėra prieigos prie iškarpinės');
    }
  };

  return (
    <>
      <tr>
        <td>{call.callstart}</td>
        <td>{call.clid}</td>
        <td>
          <div className="calls-destination">
            {withLeadingPlus(call.otherParty)}
            <button type="button" className="calls-copy-btn" title="Kopijuoti numerį" onClick={() => void copy(withLeadingPlus(call.otherParty), 'Numeris')}>
              📋 Kopijuoti
            </button>
            <button
              type="button"
              className="calls-copy-btn"
              title="Ieškoti šio numerio kontaktuose"
              onClick={() => {
                if (matchedContact) {
                  onJumpToContact(matchedContact.rowId, matchedContact.columnId, matchedContact.contactId);
                  showToast(`Rasta: ${matchedContact.label}`);
                } else if (matchedRow) {
                  onJumpToRow(matchedRow.rowId);
                  showToast(`Rasta įmonė: ${matchedRow.label} (konkretus kontaktas nerastas)`);
                } else {
                  showToast('Šis numeris nerastas jūsų kontaktuose');
                }
              }}
            >
              🔍 Ieškoti
            </button>
            {matchedRow && (
              <button
                type="button"
                className="calls-open-row-btn"
                title="Atverti šią įmonę lentelėje"
                onClick={() => onJumpToRow(matchedRow.rowId)}
              >
                🏢 {matchedRow.label} →
              </button>
            )}
          </div>
        </td>
        <td>{formatDuration(call.seconds)}</td>
        <td>{getCallDispositionLabel(call.disposition)}</td>
        <td>
          {!call.is_recorded ? (
            <span className="calls-error">Neįrašyta</span>
          ) : (
            <div className="calls-row-actions">
              <div className="calls-audio">
                <button type="button" onClick={() => void fetchRecording(call.call_id)}>
                  ▶ Įrašas
                </button>
                {recordingLink && (
                  <>
                    <audio controls src={recordingLink} />
                    <a href={recordingLink} target="_blank" rel="noreferrer">
                      Atverti įrašą ↗
                    </a>
                  </>
                )}
                {recordingError && <span className="calls-error">{recordingError}</span>}
              </div>
              <div className="calls-transcribe-group">
                {!transcript && !transcribing && (
                  <button type="button" className="calls-transcribe-btn" onClick={() => void transcribe(call.call_id)}>
                    📝 Transkribuoti
                  </button>
                )}
                {transcribing && (
                  <button type="button" className="calls-transcribe-btn pending" disabled>
                    Transkribuojama…
                  </button>
                )}
                {transcript && (
                  <button type="button" className="calls-transcribe-btn" onClick={() => setShowTranscript((v) => !v)}>
                    {showTranscript ? '🔼 Slėpti nuorašą' : '🔽 Rodyti nuorašą'}
                  </button>
                )}
                {transcribeError && (
                  <>
                    <span className="calls-error">{transcribeError}</span>
                    <button
                      type="button"
                      className="calls-transcribe-btn error"
                      onClick={() => void transcribe(call.call_id)}
                    >
                      Bandyti dar kartą
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </td>
      </tr>
      {transcript && showTranscript && (
        <tr className="calls-transcript-row">
          <td colSpan={6}>
            <div className="calls-transcript">
              {/* Summary sits above the raw transcript, not in a separate
                  collapsible section of its own — the user asked for "one
                  thing I can open/close" covering both, not two independent
                  toggles, so it rides along with showTranscript entirely. */}
              {transcript.summary && (
                <div className="calls-summary-block">
                  <div className="calls-summary-label-row">
                    <div className="calls-summary-label">🤖 Santrauka</div>
                    <button
                      type="button"
                      className="calls-copy-btn"
                      onClick={() => void copy(transcript.summary!, 'Santrauka')}
                    >
                      📋 Kopijuoti
                    </button>
                  </div>
                  {transcript.summary}
                </div>
              )}
              {transcript.text || <span className="calls-error">Kalba neatpažinta.</span>}
              <div className="calls-transcript-actions">
                {transcript.text && (
                  <button type="button" className="calls-copy-btn" onClick={() => void copy(transcript.text, 'Nuorašas')}>
                    📋 Kopijuoti nuorašą
                  </button>
                )}
                <button type="button" className="calls-transcribe-btn done" onClick={() => void transcribe(call.call_id)}>
                  🔄 Transkribuoti iš naujo
                </button>
                {transcript.text && !summarizing && (
                  <button type="button" className="calls-transcribe-btn done" onClick={() => void summarize(call.call_id)}>
                    {transcript.summary ? '🤖 Sukurti santrauką iš naujo' : '🤖 Santrauka'}
                  </button>
                )}
                {summarizing && (
                  <button type="button" className="calls-transcribe-btn pending" disabled>
                    Kuriama santrauka…
                  </button>
                )}
                {summarizeError && (
                  <span className="calls-error">{summarizeError}</span>
                )}
                <button type="button" className="calls-transcribe-btn" onClick={() => setShowTranscript(false)}>
                  🔼 Slėpti
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
