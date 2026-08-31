import { localApiRequest } from './localApi';

/** A Blob's own arrayBuffer() + manual base64 encoding — not FileReader's
 * readAsDataURL, which is the more common shortcut but requires slicing
 * off the "data:audio/webm;base64," prefix afterward for no real benefit
 * here (the server route only wants the raw base64 payload). Chunked in
 * 32KB pieces before String.fromCharCode.apply — passing the whole
 * (potentially several-hundred-KB) byte array as individual arguments in
 * one call risks blowing the engine's call-stack-argument limit, a real,
 * documented failure mode of the naive one-shot version of this pattern. */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK_SIZE = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

/** Sends a recorded voice note (CellHoverEditor.tsx's 🎤 button, via
 * MediaRecorder) to server/src/index.ts's POST /api/notes/transcribe.
 * `lang` defaults to omitted, which the server maps to Lithuanian — the
 * Notes tab's own long-standing explicit choice (a single, known intended
 * language, no picker needed). Pass `'auto'` (as EmailGeneratorView.tsx's
 * dictation button does) to instead get ElevenLabs' real language
 * auto-detection — see the server route's own doc comment. */
export async function transcribeVoiceNote(audioBlob: Blob, lang?: string): Promise<string> {
  const audioBase64 = await blobToBase64(audioBlob);
  const { text } = await localApiRequest<{ text: string }>('/api/notes/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBase64, mimeType: audioBlob.type || 'audio/webm', lang }),
  });
  return text;
}
