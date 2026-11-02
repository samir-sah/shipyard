#!/bin/sh
set -eu
git -c protocol.file.allow=never clone --depth 1 --branch main --single-branch -- "$1" /work/repo
cd /work/repo
test -f package-lock.json || { echo 'The Vite recipe requires a root package-lock.json.' >&2; exit 1; }
git rev-parse HEAD > /work/commit
npm ci --no-audit --no-fund
npm run build -- --base=./
test -f dist/index.html || { echo 'The Vite recipe requires dist/index.html.' >&2; exit 1; }
