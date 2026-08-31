import { useEffect, useRef, useState } from 'react';
import { generateEmail, type EmailLang, type EmailMode, type EmailModel } from '../../utils/emailApi';
import { transcribeVoiceNote } from '../../utils/voiceNote';
import { useToastStore } from '../../store/useToastStore';
import { Mic, Circle, Check, Copy } from 'lucide-react';

const MODE_META: Record<EmailMode, { label: string; placeholder: string }> = {
  new: {
    label: 'Apie ką rašyti',
    placeholder:
      'Aprašykite, kokiu stiliumi ir apie ką reikia parašyti naują laišką. Galite padiktuoti balsu — paspauskite mikrofono mygtuką.',
  },
  reply: {
    label: 'Kaip atsakyti',
    placeholder:
      'Aprašykite, kokiu stiliumi ir ką atsakyti klientui. Galite padiktuoti balsu — paspauskite mikrofono mygtuką.',
  },
  reminder: {
    label: 'Ką norite priminti / paminėti',
    placeholder:
      'Aprašykite, apie ką priminti klientui ir kokiu tonu. Galite padiktuoti balsu — paspauskite mikrofono mygtuką.',
  },
};

const MODEL_OPTIONS: Array<{ value: EmailModel; label: string }> = [
  { value: 'claude-opus-5', label: 'Geriausia kokybė' },
  { value: 'claude-sonnet-5', label: 'Kainos ir kokybės balansas' },
  { value: 'claude-haiku-4-5-20251001', label: 'Greitai ir pigiai' },
];

/** Ported from a standalone Chrome extension (Desktop/Email-Extention,
 * "AI Email Generator") into a regular tab here — same three modes,
 * language toggle, Russian voice dictation, and model choice, generating
 * a ready-to-send client email via Claude. The one real architectural
 * change: the extension called api.anthropic.com directly from the
 * browser with a user-supplied key stored in chrome.storage.local; this
 * version routes through server/src/anthropic.ts instead, so the key
 * lives only in server/.env — consistent with every other AI provider
 * this app already talks to (OpenAI, ElevenLabs, serper.dev), none of
 * which put a secret in the client bundle. */
