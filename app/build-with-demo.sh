#!/bin/bash
# Render's "Root Directory" for this Static Site is set to `app`, so this
# script runs with that as its working directory — everything below is
# written with that in mind (the demo project is a sibling folder,
# reached via ../demo, not ./demo).
#
# The first two commands are *exactly* what Render's Build Command
# already ran before this script existed (`npm install && npm run
# build`) — nothing about how the real app gets built changes. Everything
# after that is new: it builds the separate demo/ project on its own and
# copies its output into this project's own dist/demo/, so the demo ends
# up reachable at app.irms.io/demo once this whole dist/ folder is
# published (see app/public/_redirects for the routing rule that sends
# /demo requests there).
set -e

echo "==> Building app"
npm install
npm run build

echo "==> Building demo"
cd ../demo
npm install
npm run build

echo "==> Merging demo build into app/dist/demo"
cd ../app
rm -rf dist/demo
mkdir -p dist/demo
cp -r ../demo/dist/. dist/demo/

echo "==> Done"
