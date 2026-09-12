// Decision-coalescing acceptance test — plain node script, no test runner
// (same style as probe-policy.test.js). Run with `npm run test:coalesce`
// (node coalesce.test.js).
//
// Reproduces the defect this pass fixes: a burst of events for one session
// (dwell heartbeats every few seconds) used to run one decider call PER
// EVENT, serially per session — with a slow decider (14s/call live, ~3s
// here) the per-session chain backed up, the queue cap filled within
// seconds, and every later event was rejected with "event rejected: session
// queue too deep". This test starts a real server (AGENT_MODE=stub,
// AGENT_STUB_DELAY_MS=3000 — see decide/stub.js for the test-only artificial
// latency), fires 30 events for one session within 5s, and asserts:
//   - every POST /event returns 200 in well under 200ms (the widget never
//     waits on the model — the whole point of this pass);
//   - decisionsStarted stays low (<=3) instead of 30 — coalescing, not one
//     decision per event;
//   - coalesced is high (>=25) — most events folded into an in-flight or
//     pending decision instead of starting their own;
//   - no "queue too deep" log line — there's no per-session queue depth to
//     exceed any more (AGENT_MAX_QUEUE_PER_SESSION was removed);
//   - the final trace (from the last decision that ran) reflects the
//     latest state, not a stale one — checked via the trace's `signals`
//     count matching all 30 pushed events.

import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 4751;
const BASE = `http://localhost:${PORT}`;
const SESSION = "coalesce_test_session";
const N_EVENTS = 30;
const BURST_WINDOW_MS = 5000;

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

