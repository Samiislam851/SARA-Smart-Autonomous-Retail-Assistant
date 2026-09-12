#!/usr/bin/env bash
# Bring up server + two Cloudflare quick tunnels, then build+start web
# pointed at the public agent tunnel URL. Idempotent: safe to re-run.
#
# A cloudflared quick tunnel only gives ONE public URL for whatever it
# points at. The browser needs to reach BOTH the web app and the server
# (for /event and the WS), so this script runs two tunnels — one for
# `web`, one for `server` — and rebuilds the web image with the server
# tunnel's URL baked in as NEXT_PUBLIC_AGENT_HTTP/WS (Next inlines
# NEXT_PUBLIC_* at build time, so a rebuild is unavoidable here).

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

COMPOSE="docker compose"
TIMEOUT_SECS=60

echo "==> Starting server..."
$COMPOSE up -d --build agent   # always rebuild: recordings, demo pages and fixtures ship in the image

echo "==> Waiting for server to be healthy..."
deadline=$((SECONDS + TIMEOUT_SECS))
while true; do
  status=$($COMPOSE ps agent --format json 2>/dev/null | grep -o '"Health":"[a-z]*"' | head -1 | cut -d'"' -f4 || true)
  if [[ "$status" == "healthy" ]]; then
    break
  fi
  if (( SECONDS > deadline )); then
    echo "server did not become healthy within ${TIMEOUT_SECS}s" >&2
    exit 1
  fi
  sleep 2
done

echo "==> Starting tunnels..."
$COMPOSE --profile tunnel up -d tunnel tunnel-agent

extract_url() {
  # $1: service name. Greps cloudflared logs for the first *.trycloudflare.com
  # URL. Retries up to TIMEOUT_SECS since the tunnel takes a few seconds to
  # register with Cloudflare's edge.
  local service="$1"
  local deadline=$((SECONDS + TIMEOUT_SECS))
  local url=""
  while [[ -z "$url" ]]; do
    # tail -1, not head -1: on a re-run (script is idempotent, logs
    # accumulate across restarts) the FIRST matching URL in the logs can be
    # from a previous tunnel process that's no longer live. The most
    # recently printed URL (last match) is the current tunnel's.
    url=$($COMPOSE logs "$service" 2>/dev/null | grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' | tail -1 || true)
    if [[ -n "$url" ]]; then
      echo "$url"
      return 0
    fi
    if (( SECONDS > deadline )); then
      echo "no trycloudflare.com URL found in '$service' logs within ${TIMEOUT_SECS}s" >&2
      return 1
    fi
    sleep 2
  done
}

echo "==> Waiting for web tunnel URL..."
WEB_URL=$(extract_url tunnel)
echo "    web tunnel: $WEB_URL"

echo "==> Waiting for agent tunnel URL..."
SERVER_URL=$(extract_url tunnel-agent)
echo "    agent tunnel: $SERVER_URL"

SERVER_HOST="${SERVER_URL#https://}"
PUBLIC_HTTP="$SERVER_URL"
PUBLIC_WS="wss://${SERVER_HOST}"

echo "==> Rebuilding web with PUBLIC_HTTP=$PUBLIC_HTTP PUBLIC_WS=$PUBLIC_WS ..."
PUBLIC_HTTP="$PUBLIC_HTTP" PUBLIC_WS="$PUBLIC_WS" $COMPOSE build demo-store
PUBLIC_HTTP="$PUBLIC_HTTP" PUBLIC_WS="$PUBLIC_WS" $COMPOSE up -d demo-store

echo
echo "==> Done."
echo "    Web (public):    $WEB_URL"
echo "    Server (public): $SERVER_URL"
