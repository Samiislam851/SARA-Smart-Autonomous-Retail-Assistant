#!/usr/bin/env bash
# Pre-push sanity check: syntax, policy probe, fixture replay against a stub
# server, static routes, and web typecheck. Prints a summary; exit code
# reflects whether anything required actually failed.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

FAIL=0
WARN=0
SERVER_PID=""

note_fail() { echo "  [FAIL] $1"; FAIL=1; }
note_warn() { echo "  [WARN] $1"; WARN=1; }
note_ok()   { echo "  [ OK ] $1"; }

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "==> Syntax-checking agent/**/*.js"
SYNTAX_OK=1
while IFS= read -r -d '' f; do
  if ! node --check "$f" >/tmp/check-syntax.$$ 2>&1; then
    note_fail "node --check $f"
    cat /tmp/check-syntax.$$
    SYNTAX_OK=0
  fi
done < <(find agent -name '*.js' -not -path 'agent/node_modules/*' -print0)
rm -f /tmp/check-syntax.$$
[[ "$SYNTAX_OK" == 1 ]] && note_ok "all agent JS files parse"

echo
echo "==> Policy probe (agent/probe-policy.test.js)"
if (cd agent && node probe-policy.test.js); then
  note_ok "policy probe passed"
else
  note_fail "policy probe failed"
fi

echo
echo "==> Outcome tracking test (agent/outcome.test.js)"
if (cd agent && node outcome.test.js); then
  note_ok "outcome tracking test passed"
else
  note_fail "outcome tracking test failed"
fi

echo
echo "==> Starting stub server for fixture replay + route checks"
FREE_PORT=$(node -e 'const net=require("net");const s=net.createServer();s.listen(0,()=>{console.log(s.address().port);s.close();});')
if [[ -z "$FREE_PORT" ]]; then
  note_fail "could not find a free port"
  FREE_PORT=4099
fi
BASE="http://localhost:${FREE_PORT}"

(cd agent && exec env AGENT_MODE=stub PORT="$FREE_PORT" node index.js > /tmp/check-server.$$.log 2>&1) &
SERVER_PID=$!

deadline=$((SECONDS + 20))
SERVER_UP=0
until curl -sf "${BASE}/health" >/dev/null 2>&1; do
  if (( SECONDS > deadline )); then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.3
done
if curl -sf "${BASE}/health" >/dev/null 2>&1; then
  SERVER_UP=1
  note_ok "stub server up on :${FREE_PORT}"
else
  note_fail "stub server did not become healthy on :${FREE_PORT}"
  echo "  --- server log ---"
  sed 's/^/  /' /tmp/check-server.$$.log 2>/dev/null
fi

if [[ "$SERVER_UP" == 1 ]]; then
  echo
  echo "==> Replaying fixtures (sessions/*.json, --speed 10)"
  REPLAY_OUT=$(cd agent && node replay.js sessions/*.json --base "$BASE" --speed 10 2>&1)
  echo "$REPLAY_OUT"

  # Three fixtures are required to PASS in stub mode (deterministic under
  # decide/stub.js, no LLM involved):
  #   - sizing-hesitation: the fixture the stub decider is designed to
  #     satisfy — element attention >= the stub's threshold fires highlight.
  #   - reader-above-fold: per-element-dwell-is-viewport-time defect-class
  #     regression — page dwell alone, no element attention at all, must
  #     stay noop. Last event is a cart_update, so it's deterministic
  #     (the stub only ever proposes non-noop off the CURRENT event being an
  #     element dwell — see agent/decide/stub.js).
  #   - reader-below-fold: same defect class, opposite angle (S4) — an
  #     element scrolled into view and left visible (but never
  #     hovered/focused/clicked) is capped at SCROLL_CREDIT_MS (5000ms) of
  #     credited attention by the client's one-shot scroll credit, which
  #     stays under the stub's threshold (6000ms) by design — must stay
  #     noop even though the element sits on screen for the whole visit.
  # Every OTHER fixture in agent/sessions/*.json (derived from the
  # directory at run time, not a hardcoded list, so a newly added fixture
  # file is picked up automatically without editing this script) requires
  # the real LLM loop and is expected to fail in stub mode — reported
  # informationally, not required to pass.
  #   - missed-promo / similar-on-promo: store-knowledge offer fixtures
  #     (agent/store/) — deterministic under decide/stub.js's own
  #     missed_discount/similar_on_promo rules, same reasoning as the three above.
  REQUIRED_STUB_FIXTURES=("sizing-hesitation" "reader-above-fold" "reader-below-fold" "missed-promo" "similar-on-promo")
  for name in "${REQUIRED_STUB_FIXTURES[@]}"; do
    line=$(echo "$REPLAY_OUT" | awk -v n="=== ${name} " 'index($0,n)==1{found=1} found && /^(PASS|FAIL) —/{print; exit}')
    if [[ "$line" == PASS* ]]; then
      note_ok "required fixture (${name}): $line"
    else
      note_fail "required fixture (${name}) did not PASS in stub mode: ${line:-no verdict found}"
    fi
  done

  for f in agent/sessions/*.json; do
    name=$(basename "$f" .json)
    skip=0
    for req in "${REQUIRED_STUB_FIXTURES[@]}"; do
      [[ "$name" == "$req" ]] && skip=1
    done
    [[ "$skip" == 1 ]] && continue
    line=$(echo "$REPLAY_OUT" | awk -v n="=== ${name} " 'index($0,n)==1{found=1} found && /^(PASS|FAIL) —/{print; exit}')
    echo "  [info] fixture ${name}: ${line:-no verdict found} (not required to pass in stub mode)"
  done

  echo
  echo "==> Route checks"
  HEALTH_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health")
  if [[ "$HEALTH_CODE" == "200" ]]; then
    note_ok "/health -> 200"
  else
    note_fail "/health -> ${HEALTH_CODE}"
  fi

  AGENTJS_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/agent.js")
  if [[ "$AGENTJS_CODE" == "200" ]]; then
    note_ok "/agent.js -> 200"
  else
    note_fail "/agent.js -> ${AGENTJS_CODE}"
  fi

  DEMO_CODE=$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/demo.html")
  if [[ "$DEMO_CODE" == "200" ]]; then
    note_ok "/demo.html -> 200"
  else
    note_warn "/demo.html -> ${DEMO_CODE} (may not have landed yet from a concurrent worker)"
  fi
else
  note_fail "skipped fixture replay + route checks: server never came up"
fi

cleanup
SERVER_PID=""

echo
node demo-store/scripts/check-store-mirror.mjs || note_fail "store mirror check (demo-store/lib vs agent/store) failed"

echo
echo "==> web: npx tsc --noEmit"
if (cd demo-store && npx tsc --noEmit); then
  note_ok "web typechecks"
else
  note_fail "web typecheck failed"
fi

echo
if [[ "$FAIL" == 0 ]]; then
  if [[ "$WARN" == 1 ]]; then
    echo -e "\033[33m==> check.sh: PASS (with warnings)\033[0m"
  else
    echo -e "\033[32m==> check.sh: PASS\033[0m"
  fi
else
  echo -e "\033[31m==> check.sh: FAIL\033[0m"
fi

exit "$FAIL"
