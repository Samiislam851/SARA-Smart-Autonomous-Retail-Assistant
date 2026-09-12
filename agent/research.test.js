// Research loop acceptance test (server/RESEARCH.md) — plain node script, no
// test runner, same style as coalesce.test.js / probe-policy.test.js. Run
// with `npm run test:research` (node research.test.js).
//
// Spins up three short-lived real servers in turn (stub+debug, plain stub,
// cached+debug), drives a hesitation sequence, and exercises every research
// endpoint end to end, then cleans up the sessions/live/ files it created.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function startServer(env, port) {
  const child = spawn(process.execPath, ["index.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), ...env },
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
    server.child.kill();
  });
}

function liveFile(session) {
  return path.join(__dirname, "sessions", "live", `${session}.json`);
}

function cleanupLive(prefixes) {
  const dir = path.join(__dirname, "sessions", "live");
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const f of entries) {
    if (prefixes.some((p) => f.startsWith(p))) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        // already gone
      }
    }
  }
}

async function testLiveRecordAndResearchApi() {
  const PORT = 4801;
  const SESSION = "s_test1";
  const server = startServer({ AGENT_MODE: "stub", AGENT_DEBUG: "1", AGENT_STUB_DELAY_MS: "300" }, PORT);
  try {
    await waitForHealth(server.base, 15000);

    // Drive the sizing-hesitation fixture's events as LIVE traffic — no
    // x-agent-replay header, so this takes the coalesced path, same as a
    // real browser tab.
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

    const file = liveFile(SESSION);
    assert.ok(fs.existsSync(file), `expected a live recording file at ${file}`);
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(rec.events.length, fixture.events.length, "recorded event count should match the fixture");
    assert.ok(rec.decisions.length >= 1, "expected at least one recorded decision");
    const delivered = rec.decisions.find((d) => d.delivered);
    assert.ok(delivered, "expected at least one delivered:true decision (the sizing-hesitation card)");
    console.log(`(i) ok — live file: ${rec.events.length} events, ${rec.decisions.length} decisions, delivered "${delivered.decided}"`);

    const listRes = await fetch(`${server.base}/sessions?limit=50`);
    assert.equal(listRes.status, 200);
    const list = await listRes.json();
    const entry = list.find((s) => s.session === SESSION);
    assert.ok(entry, "expected s_test1 in GET /sessions");
    assert.equal(entry.events, rec.events.length);
    assert.equal(entry.decisions, rec.decisions.length);
    assert.equal(entry.interventions, rec.decisions.filter((d) => d.delivered).length);
    assert.ok(Array.isArray(entry.pages) && entry.pages.length >= 1, "expected at least one page in pages[]");
    assert.ok(entry.lastDecision && typeof entry.lastDecision.decided === "string");
    console.log("(ii) ok — GET /sessions lists s_test1 with matching counts");

    const labelRes = await fetch(`${server.base}/sessions/${SESSION}/labels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ atEventIndex: delivered.eventIndex, expected: "help", note: "sizing hesitation confirmed" }),
    });
    assert.equal(labelRes.status, 200, `label POST expected 200, got ${labelRes.status}`);
    const labelJson = await labelRes.json();
    assert.equal(labelJson.labels.length, 1);
    assert.equal(labelJson.labels[0].expected, "help");
    console.log("(iii) ok — session labelled");

    const badLabelRes = await fetch(`${server.base}/sessions/${SESSION}/labels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ atEventIndex: 0, expected: "bogus" }),
    });
    assert.equal(badLabelRes.status, 400, "bad `expected` value should 400");
    console.log("(iv) ok — bad label value rejected with 400");

    const delLabelRes = await fetch(`${server.base}/sessions/${SESSION}/labels/9`, { method: "DELETE" });
    assert.equal(delLabelRes.status, 400, "out-of-range label index should 400");
    console.log("(v) ok — DELETE out-of-range label index rejected with 400");

    const replayRes = await fetch(`${server.base}/sessions/${SESSION}/replay`, { method: "POST" });
    assert.equal(replayRes.status, 202, `replay POST expected 202, got ${replayRes.status}`);
    const { job, shadowSession } = await replayRes.json();
    assert.ok(job && shadowSession, "expected job + shadowSession in replay response");

    const dupReplayRes = await fetch(`${server.base}/sessions/${SESSION}/replay`, { method: "POST" });
    assert.equal(dupReplayRes.status, 409, "a second concurrent replay for the same session should 409");
    console.log("(vi) ok — concurrent replay for the same session rejected with 409");

    let jobResult;
    const jobDeadline = Date.now() + 15000;
    for (;;) {
      const r = await fetch(`${server.base}/sessions/${SESSION}/replay/${job}`);
      assert.equal(r.status, 200);
      jobResult = await r.json();
      if (jobResult.state !== "running") break;
      if (Date.now() > jobDeadline) throw new Error("replay job did not finish in time");
      await sleep(200);
    }
    assert.equal(jobResult.state, "done", `expected replay job done, got: ${JSON.stringify(jobResult)}`);
    assert.ok(jobResult.decisions.length > 0, "expected non-empty shadow decisions");
    console.log(`(vii) ok — replay job ${job} done, ${jobResult.decisions.length} shadow decisions (shadow=${shadowSession})`);

    assert.ok(!fs.existsSync(liveFile(shadowSession)), "shadow (rp_*) session must not produce a live file");
    console.log("(viii) ok — shadow replay session produced no live file");

    const decideRes = await fetch(`${server.base}/session/${SESSION}/decide`, { method: "POST" });
    assert.equal(decideRes.status, 200, `forced decide expected 200, got ${decideRes.status}`);
    const decideJson = await decideRes.json();
    assert.ok(decideJson.action && decideJson.trace, "forced decide should return action + trace");
    console.log("(ix) ok — forced decide returned action + trace");

    const fixtureRes = await fetch(`${server.base}/sessions/${SESSION}/fixture`);
    assert.equal(fixtureRes.status, 200);
    const exportedFixture = await fixtureRes.json();
    assert.equal(exportedFixture.session, SESSION);
    assert.ok(Array.isArray(exportedFixture.events) && exportedFixture.events.length > 0);
    // decide/stub.js's sizing-hesitation rule now proposes a `card` (the
    // one-tap pick_size action), not a `highlight` — see server/decide/stub.js.
    assert.deepEqual(exportedFixture.expect, { action: "card", target: "size-guide" });
    console.log(`(x) ok — exported fixture: expect=${JSON.stringify(exportedFixture.expect)}`);

    const tmpFixturePath = path.join(__dirname, `.research-test-fixture-${Date.now()}.json`);
    fs.writeFileSync(tmpFixturePath, JSON.stringify(exportedFixture, null, 2));
    try {
      const replayResult = spawnSync(process.execPath, ["replay.js", tmpFixturePath, "--base", server.base], {
        cwd: __dirname,
        encoding: "utf8",
      });
      console.log(replayResult.stdout);
      if (replayResult.stderr) console.error(replayResult.stderr);
      assert.equal(replayResult.status, 0, "exported fixture should PASS through replay.js");
      console.log("(xi) ok — exported fixture PASSES through replay.js");
    } finally {
      fs.unlinkSync(tmpFixturePath);
    }

    const fxSession = "fx_research_probe";
    await fetch(`${server.base}/event`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: fxSession, type: "page_view", target: "/", ts: Date.now(), meta: { targets: [] } }),
    });
    await sleep(500);
    assert.ok(!fs.existsSync(liveFile(fxSession)), "fx_* session must not produce a live file");
    console.log("(xii) ok — fx_* session produced no live file");
  } finally {
    await stopServer(server);
    cleanupLive(["s_test1", "fx_research_probe"]);
  }
}

