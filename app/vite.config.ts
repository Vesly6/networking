import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // The demo build is this same app, output to a /demo/ sub-path of the
  // same static site (see build-with-demo.sh and public/_redirects) —
  // base has to match wherever the built assets actually get served from,
  // or the built index.html would reference /assets/... instead of
  // /demo/assets/..., breaking the moment it's not served from /.
  base: mode === 'demo' ? '/demo/' : '/',
  // Binds to every network interface, not just localhost — required for
  // opening the app from a phone on the same wifi via the Mac's LAN IP
  // (see app/.env's VITE_API_BASE_URL). Without this, `npm run dev`
  // listens on localhost only regardless of the backend's own
  // HOST=0.0.0.0 setting, so a phone can't even load the page at all.
  server: {
    host: true,
  },
}))
