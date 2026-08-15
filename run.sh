#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[Vibe Wrangler] Node.js was not found on your PATH. Install Node 22 or newer: https://nodejs.org"
  exit 1
fi

if ! command -v "${CLAUDE_BIN:-claude}" >/dev/null 2>&1; then
  echo "[Vibe Wrangler] Warning: the Claude CLI was not found on your PATH."
  echo "                The app will run, but the agent will not be able to start."
  echo
fi

# 5000 is Vibe Wrangler's port (see c:\github\apps.json); 3000 now belongs to house_dreamer.
PORT="${PORT:-5000}"
export PORT

echo "[Vibe Wrangler] starting on http://localhost:$PORT"

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:$PORT" >/dev/null 2>&1 &
elif command -v open >/dev/null 2>&1; then
  open "http://localhost:$PORT" >/dev/null 2>&1 &
fi

exec node --no-warnings=ExperimentalWarning server.js
