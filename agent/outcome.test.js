// Outcome tracking acceptance test (server/RESEARCH.md "Outcomes" section) —
// plain node script, no test runner, same style as research.test.js /
// probe-policy.test.js. Run with `npm run test:outcome` (node outcome.test.js).
//
// Drives the sizing-hesitation fixture's events as live traffic (stub mode,
// deterministic card at target "size-guide") against a real short-lived
// server, reads the card action's server-assigned id back off
// GET /sessions/:id, posts an agent_outcome "cta" event for it, and asserts:
//   (a) the outcome event never triggers a decision (decisions.length
//       unchanged before/after posting it);
//   (b) GET /sessions/:id joins the outcome onto the matching decision;
//   (c) GET /sessions/stats reports cta_rate: 1 for the card action type;
//   (d) a duplicate outcome report for the same action id is ignored (not
//       double-counted).
//
// Isolation: the server under test is spawned with its OWN temp `cwd`, so
// live-record.js's `sessions/live/` (cwd-relative — see that module) is a
// throwaway directory, never this repo's real server/sessions/live/ (which
// on a real dev machine already has hundreds of files — aggregating
// /sessions/stats against those would make the exact cta_rate:1 assertion
// flaky/wrong, not a property of this test). Test server port is 4907
// (>= 4900 per the port-allocation convention), killed by PID on exit.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4907;
const SESSION = "s_outcome_test1";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(base, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server at ${base} did not become healthy in time`);
    await sleep(100);
  }
}

function startServer(cwd, port) {
  const child = spawn(process.execPath, [path.join(__dirname, "index.js")], {
    cwd,
    env: { ...process.env, PORT: String(port), AGENT_MODE: "stub", AGENT_DEBUG: "1", AGENT_STUB_DELAY_MS: "300" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = [];
  child.stdout.on("data", (d) => log.push(d.toString()));
  child.stderr.on("data", (d) => log.push(d.toString()));
  return { child, log, base: `http://localhost:${port}` };
}

function stopServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    if (server.child.exitCode !== null) return resolve();
    server.child.once("exit", () => resolve());
    server.child.kill(); // by PID (child.pid) — server/OPS.md convention
  });
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-outcome-test-"));
  let server;
  let exampleOutcomeEvent = null;
  try {
    server = startServer(tmpDir, PORT);
    await waitForHealth(server.base, 15000);

    // Drive the sizing-hesitation fixture's events as LIVE traffic (no
    // x-agent-replay header — same coalesced path a real browser tab
    // takes), under a plain (non-fx_/rp_) session id so live-record.js
    // actually records it.
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "sessions", "sizing-hesitation.json"), "utf8"));
    for (const ev of fixture.events) {
      if (ev.delay_ms) await sleep(ev.delay_ms);
      const body = { session: SESSION, ts: Date.now(), ...ev };
      delete body.delay_ms;
      const res = await fetch(`${server.base}/event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200, `event POST expected 200, got ${res.status}`);
    }
    // Let the last coalesced/pending decision (300ms stub delay) settle.
    await sleep(1500);

    const before = await (await fetch(`${server.base}/sessions/${SESSION}`)).json();
    const cardDecision = before.decisions.find((d) => d.delivered && d.action?.action === "card");
    assert.ok(cardDecision, "expected a delivered card decision from the sizing-hesitation fixture");
    assert.ok(cardDecision.action.id, "expected the card action to carry a server-assigned id");
    assert.equal(cardDecision.outcome, null, "expected no outcome yet for a freshly delivered card");
    const decisionsCountBefore = before.decisions.length;
    console.log(`(i) ok — got delivered card action id=${cardDecision.action.id} target=${cardDecision.action.target}`);

    const actionId = cardDecision.action.id;
    exampleOutcomeEvent = {
      session: SESSION,
      type: "agent_outcome",
      target: cardDecision.action.target,
      ts: Date.now(),
      meta: {
        action_id: actionId,
        action: "card",
        cta_kind: cardDecision.action.card?.cta?.kind,
        outcome: "cta",
        ms_visible: 4200,
      },
    };

    const outcomeRes = await fetch(`${server.base}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(exampleOutcomeEvent),
    });
    assert.equal(outcomeRes.status, 200, `agent_outcome POST expected 200, got ${outcomeRes.status}`);
    const outcomeBody = await outcomeRes.json();
    assert.equal(outcomeBody.ok, true);
    assert.equal(outcomeBody.duplicate, false, "first report for this action id should not be a duplicate");
    console.log("(ii) ok — agent_outcome \"cta\" accepted");

    // (a) never triggers a decision.
    const after = await (await fetch(`${server.base}/sessions/${SESSION}`)).json();
    assert.equal(
      after.decisions.length,
      decisionsCountBefore,
      "posting agent_outcome must never itself trigger a new decision"
    );
    console.log("(iii) ok — agent_outcome triggered no new decision");

    // (b) GET /sessions/:id joins the outcome by action id.
    const joined = after.decisions.find((d) => d.action?.id === actionId);
    assert.ok(joined, "expected the same decision (by action id) still present");
    assert.equal(joined.outcome, "cta", "expected the decision's outcome to be joined from the recorded outcome");
    console.log("(iv) ok — GET /sessions/:id joins outcome=\"cta\" onto the decision");

    // (c) GET /sessions/stats — cta_rate: 1 for the card action type (the
    // test server's own temp cwd means this aggregate is exactly this
    // test's one delivered card, nothing else).
    const stats = await (await fetch(`${server.base}/sessions/stats`)).json();
    assert.equal(stats.totalActionsShown, 1, "expected exactly one delivered non-noop action across this isolated server");
    assert.ok(stats.byActionType.card, "expected a byActionType.card bucket");
    assert.equal(stats.byActionType.card.shown, 1);
    assert.equal(stats.byActionType.card.outcomes.cta, 1);
    assert.equal(stats.byActionType.card.cta_rate, 1, "expected cta_rate 1 for the card action type");
    assert.equal(stats.byActionType.card.dismiss_rate, 0);
    console.log("(v) ok — GET /sessions/stats reports cta_rate: 1 for action type \"card\"");

    // (d) duplicate outcome for the same action id is ignored.
    const dupRes = await fetch(`${server.base}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...exampleOutcomeEvent, ts: Date.now(), meta: { ...exampleOutcomeEvent.meta, outcome: "dismiss" } }),
    });
    assert.equal(dupRes.status, 200);
    const dupBody = await dupRes.json();
    assert.equal(dupBody.ok, true);
    assert.equal(dupBody.duplicate, true, "a second report for an already-reported action id should be flagged duplicate");
    const statsAfterDup = await (await fetch(`${server.base}/sessions/stats`)).json();
    assert.equal(statsAfterDup.byActionType.card.outcomes.cta, 1, "duplicate must not change the recorded outcome");
    assert.equal(statsAfterDup.byActionType.card.outcomes.dismiss, 0, "duplicate (a different outcome kind) must still be ignored");
    console.log("(vi) ok — duplicate outcome for the same action id ignored");

    console.log("\nPASS — outcome.test.js");
    console.log("\nExample agent_outcome event posted:");
    console.log(JSON.stringify(exampleOutcomeEvent, null, 2));
  } finally {
    await stopServer(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("FAIL —", err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
