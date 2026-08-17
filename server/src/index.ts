import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { ZadarmaApiError, getStatistics, requestRecording, requestCallback, getWebrtcKey } from './zadarma.js';
import { TranscriptionError, transcribeFromUrl } from './elevenlabs.js';
import { ContactParseError, parseContactText, SummarizeError, summarizeCall } from './openai.js';

const PORT = Number(process.env.PORT) || 4000;
// Binds 127.0.0.1 by default — deliberately not reachable from the local
// network on a personal machine (see CLAUDE.md). A cloud host's own network
// isolation replaces that role, and most of them require listening on all
// interfaces to route traffic in at all — set HOST=0.0.0.0 in that env
// (Render and similar platforms document this).
const HOST = process.env.HOST || '127.0.0.1';
// Comma-separated list of allowed frontend origins, e.g.
// "https://crm.yourdomain.com,https://crm-preview.pages.dev" — set this in
// the hosting platform's env var UI once the frontend has a real domain.
// Falls back to the local Vite dev server origins so local dev is
// unaffected when this isn't set.
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : ['http://localhost:5173', 'http://localhost:5174'];

const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

function asyncHandler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

app.get(
  '/api/calls',
  asyncHandler(async (req, res) => {
    const { start, end, sip, skip, limit } = req.query;
    if (typeof start !== 'string' || typeof end !== 'string' || !DATE_RE.test(start) || !DATE_RE.test(end)) {
      res.status(400).json({ error: 'start/end must be "YYYY-MM-DD HH:MM:SS"' });
      return;
    }
    const startMs = Date.parse(start.replace(' ', 'T'));
    const endMs = Date.parse(end.replace(' ', 'T'));
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs - startMs > 31 * 24 * 60 * 60 * 1000) {
      res.status(400).json({ error: 'Date range cannot exceed 31 days' });
      return;
    }
    const result = await getStatistics({
      start,
      end,
      sip: typeof sip === 'string' ? sip : undefined,
      skip: typeof skip === 'string' ? Number(skip) : undefined,
      limit: typeof limit === 'string' ? Number(limit) : undefined,
    });
    res.json(result);
  }),
);

app.get(
  '/api/calls/:callId/recording',
  asyncHandler(async (req, res) => {
    const result = await requestRecording({ callId: req.params.callId });
    res.json(result);
  }),
);

// Single synchronous request: fetch the recording link from Zadarma,
// download the audio, send it to ElevenLabs, return the transcript text.
// Unlike Zadarma's own speech_recognition (an async job you start then
// poll), ElevenLabs' transcription endpoint blocks until it's done — so
// there's no separate "start"/"poll" pair of routes here.
app.post(
  '/api/calls/:callId/transcribe',
  asyncHandler(async (req, res) => {
    const lang = typeof req.body?.lang === 'string' ? req.body.lang : 'lt';
    const recording = await requestRecording({ callId: req.params.callId });
    const link = recording.link ?? recording.links?.[0];
    if (!link) {
      res.status(502).json({ error: 'No recording available for this call' });
      return;
    }
    const result = await transcribeFromUrl(link, lang);
    res.json(result);
  }),
);

// The transcript text lives client-side already (the /transcribe response
// above) — sent back up here rather than re-fetched, since there's no
// server-side cache of it (that's the frontend's job, via IndexedDB's
// transcriptions store). callId is only used for the error message below.
app.post(
  '/api/calls/:callId/summarize',
  asyncHandler(async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : undefined;
    if (!text || !text.trim()) {
      res.status(400).json({ error: 'Missing "text" to summarize' });
      return;
    }
    const result = await summarizeCall(text);
    res.json(result);
  }),
);

// Click-to-call: dials your own number first, then connects you to `to`
// once you pick up. `from` defaults to ZADARMA_CALLER_NUMBER (server/.env)
// so the frontend never needs to know/hardcode which number is "yours".
app.post(
  '/api/callback',
  asyncHandler(async (req, res) => {
    const to = typeof req.body?.to === 'string' ? req.body.to : undefined;
    if (!to) {
      res.status(400).json({ error: 'Missing "to" phone number' });
      return;
    }
    const from = process.env.ZADARMA_CALLER_NUMBER;
    if (!from) {
      res.status(500).json({ error: 'ZADARMA_CALLER_NUMBER is not set — check server/.env' });
      return;
    }
    const result = await requestCallback({ from, to });
    res.json(result);
  }),
);

// Standalone browser softphone (floating widget, not tied to the Contacts
// 📞 buttons — Zadarma's widget has no documented "dial this number" JS
// API, only its own dialpad; the 📞 buttons keep using /api/callback
// above). Fetched fresh on every app load rather than cached anywhere —
// the key is only valid 72h, and a page load is cheap/infrequent enough
// that there's no reason to manage its lifetime more carefully than that.
app.get(
  '/api/webrtc/key',
  asyncHandler(async (_req, res) => {
    const sip = process.env.ZADARMA_WEBRTC_SIP;
    if (!sip) {
      res.status(500).json({ error: 'ZADARMA_WEBRTC_SIP is not set — check server/.env' });
      return;
    }
    const result = await getWebrtcKey(sip);
    res.json({ key: result.key, sip });
  }),
);

app.post(
  '/api/contacts/parse',
  asyncHandler(async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : undefined;
    if (!text || !text.trim()) {
      res.status(400).json({ error: 'Missing "text" to parse' });
      return;
    }
    const result = await parseContactText(text);
    res.json(result);
  }),
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZadarmaApiError) {
    console.error('Zadarma API error:', err.message, err.raw);
    res.status(502).json({ error: err.message });
    return;
  }
  if (err instanceof TranscriptionError) {
    console.error('ElevenLabs error:', err.message);
    res.status(502).json({ error: err.message });
    return;
  }
  if (err instanceof ContactParseError || err instanceof SummarizeError) {
    console.error('OpenAI error:', err.message);
    res.status(502).json({ error: err.message });
    return;
  }
  console.error('Unexpected server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, HOST, () => {
  console.log(`Zadarma proxy listening on http://${HOST}:${PORT}`);
});
