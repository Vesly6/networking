import { useEffect, useState } from 'react';
import { useCallsStore } from '../../store/useCallsStore';
import { useToastStore } from '../../store/useToastStore';
import type { CallRecord } from '../../utils/callsApi';

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface CallRowProps {
  call: CallRecord;
  matchedRow?: { rowId: string; label: string };
  onJumpToRow: (rowId: string) => void;
}

export function CallRow({ call, matchedRow, onJumpToRow }: CallRowProps) {
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
      showToast(`${label} copied`);
    } catch {
      showToast('Could not copy — clipboard access denied');
    }
  };

  return (
    <>
      <tr>
        <td>{call.callstart}</td>
        <td>{call.clid}</td>
        <td>
          <div className="calls-destination">
            {call.otherParty}
            <button type="button" className="calls-copy-btn" title="Copy number" onClick={() => void copy(call.otherParty, 'Number')}>
              📋 Copy
            </button>
            {matchedRow && (
              <button
                type="button"
                className="calls-open-row-btn"
                title="Open this company in the table"
                onClick={() => onJumpToRow(matchedRow.rowId)}
              >
                🏢 {matchedRow.label} →
              </button>
            )}
          </div>
        </td>
        <td>{formatDuration(call.seconds)}</td>
        <td>{call.disposition}</td>
        <td>
          {!call.is_recorded ? (
            <span className="calls-error">Not recorded</span>
          ) : (
            <div className="calls-row-actions">
              <div className="calls-audio">
                <button type="button" onClick={() => void fetchRecording(call.call_id)}>
                  ▶ Recording
                </button>
                {recordingLink && (
                  <>
                    <audio controls src={recordingLink} />
                    <a href={recordingLink} target="_blank" rel="noreferrer">
                      Open recording ↗
                    </a>
                  </>
                )}
                {recordingError && <span className="calls-error">{recordingError}</span>}
              </div>
              <div className="calls-transcribe-group">
                {!transcript && !transcribing && (
                  <button type="button" className="calls-transcribe-btn" onClick={() => void transcribe(call.call_id)}>
                    📝 Transcribe
                  </button>
                )}
                {transcribing && (
                  <button type="button" className="calls-transcribe-btn pending" disabled>
                    Transcribing…
                  </button>
                )}
                {transcript && (
                  <button type="button" className="calls-transcribe-btn" onClick={() => setShowTranscript((v) => !v)}>
                    {showTranscript ? '🔼 Hide transcript' : '🔽 Show transcript'}
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
                      Retry
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
                  <div className="calls-summary-label">🤖 Summary</div>
                  {transcript.summary}
                </div>
              )}
              {transcript.text || <span className="calls-error">No speech recognized.</span>}
              <div className="calls-transcript-actions">
                {transcript.text && (
                  <button type="button" className="calls-copy-btn" onClick={() => void copy(transcript.text, 'Transcript')}>
                    📋 Copy transcript
                  </button>
                )}
                <button type="button" className="calls-transcribe-btn done" onClick={() => void transcribe(call.call_id)}>
                  🔄 Re-transcribe
                </button>
                {transcript.text && !summarizing && (
                  <button type="button" className="calls-transcribe-btn done" onClick={() => void summarize(call.call_id)}>
                    {transcript.summary ? '🤖 Re-summarize' : '🤖 Summary'}
                  </button>
                )}
                {summarizing && (
                  <button type="button" className="calls-transcribe-btn pending" disabled>
                    Summarizing…
                  </button>
                )}
                {summarizeError && (
                  <span className="calls-error">{summarizeError}</span>
                )}
                <button type="button" className="calls-transcribe-btn" onClick={() => setShowTranscript(false)}>
                  🔼 Hide
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
