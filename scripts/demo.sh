#!/usr/bin/env bash
# On-camera demo runner: prints the URL to open (page pinned to a recorded
# session id via ?agent_session=), waits for you to open it, then replays
# that session's fixture against the server so the live tab shows the
# pulse/message/quiet-trace in real time. See DEMO.md.
#
# Usage:
#   scripts/demo.sh <fixture-name> [--base http://localhost:4000] [--web http://localhost:3000] [--speed 1] [--yes]
#   scripts/demo.sh --all [--base ...] [--web ...] [--speed 1] [--yes]
#   scripts/demo.sh --reset-only <fixture-name> [--base http://localhost:4000]
#
# <fixture-name> is one of: sizing, cart, happy (maps to the recorded
# fixtures below). --yes skips the "press Enter" prompt (for non-interactive/
# CI verification runs).
#
# Retakes: before every fixture run, this script DELETEs that fixture's
# session on the server (agent/index.js's dev-only `DELETE /session/:id`)
# so policy's cooldown / never-same-target guards don't remember the
# previous take. That route only exists when the server was started with
# AGENT_DEBUG=1 — without it the DELETE 404s and this script prints a
# warning (the replay itself may then fail or behave like a "second take"
# if it's actually a retake). `--reset-only <fixture>` just does the reset
# and exits, without opening a URL or replaying anything.
#
# --base must be the PUBLIC server URL the browser tab's widget is actually
# talking to (the docker/tunnel server), NOT necessarily localhost:4000 — the
# widget's NEXT_PUBLIC_AGENT_HTTP/WS are baked in at web build time (see
# docker-compose.yml build args), so --web and --base must point at a
# matching pair.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

BASE="http://localhost:4000"
WEB="http://localhost:3000"
SPEED=1
YES=0
FIXTURE=""
ALL=0
RESET_ONLY=0

usage() {
  echo "usage: scripts/demo.sh <sizing|cart|happy|--all> [--base url] [--web url] [--speed n] [--yes]" >&2
  echo "       scripts/demo.sh --reset-only <sizing|cart|happy> [--base url]" >&2
  exit 1
}

[[ $# -eq 0 ]] && usage

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) ALL=1; shift ;;
    --reset-only) RESET_ONLY=1; shift ;;
    --base) BASE="${2:?--base requires a value}"; shift 2 ;;
    --web) WEB="${2:?--web requires a value}"; shift 2 ;;
    --speed) SPEED="${2:?--speed requires a value}"; shift 2 ;;
    --yes) YES=1; shift ;;
    sizing|cart|happy) FIXTURE="$1"; shift ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

if [[ "$RESET_ONLY" == 1 && -z "$FIXTURE" ]]; then
  usage
fi

if [[ "$ALL" == 0 && "$RESET_ONLY" == 0 && -z "$FIXTURE" ]]; then
  usage
fi

# name -> (session id, fixture json, product path)
fixture_meta() {
  case "$1" in
    sizing) echo "fx_sizing_hesitation sessions/sizing-hesitation.json /product/khadi-field-jacket" ;;
    cart)   echo "fx_cart_threshold sessions/cart-threshold.json /cart" ;;
    happy)  echo "fx_happy_browsing sessions/happy-browsing.json /" ;;
    *) return 1 ;;
  esac
}

# reset_session <session-id> — DELETEs the session on the server so a
# retake doesn't inherit the previous take's cooldown/actedTargets memory.
# Requires the server to have been started with AGENT_DEBUG=1; otherwise the
# route 404s and we just warn (the route's absence is itself the signal —
# see agent/OPS.md).
reset_session() {
  local session="$1"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "${BASE}/session/${session}")
  if [[ "$code" == "200" ]]; then
    echo "reset ok (${session})"
  elif [[ "$code" == "404" ]]; then
    echo "warning: DELETE /session/${session} -> 404 — start the server with AGENT_DEBUG=1 to enable retakes" >&2
  else
    echo "warning: DELETE /session/${session} -> ${code} (unexpected)" >&2
  fi
}

run_one() {
  local name="$1"
  local meta session fixture_file page
  meta=$(fixture_meta "$name") || { echo "unknown fixture: $name" >&2; return 1; }
  read -r session fixture_file page <<<"$meta"

  reset_session "$session"

  local url="${WEB}${page}?agent_session=${session}"

  echo
  echo "=== ${name} (${session}) ==="
  echo "Open: ${url}"
  if [[ "$YES" == 1 ]]; then
    echo "(--yes: skipping Enter prompt)"
  else
    read -r -p "Open it, then press Enter to start the replay..." _
  fi

  echo "==> Replaying ${fixture_file} against ${BASE} (speed ${SPEED})..."
  (
    cd agent
    REPLAY_FIXED_SESSION=1 AGENT_HTTP="$BASE" node replay.js "$fixture_file" --base "$BASE" --speed "$SPEED" --settle 3000
  )
  local rc=$?
  return $rc
}

if [[ "$RESET_ONLY" == 1 ]]; then
  meta=$(fixture_meta "$FIXTURE") || { echo "unknown fixture: $FIXTURE" >&2; exit 1; }
  read -r session _ _ <<<"$meta"
  reset_session "$session"
  exit 0
fi

if [[ "$ALL" == 1 ]]; then
  total=0
  passed=0
  for name in sizing cart happy; do
    total=$((total + 1))
    if run_one "$name"; then
      passed=$((passed + 1))
    fi
    if [[ "$name" != "happy" ]]; then
      if [[ "$YES" == 1 ]]; then
        echo "(--yes: skipping pause between fixtures)"
      else
        read -r -p "Next fixture — press Enter when ready..." _
      fi
    fi
  done
  echo
  echo "${passed}/${total} PASS"
  [[ "$passed" == "$total" ]]
  exit $?
else
  run_one "$FIXTURE"
  exit $?
fi
