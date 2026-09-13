#!/bin/bash
# Render's "Root Directory" for this Static Site is set to `app`, so this
# script runs with that as its working directory.
#
# The demo used to be a completely separate Vite project (../demo) built
# on its own and copied in. It's now just this same app, built a second
# time in "demo" mode (see vite.config.ts's conditional `base` and
# .env.demo's VITE_DEMO_MODE=true, which flips db.ts/useAuthStore.ts/
# localApi.ts over to an in-memory dataset instead of the real backend —
# see utils/demoMode.ts) — so the exact same TableView/DataCell/right-
# click menus/Calendar the real app uses are what ends up at /demo, not a
# hand-rewritten copy. The merge step and app/public/_redirects routing
# rule are unchanged from before.
set -e

echo "==> Building app"
npm install
npm run build

echo "==> Building demo (same app, --mode demo)"
# Skips tsc -b deliberately — it's the same source tree `npm run build`
# above already type-checked; only the Vite mode/env differs here.
npx vite build --mode demo --outDir dist-demo

echo "==> Merging demo build into app/dist/demo"
rm -rf dist/demo
mkdir -p dist/demo
cp -r dist-demo/. dist/demo/
rm -rf dist-demo

echo "==> Done"