export function EmailGeneratorView() {
  const [mode, setMode] = useState<EmailMode>('new');
  const [lang, setLang] = useState<EmailLang>('lt');
  const [model, setModel] = useState<EmailModel>('claude-opus-5');
  const [clientEmail, setClientEmail] = useState('');
  const [clientHistory, setClientHistory] = useState('');
  const [instructions, setInstructions] = useState('');
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [copied, setCopied] = useState(false);

  const outputRef = useRef<HTMLTextAreaElement>(null);

  // Record → transcribe (ElevenLabs Scribe, language auto-detect), not
  // the browser's real-time Web Speech API this field used to use — that
  // API only ever listens for one *fixed* language per session, which is
  // why this field used to need an explicit RU/LT toggle next to the mic
  // button. Removed on explicit request ("я хочу просто чтоб ничего не
  // было бы... он сам определяет какой это язык"): an operator dictating
  // here genuinely switches between Russian/Lithuanian/English call to
  // call, and re-selecting a toggle before every recording was exactly
  // the friction being asked to remove. Same record-then-send pattern
  // already proven for the Notes tab's own voice-note button
  // (CellHoverEditor.tsx) — see utils/voiceNote.ts and the server route's
  // own doc comment for how `lang: 'auto'` maps to real auto-detection.
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);

  // Releases a live mic if this view unmounts mid-recording (tab switch)
  // — without this the browser's own "mic in use" indicator would stay
  // lit with no way left to stop it.
  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const toggleRecording = async () => {
    if (recording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    if (transcribing) return;
    setError('');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError('Prieiga prie mikrofono uždrausta. Leiskite naršyklei naudoti mikrofoną.');
      return;
    }
    micStreamRef.current = stream;
    audioChunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      // Release the mic the instant recording stops, regardless of what
      // happens to the transcription afterward — holding it open through
      // the async transcribe call would leave the "mic in use" indicator
      // lit for no reason.
      stream.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      setRecording(false);
      const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
      audioChunksRef.current = [];
      if (blob.size === 0) return;
      setTranscribing(true);
      transcribeVoiceNote(blob, 'auto')
        .then((text) => {
          if (!text.trim()) {
            setError('Nepavyko atpažinti kalbos — pabandykite dar kartą.');
            return;
          }
          setInstructions((prev) => {
            const sep = prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? ' ' : '';
            return prev + sep + text.trim();
          });
        })
        .catch((err) => setError(err instanceof Error ? err.message : 'Nepavyko atpažinti balso įrašo.'))
        .finally(() => setTranscribing(false));
    };
    recorder.start();
    setRecording(true);
  };

  const showToast = useToastStore((s) => s.show);

  const handleGenerate = async () => {
    setError('');
    if (!instructions.trim()) {
      setError('Aprašykite, ką reikia parašyti laiške (tekstu arba balsu).');
      return;
    }
    if (mode === 'reply' && !clientEmail.trim()) {
      setError('Įklijuokite kliento laišką, į kurį reikia atsakyti.');
      return;
    }
    if (mode === 'reminder' && !clientHistory.trim()) {
      setError('Įklijuokite informaciją apie klientą, kuria remiantis reikia parašyti priminimą.');
      return;
    }
    setLoading(true);
    try {
      const result = await generateEmail({
        mode,
        lang,
        model,
        instructions: instructions.trim(),
        clientEmail: mode === 'reply' ? clientEmail.trim() : undefined,
        clientHistory: mode === 'reminder' ? clientHistory.trim() : undefined,
      });
      setOutput(result.text);
      requestAnimationFrame(() => outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nepavyko sugeneruoti laiško.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!output) return;
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast('Nepavyko nukopijuoti — pažymėkite tekstą rankiniu būdu');
    }
  };

  const meta = MODE_META[mode];

  return (
    <div className="email-generator-view">
      <div className="email-generator-form">
        <div className="mode-tabs">
          {(['new', 'reply', 'reminder'] as const).map((m) => (
            <button key={m} type="button" className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
              {m === 'new' ? 'Naujas laiškas' : m === 'reply' ? 'Atsakymas klientui' : 'Priminimai'}
            </button>
          ))}
        </div>

        <div className="lang-select">
          <span className="label">Laiško kalba</span>
          <div className="lang-buttons">
            <button type="button" className={lang === 'lt' ? 'active' : ''} onClick={() => setLang('lt')}>
              <span className="lang-code-badge">LT</span> Lietuvių
            </button>
            <button type="button" className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>
              <span className="lang-code-badge">EN</span> English
            </button>
          </div>
          <select className="email-model-select" value={model} onChange={(e) => setModel(e.target.value as EmailModel)}>
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {mode === 'reply' && (
          <div className="field">
            <label htmlFor="email-client-email">Kliento laiškas</label>
            <textarea
              id="email-client-email"
              rows={8}
              placeholder="Įklijuokite čia iš kliento gautą laišką..."
              value={clientEmail}
              onChange={(e) => setClientEmail(e.target.value)}
            />
          </div>
        )}

        {mode === 'reminder' && (
          <div className="field">
            <label htmlFor="email-client-history">Kliento istorija / informacija</label>
            <textarea
              id="email-client-history"
              rows={8}
              placeholder="Įklijuokite viską, ką reikia žinoti apie šį klientą: ankstesnius laiškus, pastabas, pokalbio santrauką..."
              value={clientHistory}
              onChange={(e) => setClientHistory(e.target.value)}
            />
          </div>
        )}

        <div className="field">
          <div className="field-header">
            <label htmlFor="email-instructions">{meta.label}</label>
            <div className="mic-controls">
              <button
                type="button"
                className={`icon-btn ${recording ? 'recording' : ''}`}
                title="Įrašyti balsu — kalba atpažįstama automatiškai"
                disabled={transcribing}
                onClick={() => void toggleRecording()}
              >
                <Mic className="icon" size={16} />
              </button>
            </div>
          </div>
          <textarea
            id="email-instructions"
            rows={6}
            placeholder={meta.placeholder}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          {recording && (
            <div className="recording-indicator">
              <Circle className="icon" size={10} fill="currentColor" /> Vyksta įrašymas...
            </div>
          )}
          {transcribing && (
            <div className="recording-indicator">
              <Circle className="icon" size={10} fill="currentColor" /> Atpažįstama kalba...
            </div>
          )}
        </div>

        {error && <div className="search-result-detail-error">{error}</div>}

        <button type="button" className="primary email-generate-btn" disabled={loading} onClick={() => void handleGenerate()}>
          {loading ? 'Generuojama...' : 'Generuoti laišką'}
        </button>

        {output && (
          <div className="field">
            <div className="field-header">
              <label>Sugeneruotas laiškas</label>
              <button type="button" className="text-btn" onClick={() => void handleCopy()}>
                {copied ? <><Check className="icon" size={14} /> Nukopijuota</> : <><Copy className="icon" size={14} /> Kopijuoti</>}
              </button>
            </div>
            <textarea ref={outputRef} rows={14} value={output} onChange={(e) => setOutput(e.target.value)} />
          </div>
        )}
      </div>
    </div>
  );
}
