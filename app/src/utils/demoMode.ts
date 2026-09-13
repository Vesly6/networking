// Single source of truth for "is this the /demo build" — a build-time
// constant (set via app/.env.demo, loaded automatically by `vite build
// --mode demo`), not a runtime toggle. Because it's a compile-time
// `import.meta.env` value, every `if (DEMO_MODE)` branch that reads it is
// dead-code-eliminated out of the real production bundle, so none of the
// demo-only code below ever ships to app.irms.io.
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === 'true';

// Reused by localApi.ts (every non-table integration call this app makes)
// and by any demo-only stand-in UI that needs to explain why a button
// does nothing — same wording the standalone demo project used.
export const NOT_CONFIGURED_MESSAGE = 'This integration isn’t configured — available in the full product';
