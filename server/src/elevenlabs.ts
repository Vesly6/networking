// Speech-to-text via ElevenLabs Scribe, not OpenAI whisper-1 — switched on
// explicit request after whisper-1's Lithuanian accuracy proved bad enough
// to produce real, embarrassing errors (a reported case: the model getting
// the speaker's own grammatical gender wrong). Published FLEURS-benchmark
// numbers back this up: whisper-1/Large-v3 sits around 30.5% WER for
// Lithuanian vs. Scribe's ~7.3% — not a marginal difference. Pricing is
// comparable too (Scribe: $0.22/hr ≈ $0.0037/min, actually cheaper than
// whisper-1's $0.006/min), so there's no cost tradeoff being made here.

export class TranscriptionError extends Error {}

const STT_MODEL = 'scribe_v2';

function getApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    throw new TranscriptionError('ELEVENLABS_API_KEY is not set — check server/.env');
  }
  return key;
}

// Same reasoning as the old OpenAI integration: the multipart upload needs a
// real filename/extension for the API to know how to decode it, and Zadarma
// always serves recordings as .ogg regardless of what (if anything) the
// recording URL's own path suggests.
const SUPPORTED_EXTENSIONS = ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'wav', 'webm'];

function extensionFromUrl(url: string): string {
  const match = /\.([a-zA-Z0-9]+)(?:[?#]|$)/.exec(new URL(url).pathname);
  const ext = match?.[1]?.toLowerCase();
  return ext && SUPPORTED_EXTENSIONS.includes(ext) ? ext : 'ogg';
}

/** The actual ElevenLabs call, shared by transcribeFromUrl (Zadarma
 * recordings — see below) and transcribeFromBuffer (voice notes) — the
 * two differ only in *how* the audio bytes are obtained (fetched from a
 * Zadarma URL vs. uploaded directly from the browser's own microphone
 * recording), not in how they're sent to ElevenLabs. */
async function callSpeechToText(audio: Blob, filename: string, language?: string): Promise<{ text: string }> {
  const form = new FormData();
  form.append('file', audio, filename);
  form.append('model_id', STT_MODEL);
  if (language) form.append('language_code', language);

  let res: Response;
  try {
    res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      // ElevenLabs' own header, NOT `Authorization: Bearer` — worth calling
      // out explicitly since every other integration in this file (Zadarma,
      // OpenAI) uses a different auth scheme, and it's an easy thing to get
      // wrong by pattern-matching the wrong neighbor.
      headers: { 'xi-api-key': getApiKey() },
      body: form,
    });
  } catch {
    throw new TranscriptionError('Could not reach ElevenLabs');
  }

  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) {
    const detail = json?.detail;
    const message = typeof detail === 'string' ? detail : detail?.message;
    throw new TranscriptionError(message ?? `ElevenLabs transcription failed (HTTP ${res.status})`);
  }
  return { text: json.text ?? '' };
}

/** Downloads the audio from a Zadarma temporary recording link and sends it
 * to ElevenLabs' speech-to-text endpoint. `language` is an ISO-639-1 hint
 * (e.g. 'lt' for Lithuanian) — optional, but skips auto-detection when the
 * language is already known. */
export async function transcribeFromUrl(recordingUrl: string, language?: string): Promise<{ text: string }> {
  let audioRes: Response;
  try {
    audioRes = await fetch(recordingUrl);
  } catch {
    throw new TranscriptionError('Could not download the recording from Zadarma');
  }
  if (!audioRes.ok) {
    throw new TranscriptionError(`Could not download the recording (HTTP ${audioRes.status})`);
  }
  const audioBlob = await audioRes.blob();
  const extension = extensionFromUrl(recordingUrl);
  return callSpeechToText(audioBlob, `call.${extension}`, language);
}

/** Transcribes a raw audio buffer uploaded directly from the browser — the
 * Notes tab's 🎤 voice-note button (CellHoverEditor.tsx), which records via
 * MediaRecorder client-side and posts the resulting bytes straight through,
 * with no Zadarma-style recording URL involved at all. `mimeType` (e.g.
 * "audio/webm") is what MediaRecorder itself reports, used only to pick a
 * matching file extension for the multipart upload — ElevenLabs, like the
 * old OpenAI integration this codebase already learned this lesson from,
 * infers audio format from the filename's extension, not Content-Type. */
export async function transcribeFromBuffer(buffer: Buffer, mimeType: string, language?: string): Promise<{ text: string }> {
  const extension = mimeType.split('/')[1]?.split(';')[0]?.toLowerCase();
  const safeExtension = extension && SUPPORTED_EXTENSIONS.includes(extension) ? extension : 'webm';
  const blob = new Blob([buffer], { type: mimeType });
  return callSpeechToText(blob, `voice-note.${safeExtension}`, language);
}
