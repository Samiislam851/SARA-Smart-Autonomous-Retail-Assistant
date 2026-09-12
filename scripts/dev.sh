#!/usr/bin/env bash
# Runs server + web together in the foreground, prefixed/colourised logs,
# Ctrl+C kills both. Waits for the server's /health before starting web.
#
# Flags:
#   --stub            AGENT_MODE=stub (default)
#   --cached          AGENT_MODE=cached
#   --llm <backend>   AGENT_MODE=llm LLM_BACKEND=<backend>
set -euo pipefail
set -m  # job control: each backgrounded job below gets its own process
        # group (PGID == its own PID), so cleanup() can kill npm's whole
        # child tree via `kill -- -PID`, not just the tracked PID. `setsid`
        # doesn't give a usable PID for this: it forks internally and its
        # own PID (what `$!` would report) exits immediately once the real
        # command execs, leaving nothing to reliably kill.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT="${PORT:-4000}"
WEB_PORT=3000

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stub)
      export AGENT_MODE=stub
      shift
      ;;
    --cached)
      export AGENT_MODE=cached
      shift
      ;;
    --llm)
      if [[ -z "${2:-}" ]]; then
        echo "--llm requires a backend argument, e.g. --llm claude" >&2
        exit 1
      fi
      export AGENT_MODE=llm
      export LLM_BACKEND="$2"
      shift 2
      ;;
    *)
      echo "unknown flag: $1" >&2
      echo "usage: scripts/dev.sh [--stub|--cached|--llm <backend>]" >&2
      exit 1
      ;;
  esac
done

export PORT

# Colours (skip if not a tty)
if [[ -t 1 ]]; then
  C_SERVER=$'\033[36m'
  C_WEB=$'\033[35m'
  C_RESET=$'\033[0m'
else
  C_SERVER=""
  C_WEB=""
  C_RESET=""
fi

SERVER_PID=""
WEB_PID=""

# Each of agent/web is backgrounded directly in THIS shell (never through a
# function call captured with `$(...)` — command substitution runs in its
# own subshell, which would make the backgrounded job a child of that
# subshell rather than of this script; it'd get reparented away the instant
# the subshell exits, and `wait "$PID"` below would then fail since the PID
# is no longer this shell's child). With `set -m` above, each becomes the
# leader of its own process group (PGID == its own PID), so cleanup() can
# kill the whole group (`kill -- -PID`) — needed because npm forks a child
# node/next process, and killing just the tracked npm PID would leave that
# child running as an orphan. Piping a command's output through
# `| while read...` (as an earlier version of this script did) has the same
# failure mode from the other direction: `$!` becomes the reader's PID, not
# npm's, so killing it leaves npm/node untouched. Output is prefixed via
# process substitution instead, which doesn't change whose PID `$!` is.

cleanup() {
  echo
  echo "==> Shutting down..."
  [[ -n "$SERVER_PID" ]] && kill -TERM -- "-${SERVER_PID}" 2>/dev/null || true
  [[ -n "$WEB_PID" ]] && kill -TERM -- "-${WEB_PID}" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && wait "$SERVER_PID" 2>/dev/null || true
  [[ -n "$WEB_PID" ]] && wait "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Starting server on :${PORT} (AGENT_MODE=${AGENT_MODE:-stub}${LLM_BACKEND:+ LLM_BACKEND=$LLM_BACKEND})..."
npm --prefix agent run dev > >(sed -u "s/^/${C_SERVER}[server]${C_RESET} /") 2>&1 &
SERVER_PID=$!

echo "==> Waiting for http://localhost:${PORT}/health..."
deadline=$((SECONDS + 30))
until curl -sf "http://localhost:${PORT}/health" >/dev/null 2>&1; do
  if (( SECONDS > deadline )); then
    echo "server did not become healthy within 30s" >&2
    exit 1
  fi
  sleep 0.5
done
echo "==> Server healthy."

echo "==> Starting web on :${WEB_PORT}..."
# PORT is exported above for the server (defaults to 4000); Next.js also
# reads PORT from its env, so without overriding it here `next dev` would
# try to bind :4000 too and fail with EADDRINUSE. Pin it to WEB_PORT for
# just this command.
PORT="$WEB_PORT" npm --prefix demo-store run dev > >(sed -u "s/^/${C_WEB}[web]${C_RESET} /") 2>&1 &
WEB_PID=$!

# Best-effort wait for web to come up before printing the URL box (non-fatal).
deadline=$((SECONDS + 20))
until curl -sf "http://localhost:${WEB_PORT}" >/dev/null 2>&1; do
  if (( SECONDS > deadline )); then
    break
  fi
  sleep 0.5
done

cat <<EOF

+--------------------------------------------------------------------+
  Store:        http://localhost:${WEB_PORT}
  Demo page:    http://localhost:${PORT}/demo.html
  Embed snippet: http://localhost:${PORT}/embed
  Health:       http://localhost:${PORT}/health
  Trace/state:  http://localhost:${PORT}/state/<session>
+--------------------------------------------------------------------+

  Fixture sessions (from agent/):
    node replay.js sessions/sizing-hesitation.json
    node replay.js sessions/cart-threshold.json
    node replay.js sessions/happy-browsing.json

  Ctrl+C to stop both server and web.
EOF

wait "$SERVER_PID" "$WEB_PID"
