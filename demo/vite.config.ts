import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: '/demo/' is what makes every built asset URL resolve correctly
// once this project's own dist/ output is copied into app/dist/demo/ and
// served from that sub-path on the same domain as the real app (see
// build-static.sh at the repo root) — without it, the built index.html
// would reference assets at the site root (/assets/...) instead of
// /demo/assets/..., breaking the moment it's not served from /.
export default defineConfig({
  base: '/demo/',
  plugins: [react()],
})