async function main() {
  const serverLog = [];
  const child = spawn(process.execPath, ["index.js"], {
    cwd: new URL(".", import.meta.url).pathname,
    env: {
      ...process.env,
      PORT: String(PORT),
      AGENT_MODE: "stub",
      AGENT_STUB_DELAY_MS: "3000",
      AGENT_METRICS_RESET: "1",
      AGENT_DEBUG: "1", // needed by the S3 (reset-mid-flight) case below: DELETE /session/:id
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => serverLog.push(d.toString()));
  child.stderr.on("data", (d) => serverLog.push(d.toString()));

  let exitedEarly = false;
  child.on("exit", (code) => {
    if (code !== null && code !== 0) exitedEarly = true;
  });

  try {
    await waitForHealth(15_000);

    // Fresh counters for this run.
    await fetch(`${BASE}/metrics/reset`, { method: "POST" });

    const ws = new WebSocket(`ws://localhost:${PORT}/?session=${SESSION}`);
    const traces = [];
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.kind === "trace") traces.push(msg);
      } catch {
        // ignore
      }
    });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });

    const postLatencies = [];
    const start = Date.now();
    for (let i = 0; i < N_EVENTS; i++) {
      const ev = {
        session: SESSION,
        type: i === 0 ? "page_view" : "dwell",
        target: i === 0 ? "/product/khadi-field-jacket" : null,
        meta: i === 0 ? { targets: ["size-guide"] } : { ms: 1000 * (i + 1) },
      };
      const t0 = Date.now();
      const res = await fetch(`${BASE}/event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ev),
      });
      const latency = Date.now() - t0;
      postLatencies.push(latency);
      assert.equal(res.status, 200, `event ${i} expected 200, got ${res.status}`);
      const body = await res.json();
      assert.equal(body.ok, true, `event ${i} expected ok:true`);
      assert.ok("queued" in body, `event ${i} response should carry a queued flag`);
    }
    const totalBurstMs = Date.now() - start;
    assert.ok(
      totalBurstMs <= BURST_WINDOW_MS + 2000,
      `expected the 30-event burst to fire in ~${BURST_WINDOW_MS}ms, took ${totalBurstMs}ms (POSTs themselves are slow — coalescing broken)`
    );

    const maxLatency = Math.max(...postLatencies);
    assert.ok(
      maxLatency < 200,
      `expected every POST to return in <200ms (never wait on the model), slowest was ${maxLatency}ms: ${JSON.stringify(postLatencies)}`
    );

    // Let any in-flight/pending decision finish (up to two ~3s decider
    // calls plus slack) before reading final metrics/trace.
    await sleep(3000 * 2 + 1000);

    const metrics = await (await fetch(`${BASE}/metrics`)).json();
    assert.ok(
      metrics.decisionsStarted <= 3,
      `expected decisionsStarted <= 3 (coalesced, not one per event), got ${metrics.decisionsStarted}`
    );
    assert.ok(
      metrics.coalesced >= 25,
      `expected coalesced >= 25 (most of the 30 events folded into a pending decision), got ${metrics.coalesced}`
    );

    const fullLog = serverLog.join("");
    assert.ok(
      !fullLog.includes("queue too deep"),
      "no per-session queue depth to exceed any more — 'queue too deep' must never appear in the log"
    );
    assert.ok(!exitedEarly, "server process must not have exited during the test");

    assert.ok(traces.length > 0, "expected at least one trace broadcast over WS");
    const lastTrace = traces[traces.length - 1];
    // summarize() (state.js) caps signals at the last 6 events — check the
    // final trace reflects the LAST event pushed (30s dwell), not a stale
    // mid-burst one, which is what "decide against the now-current state"
    // means in practice.
    assert.ok(
      Array.isArray(lastTrace.signals) && lastTrace.signals.some((s) => s.includes("30s")),
      `expected the final trace's signals to reflect the latest (30s dwell) event, got ${JSON.stringify(lastTrace.signals)}`
    );

    const stateRes = await fetch(`${BASE}/state/${SESSION}`);
    const state = await stateRes.json();
    assert.equal(
      state.dwell.pageMs,
      1000 * N_EVENTS,
      "GET /state should reflect the last pushed event immediately (processEventCore is synchronous, never queued)"
    );

    ws.close();

    // ---- S2: priority-based pendingEv selection ----------------------------
    // A rage_click folded in behind a burst of dwell heartbeats must survive
    // as the pending run's event — not get displaced by a LATER, lower-
    // priority dwell tick (the "non-dwell trigger swallowed by coalescing"
    // defect class). Sequence: dwell (starts the in-flight decision) ->
    // dwell (folds in as pendingEv) -> rage_click (must REPLACE pendingEv,
    // higher priority) -> dwell (must NOT replace it back).
    {
      const SESSION2 = "coalesce_test_priority";
      const post = (type, target, meta) =>
        fetch(`${BASE}/event`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: SESSION2, type, target, meta }),
        });

      await post("page_view", "/product/x", { targets: ["size-guide"] }); // starts the 3s in-flight decision
      await sleep(200);
      await post("dwell", null, { ms: 1000 }); // folds in as pendingEv (dwell)
      await sleep(200);
      await post("rage_click", "cart-add", { count: 3 }); // must REPLACE pendingEv (higher priority)
      await sleep(200);
      await post("dwell", null, { ms: 2000 }); // must NOT displace rage_click back

      // Wait for both decisions (in-flight ~3s + pending ~3s + slack).
      await sleep(3000 * 2 + 1500);

      const fullLog2 = serverLog.join("");
      const decisionLines = fullLog2
        .split("\n")
        .filter((l) => l.includes('"msg":"decision"') && l.includes(`"session":"${SESSION2}"`));
      assert.equal(decisionLines.length, 2, `expected exactly 2 decisions for ${SESSION2} (1 in-flight + 1 pending), got ${decisionLines.length}: ${JSON.stringify(decisionLines)}`);
      const secondDecision = JSON.parse(decisionLines[1]);
      assert.equal(
        secondDecision.event,
        "rage_click",
        `expected the PENDING run to decide against the higher-priority rage_click event (not the later, lower-priority dwell), got ${JSON.stringify(secondDecision)}`
      );
      console.log("S2 ok — pendingEv priority selection: pending run decided against", secondDecision.event);
    }

    // ---- S3: reset-mid-flight must not produce overlapping decisions ------
    // event -> reset (mid-flight, in-flight decision can't be cancelled) ->
    // two more events. The reset must cancel the coalesce record IN PLACE
    // (not delete it), so the still-running loop tears itself down instead
    // of a second loop starting concurrently for the same session.
    {
      const SESSION3 = "coalesce_test_reset";
      const post = (type, target, meta) =>
        fetch(`${BASE}/event`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: SESSION3, type, target, meta }),
        });

      const before = await (await fetch(`${BASE}/metrics`)).json();

      await post("page_view", "/product/y", { targets: ["size-guide"] }); // starts a 3s in-flight decision
      await sleep(100);
      const resetRes = await fetch(`${BASE}/session/${SESSION3}`, { method: "DELETE" });
      assert.equal(resetRes.status, 200, "DELETE /session/:id (AGENT_DEBUG=1) should succeed");
      await post("dwell", null, { ms: 1000 });
      await sleep(100);
      await post("dwell", null, { ms: 2000 });

      // Let the original (uncancelable) in-flight decision finish, plus any
      // legitimate fresh decision the post-reset events eventually start.
      await sleep(3000 * 2 + 2000);

      const after = await (await fetch(`${BASE}/metrics`)).json();
      assert.equal(
        (after.overlappingDecisions || 0) - (before.overlappingDecisions || 0),
        0,
        "reset-mid-flight must never produce two concurrent decideAndBroadcast calls for the same session (overlappingDecisions tripwire)"
      );
      assert.ok(
        typeof after.inFlightSessions === "number",
        "inFlightSessions gauge should be exposed on /metrics"
      );
      assert.equal(after.inFlightSessions, 0, "no decision should still be in flight once everything above has settled");
      console.log("S3 ok — reset-mid-flight produced no overlapping decisions", {
        overlappingDecisions: after.overlappingDecisions,
        inFlightSessions: after.inFlightSessions,
      });
    }

    console.log("coalesce.test: all assertions passed", {
      decisionsStarted: metrics.decisionsStarted,
      coalesced: metrics.coalesced,
      pendingRuns: metrics.pendingRuns,
      maxPostLatencyMs: maxLatency,
      totalBurstMs,
    });
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    // This test's AGENT_DEBUG:"1" env (needed for the S3 DELETE
    // /session/:id case) also turns on live-record.js (server/RESEARCH.md) —
    // its three plain-string session ids (SESSION/SESSION2/SESSION3 above)
    // aren't fx_*/rp_*, so they get recorded to sessions/live/*.json same as
    // any real session would. Clean those up so repeat runs don't leave
    // test artifacts behind (this test's own concern, no reader of
    // sessions/live/ should ever expect these).
    for (const s of [SESSION, "coalesce_test_priority", "coalesce_test_reset"]) {
      try {
        fs.unlinkSync(new URL(`./sessions/live/${s}.json`, import.meta.url));
      } catch {
        // never got created, or already gone — fine
      }
    }
  }
}

main().catch((err) => {
  console.error("coalesce.test: FAILED —", err.message);
  process.exit(1);
});
