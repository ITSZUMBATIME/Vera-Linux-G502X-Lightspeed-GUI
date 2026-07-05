#!/usr/bin/env bash
# Starts the G502 X Control Center backend (if not already running) and
# opens it in your default browser.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/app/backend"
PORT="${PORT:-5000}"
URL="http://127.0.0.1:${PORT}"
LOG="/tmp/g502x-control-center.log"

if ! curl -s -o /dev/null "${URL}/api/status"; then
  cd "$DIR"
  RATBAG_MODE=real "$DIR/.venv/bin/python" app.py >"$LOG" 2>&1 &
  disown

  for _ in $(seq 1 40); do
    curl -s -o /dev/null "${URL}/api/status" && break
    sleep 0.25
  done
fi

xdg-open "$URL" >/dev/null 2>&1 &
