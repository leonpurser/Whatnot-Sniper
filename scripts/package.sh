#!/bin/sh
# Builds dist/whatnot-bid-assistant-<version>.zip containing only the files the
# extension needs (no tests, docs or fixtures). Load it via chrome://extensions
# → "Load unpacked" after unzipping, or keep it as a release artifact.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="dist/whatnot-bid-assistant-$version.zip"
mkdir -p dist
rm -f "$out"
zip -qr "$out" USER_GUIDE.txt manifest.json background content page shared sidepanel icons -x '*.DS_Store'
echo "$out ($(du -h "$out" | cut -f1))"