async function testDebugGated404() {
  const PORT = 4802;
  const server = startServer({ AGENT_MODE: "stub" }, PORT);
  try {
    await waitForHealth(server.base, 15000);
    const checks = [
      ["GET", "/sessions"],
      ["GET", "/sessions/s_test1"],
      ["POST", "/sessions/s_test1/labels"],
      ["DELETE", "/sessions/s_test1/labels/0"],
      ["GET", "/sessions/s_test1/fixture"],
      ["POST", "/sessions/s_test1/replay"],
      ["GET", "/sessions/s_test1/replay/job_x"],
      ["POST", "/session/s_test1/decide"],
    ];
    for (const [method, route] of checks) {
      const res = await fetch(`${server.base}${route}`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      assert.equal(res.status, 404, `${method} ${route} expected 404 without AGENT_DEBUG, got ${res.status}`);
    }
    console.log("(xiii) ok — every research route 404s without AGENT_DEBUG");
  } finally {
    await stopServer(server);
  }
}

async function testCachedMode409sAndFixturesStillPass() {
  const PORT = 4803;
  const server = startServer({ AGENT_MODE: "cached", AGENT_DEBUG: "1" }, PORT);
  try {
    await waitForHealth(server.base, 15000);

    const decideRes = await fetch(`${server.base}/session/fx_sizing_hesitation/decide`, { method: "POST" });
    assert.equal(decideRes.status, 409, `cached-mode forced decide expected 409, got ${decideRes.status}`);
    const replayRes = await fetch(`${server.base}/sessions/fx_sizing_hesitation/replay`, { method: "POST" });
    assert.equal(replayRes.status, 409, `cached-mode replay expected 409, got ${replayRes.status}`);
    console.log("(xiv) ok — cached mode: forced decide and replay both 409");

    const cachedFixtures = ["sizing-hesitation", "cart-threshold", "facts-threshold", "happy-browsing"].map((n) =>
      path.join(__dirname, "sessions", `${n}.json`)
    );
    const cachedReplay = spawnSync(process.execPath, ["replay.js", ...cachedFixtures, "--base", server.base, "--speed", "10"], {
      cwd: __dirname,
      encoding: "utf8",
      env: { ...process.env, REPLAY_FIXED_SESSION: "1" },
    });
    console.log(cachedReplay.stdout);
    if (cachedReplay.stderr) console.error(cachedReplay.stderr);
    assert.equal(cachedReplay.status, 0, "expected 4/4 recorded fixtures to still PASS in cached mode");
    console.log("(xv) ok — 4/4 recorded fixtures pass in cached mode");
  } finally {
    await stopServer(server);
    // The 4 fx_* cached-mode sessions above are never live-recorded (fx_
    // prefix), but AGENT_DEBUG=1 was set — nothing to clean up, this is
    // just a defensive no-op matching the other two phases' shape.
    cleanupLive(["fx_cart_threshold", "fx_facts_threshold", "fx_happy_browsing", "fx_sizing_hesitation"]);
  }
}

async function main() {
  await testLiveRecordAndResearchApi();
  await testDebugGated404();
  await testCachedMode409sAndFixturesStillPass();
  console.log("\nresearch.test: all assertions passed");
}

main().catch((err) => {
  console.error("research.test FAILED:", err);
  process.exitCode = 1;
});
