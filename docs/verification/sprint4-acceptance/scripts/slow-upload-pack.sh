#!/bin/sh
# ext:: helper: waits SLOW_SECONDS (default 8) before serving `git upload-pack <repo>`, so a pull runs long enough to click Commit.
sleep "${SLOW_SECONDS:-8}"
exec git upload-pack "$2"
