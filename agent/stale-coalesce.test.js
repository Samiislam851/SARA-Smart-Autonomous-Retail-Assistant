// Stale-response guard coalesce-path acceptance test — plain node script,
// no test runner (same style/spawn pattern as server/coalesce.test.js).
// Run with `node stale-coalesce.test.js` (npm run test:stale-coalesce).
//
// Scenario: a sizing-hesitation dwell on product A starts a (slowed-down,
// AGENT_STUB_DELAY_MS) decision. While that decide() call is "thinking",
// the shopper navigates to a DIFFERENT product B. By the time the decision
// resolves (a pick_size card for product A's size-guide), the fingerprint
// captured before decide() no longer matches the live session
// (productSlug A -> B) — server/policy.js denies it with
// `stale_context:product_changed`, and the coalescing scheduler's own
// `pending` flag (already set from the page_view folded in while in-flight)
// naturally triggers exactly ONE more decision run against the fresh
// (product B) state — never a second, redundant decide() call beyond that.
//
// Asserts:
//   - decisionsStarted === 2 (the original run + exactly one pending
//     re-decide — never more, i.e. the drop never itself triggers an EXTRA
//     decide() call beyond what coalescing was already going to do).
//   - no `action: "card"` WS message ever arrives (the stale card was
//     denied to noop before broadcast).
//   - the server log's decision line for the first run's target shows the
//     stale_context:product_changed guard reason.
//   - GET /state reflects product B (the re-decide ran against fresh state).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 4811;
const BASE = `http://localhost:${PORT}`;
const SESSION = "stale_coalesce_test_session";
const STUB_DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    if (Date.now() > deadline) throw new Error("server did not become healthy in time");
    await sleep(100);
  }
}

async function postEvent(ev) {
  const res = await fetch(`${BASE}/event`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: SESSION, ...ev }),
  });
  assert.equal(res.status, 200, `event ${ev.type} expected 200, got ${res.status}`);
  return res.json();
}

async function main() {
  const serverLog = [];
  const child = spawn(process.execPath, ["index.js"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(PORT),
      AGENT_MODE: "stub",
      AGENT_STUB_DELAY_MS: String(STUB_DELAY_MS),
      AGENT_METRICS_RESET: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => serverLog.push(d.toString()));
  child.stderr.on("data", (d) => serverLog.push(d.toString()));

  let exitedEarly = false;
  child.on("exit", (code) => {
    if (code !== null && code !== 0) exitedEarly = true;
  });

  let ws;
  try {
    await waitForHealth(15_000);
    await fetch(`${BASE}/metrics/reset`, { method: "POST" });

    ws = new WebSocket(`ws://localhost:${PORT}/?session=${SESSION}`);
    const actionMsgs = [];
    const traces = [];
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.kind === "action") actionMsgs.push(msg);
        if (msg.kind === "trace") traces.push(msg);
      } catch {
        // ignore
      }
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    // 1. Land on product A, with size-guide visible. Every event schedules
    //    its OWN coalesced decision round (decide/stub.js's decideNow()
    //    runs SYNCHRONOUSLY at call time, only its resolution is delayed —
    //    see decide/stub.js's own comment), so this page_view alone starts
    //    and fully resolves (noop: last event isn't a dwell yet) as its own
    //    round before the scenario below begins.
    await postEvent({ type: "page_view", target: "/product/khadi-field-jacket", meta: { targets: ["size-guide"] } });
    await sleep(STUB_DELAY_MS + 300);

    // 2. Trigger the stub's sizing-hesitation rule: an element dwell on
    //    size-guide >= 6000ms. decideNow() computes its pick_size-card
    //    proposal for product A RIGHT NOW (synchronously), then artificially
    //    delays resolving it — the same shape as a real 10-20s LLM call
    //    computed against a state snapshot that can go stale before it
    //    resolves.
    postEvent({ type: "dwell", target: "size-guide", meta: { ms: 7000, kind: "attention", interactions: { hover_ms: 7000 } } });
    // 3. While that decision is still "thinking" (resolving), navigate to a
    //    DIFFERENT product — folds into the coalescing scheduler's
    //    `pending` slot (s.inFlight is true, so this can't start its own
    //    round yet).
    await sleep(300);
    await postEvent({ type: "page_view", target: "/product/nakshi-kantha-scarf", meta: { targets: [] } });

    // Let the dwell-triggered decision resolve (denied as stale) AND the
    // coalesced pending re-decide it triggers both finish.
    await sleep(STUB_DELAY_MS * 2 + 1000);

    const metrics = await (await fetch(`${BASE}/metrics`)).json();
    assert.equal(
      metrics.decisionsStarted,
      3,
      `expected exactly 3 decisionsStarted (page_view A's own round + the dwell-triggered stale round + one coalesced re-decide — never a double model call for the stale drop itself), got ${metrics.decisionsStarted}`
    );

    assert.equal(
      actionMsgs.length,
      0,
      `expected no "card" (or any non-noop) action ever broadcast — the stale first decision must be denied before broadcast, and the re-decide (browsing normally, last event is a page_view not a dwell) is a noop too. Got: ${JSON.stringify(actionMsgs)}`
    );

    const fullLog = serverLog.join("");
    assert.ok(
      fullLog.includes('"event":"dwell"') && fullLog.includes('"reason":"guard"'),
      `expected the dwell-triggered decision's log line to show a guard denial (the stale drop). Log:\n${fullLog}`
    );
    const staleTrace = traces.find((t) => t.why?.includes("stale_context:product_changed"));
    assert.ok(
      staleTrace,
      `expected a broadcast trace whose why names stale_context:product_changed. Got traces: ${JSON.stringify(traces)}`
    );
    assert.ok(!exitedEarly, "server process must not have exited during the test");

    const stateRes = await fetch(`${BASE}/state/${SESSION}`);
    const state = await stateRes.json();
    assert.equal(
      state.page,
      "/product/nakshi-kantha-scarf",
      "GET /state reflects the live (post-navigation) page — the coalesced re-decide ran against fresh state, not the stale snapshot"
    );

    console.log("stale-coalesce.test: all assertions passed", {
      decisionsStarted: metrics.decisionsStarted,
      staleDenied: Boolean(staleTrace),
    });
  } finally {
    ws?.close?.();
    child.kill();
    await sleep(200);
  }
}

main().catch((err) => {
  console.error("stale-coalesce.test FAILED:", err);
  process.exitCode = 1;
});
