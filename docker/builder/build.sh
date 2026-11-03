#!/bin/sh
set -eu
if [ -n "${2:-}" ]; then
  case "$2" in
    *[!0-9a-f]*|'') echo 'Invalid pinned Git commit.' >&2; exit 1 ;;
  esac
  [ "${#2}" -eq 40 ] || { echo 'Invalid pinned Git commit.' >&2; exit 1; }
  git init /work/repo
  git -C /work/repo remote add origin "$1"
  git -C /work/repo -c protocol.file.allow=never fetch --depth 1 origin "$2"
  git -C /work/repo checkout --detach FETCH_HEAD
else
  git -c protocol.file.allow=never clone --depth 1 --branch main --single-branch -- "$1" /work/repo
fi
cd /work/repo
test -f package-lock.json || { echo 'The Vite recipe requires a root package-lock.json.' >&2; exit 1; }
git rev-parse HEAD > /work/commit
npm ci --no-audit --no-fund
npm run build -- --base=./
test -f dist/index.html || { echo 'The Vite recipe requires dist/index.html.' >&2; exit 1; }
