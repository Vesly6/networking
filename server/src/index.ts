import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { ZadarmaApiError, getStatistics, requestRecording, requestCallback, getWebrtcKey } from './zadarma.js';
import { TranscriptionError, transcribeFromUrl } from './elevenlabs.js';
import { ContactParseError, parseContactText, SummarizeError, summarizeCall } from './openai.js';
import { AuthError, checkCredentials, issueToken, requireAuth } from './auth.js';
import { ApolloApiError, searchPeople, searchCompanies, enrichPerson } from './apollo.js';

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

// Single shared account (this is a one-operator tool, not multi-tenant) —
// checkCredentials() accepts either AUTH_PASSWORD or AUTH_RECOVERY_PASSWORD
// for the same username. Logging in with the recovery password still
// issues a normal token (there's no separate "reset flow" that mutates
// server state — see CLAUDE.md for why, given this runs on a free-tier
// host with no persistent disk); the frontend just tells the user to
// update AUTH_PASSWORD in the hosting dashboard when `viaRecovery` comes
// back true, the same place every other secret in this app already lives.
app.post(
  '/api/auth/login',
  asyncHandler(async (req, res) => {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const match = checkCredentials(username, password);
    if (!match) {
      res.status(401).json({ error: 'Incorrect username or password' });
      return;
    }
    res.json({ token: issueToken(username), viaRecovery: match === 'recovery' });
  }),
);

// Everything below requires a valid session token — a visitor who never
// loads the frontend at all (hits these routes directly) is blocked here
// too, not just by the login screen.
app.use(requireAuth);

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
    // Two different SIP formats for two different Zadarma calls — per
    // Zadarma support: /v1/webrtc/get_key/ itself wants the bare extension
    // ("100"), but the value actually handed to the WIDGET's own init
    // function (zadarmaWidgetFn, in Softphone.tsx) needs the fully
    // qualified "{account_id}-{extension}" form ("488048-100" for this
    // account) — using the bare extension there is what produced the
    // integrationDisabled/"Sip not found" error, not anything about the
    // domain or the key itself.
    const sip = process.env.ZADARMA_WEBRTC_SIP;
    const widgetSip = process.env.ZADARMA_WEBRTC_WIDGET_SIP;
    if (!sip || !widgetSip) {
      res.status(500).json({ error: 'ZADARMA_WEBRTC_SIP / ZADARMA_WEBRTC_WIDGET_SIP are not set — check server/.env' });
      return;
    }
    const result = await getWebrtcKey(sip);
    res.json({ key: result.key, sip: widgetSip });
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

// The three Apollo routes below just forward the request body through to
// apollo.ts's typed wrappers — validation stays minimal (this is a single-
// operator tool, not a public API), the frontend's filter panel is
// responsible for building a well-formed body. Free to call (0 credits).
app.post(
  '/api/apollo/people/search',
  asyncHandler(async (req, res) => {
    const result = await searchPeople(req.body ?? {});
    res.json(result);
  }),
);

// Costs Apollo credits — "1 credit per page" (up to 100 results), unlike
// people search above. The frontend surfaces this before calling it (see
// SearchView.tsx) rather than the server silently spending money on every
// keystroke of a filter form.
app.post(
  '/api/apollo/companies/search',
  asyncHandler(async (req, res) => {
    const result = await searchCompanies(req.body ?? {});
    res.json(result);
  }),
);

// Costs Apollo credits (1 for email, +8 more for a phone number) — this is
// the one Apollo route in the whole app that's never called automatically,
// only from an explicit "Reveal contact" click per person, same philosophy
// as Calls' manual per-call "Transcribe" button (CLAUDE.md).
app.post(
  '/api/apollo/people/enrich',
  asyncHandler(async (req, res) => {
    const result = await enrichPerson(req.body ?? {});
    res.json(result);
  }),
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AuthError) {
    console.error('Auth config error:', err.message);
    res.status(500).json({ error: err.message });
    return;
  }
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
  if (err instanceof ApolloApiError) {
    console.error('Apollo API error:', err.message, err.raw);
    res.status(502).json({ error: err.message });
    return;
  }
  console.error('Unexpected server error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, HOST, () => {
  console.log(`Zadarma proxy listening on http://${HOST}:${PORT}`);
});
