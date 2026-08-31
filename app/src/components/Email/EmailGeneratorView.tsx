import { useEffect, useRef, useState } from 'react';
import { generateEmail, type EmailLang, type EmailMode, type EmailModel } from '../../utils/emailApi';
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

// The mic dictates in whichever spoken language the operator actually
// talks in (not to be confused with `lang`/`setLang` below, which picks
// the *generated email's* language) — separate because the Web Speech
// API only ever listens for one language per session, so "recognize
// Russian or Lithuanian" has to mean "let the operator pick which one",
// not both at once.
const MIC_LANG_OPTIONS: Array<{ value: string; code: string; label: string }> = [
  { value: 'ru-RU', code: 'RU', label: 'Rusų' },
  { value: 'lt-LT', code: 'LT', label: 'Lietuvių' },
];

const MODEL_OPTIONS: Array<{ value: EmailModel; label: string }> = [
  { value: 'claude-opus-5', label: 'Geriausia kokybė' },
  { value: 'claude-sonnet-5', label: 'Kainos ir kokybės balansas' },
  { value: 'claude-haiku-4-5-20251001', label: 'Greitai ir pigiai' },
];

// Same minimal ambient typing this codebase already uses for another
// browser-only API it doesn't control the shape of (see Softphone.tsx's
// own `declare global` for window.zadarmaWidgetFn) — the Web Speech API
// has no official TS lib entry, and only Chrome-family browsers implement
// it at all (ported as-is from the original extension, which only ever
// needed to run inside Chrome itself).
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultLike[];
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

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
  const [copied, setCopied] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(true);
  const [micLang, setMicLang] = useState('ru-RU');

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const outputRef = useRef<HTMLTextAreaElement>(null);

  // Same lazy, once-per-mount setup as the original extension — Web
  // Speech API recognizer objects are meant to be created once and
  // reused across start()/stop() calls, not recreated per click.
  useEffect(() => {
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Ctor) {
      setSpeechSupported(false);
      return;
    }
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      let finalChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) finalChunk += result[0].transcript;
      }
      if (finalChunk.trim()) {
        setInstructions((prev) => {
          const sep = prev && !prev.endsWith(' ') && !prev.endsWith('\n') ? ' ' : '';
          return prev + sep + finalChunk.trim();
        });
      }
    };
    recognition.onerror = (event) => {
      setRecording(false);
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setError('Prieiga prie mikrofono uždrausta. Leiskite naršyklei naudoti mikrofoną.');
      } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
        setError('Balso atpažinimo klaida: ' + event.error);
      }
    };
    recognition.onend = () => setRecording(false);
    recognitionRef.current = recognition;
    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.stop();
    };
  }, []);

  const toggleRecording = () => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    if (recording) {
      recognition.stop();
      setRecording(false);
    } else {
      setError('');
      // Set right before start(), not at construction — the recognizer
      // object is created once per mount (see the effect above) and
      // reused across calls, but .lang is only read when start() actually
      // begins listening, so switching the toggle and pressing the mic
      // again picks up the new language with no need to recreate anything.
      recognition.lang = micLang;
      try {
        recognition.start();
        setRecording(true);
      } catch (err) {
        setError('Nepavyko pradėti įrašymo: ' + (err instanceof Error ? err.message : String(err)));
      }
    }
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
              {speechSupported && (
                <div className="mic-lang-select">
                  {MIC_LANG_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={micLang === opt.value ? 'active' : ''}
                      disabled={recording}
                      title="Kuria kalba diktuosite mikrofonui"
                      onClick={() => setMicLang(opt.value)}
                    >
                      <span className="lang-code-badge">{opt.code}</span> {opt.label}
                    </button>
                  ))}
                </div>
              )}
              <button
                type="button"
                className={`icon-btn ${recording ? 'recording' : ''}`}
                title={speechSupported ? 'Įrašyti balsu' : 'Balso įvedimas nepalaikomas šioje naršyklėje'}
                disabled={!speechSupported}
                onClick={toggleRecording}
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
