// Session replay tool — feeds fixture JSON events into POST /event with delays,
// listens on WS for trace/action messages, and checks against `expect`.
// Usage: node replay.js <fixture.json> [more.json...] [--base http://localhost:4000] [--speed 1] [--settle 500]
// Env: AGENT_HTTP (default base), REPLAY_FIXED_SESSION=1 (no per-run session suffix; for cached record/playback)

import fs from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { SESSION_ID_RE } from "./contracts.js";

/**
 * expandGlobs(args) — some shells (notably Windows/cmd, and any shell run
 * with globbing disabled) pass a literal `sessions/*.json` straight through
 * instead of expanding it. Expand any argument containing `*` ourselves via
 * fs.readdirSync on its directory, sorted, so behavior is shell-independent.
 */
function expandGlobs(args) {
  const out = [];
  for (const a of args) {
    if (a.startsWith("--") || !a.includes("*")) {
      out.push(a);
      continue;
    }
    const dir = path.dirname(a) || ".";
    const pattern = path.basename(a);
    const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$");
    const matches = fs
      .readdirSync(dir)
      .filter((f) => re.test(f))
      .sort()
      .map((f) => path.join(dir, f));
    if (matches.length === 0) {
      console.error(`no files match glob: ${a}`);
      process.exit(1);
    }
    out.push(...matches);
  }
  return out;
}

function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv) {
  const files = [];
  let base = process.env.AGENT_HTTP || "http://localhost:4000";
  let speed = 1;
  let settle = 500;
  const expanded = expandGlobs(argv);
  for (let i = 0; i < expanded.length; i++) {
    const a = expanded[i];
    if (a === "--base") {
      const v = expanded[++i];
      if (!v || v.startsWith("--")) {
        console.error(`--base requires a value, got: ${v ?? "(none)"}`);
        process.exit(1);
      }
      base = v;
    } else if (a === "--speed") {
      const v = expanded[++i];
      if (!v || v.startsWith("--") || !Number.isFinite(Number(v)) || Number(v) <= 0) {
        console.error(`--speed requires a positive number, got: ${v ?? "(none)"}`);
        process.exit(1);
      }
      speed = Number(v);
    } else if (a === "--settle") {
      const v = expanded[++i];
      if (!v || v.startsWith("--") || !Number.isFinite(Number(v)) || Number(v) < 0) {
        console.error(`--settle requires a non-negative number, got: ${v ?? "(none)"}`);
        process.exit(1);
      }
      settle = Number(v);
    } else {
      files.push(a);
    }
  }
  return { files, base, speed, settle };
}

function wsUrlFor(base, session) {
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.search = `?session=${encodeURIComponent(session)}`;
  return u.toString();
}

function fmtEvent(ev) {
  const meta = ev.meta ? JSON.stringify(ev.meta) : "";
  return `→ ${ev.type} ${ev.target ?? ""} ${meta}`.trim();
}

function fmtTrace(t) {
  const bullet = t.decision === "noop" ? "◦" : "●";
  return `  ${bullet} ${t.decision} ${Math.round((t.confidence ?? 0) * 100)}% — ${t.why ?? ""}`;
}

function actionMatches(observed, expected) {
  if (observed.action !== expected.action) return false;
  if (expected.target != null && observed.target !== expected.target) return false;
  return true;
}

async function runFixture(file, base, speed, settle) {
  const raw = fs.readFileSync(file, "utf8");
  const fixture = JSON.parse(raw);
  const { events, expect } = fixture;
  const expectedList = Array.isArray(expect) ? expect : [expect];

  // Suffix the session id per run so repeated `node replay.js` invocations
  // against a long-lived server (no restart) never collide with a prior
  // run's cooldown/actedTargets state for the same fixture. Suffix must stay
  // inside the server's session id pattern. REPLAY_FIXED_SESSION=1 disables
  // the suffix — required for cached record→playback (same id both runs).
  const session = process.env.REPLAY_FIXED_SESSION
    ? fixture.session
    : `${fixture.session}_${Date.now().toString(36)}`;
  if (!SESSION_ID_RE.test(session)) {
    throw new Error(`generated session id "${session}" fails SESSION_ID_RE — fixture session id too long/invalid`);
  }

  console.log(`\n=== ${fixture.name || file} (${fixture.description || ""}) session=${session} ===`);

  const wsUrl = wsUrlFor(base, session);
  const ws = new WebSocket(wsUrl);
  const traces = [];
  const actions = [];

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.kind === "trace") {
      traces.push(msg);
      console.log(fmtTrace(msg));
    } else if (msg.kind === "action") {
      actions.push(msg);
      console.log(`  ★ action: ${msg.action} ${msg.target ?? ""}`.trim());
    }
  });

  for (const ev of events) {
    const delay = (ev.delay_ms ?? 0) / speed;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));

    const body = { session, ts: Date.now(), ...ev };
    delete body.delay_ms;

    console.log(fmtEvent(body));

    const res = await fetch(`${base}/event`, {
      method: "POST",
      // x-agent-replay marks this POST as coming from the replay tool itself,
      // not a live browser tab that happens to share the same (pinned)
      // session id. server/index.js uses this, in cached mode only, to
      // ignore interleaved live-tab events for sessions that have a
      // recording — see the comment above the check in index.js.
      headers: { "content-type": "application/json", "x-agent-replay": "1" },
      body: JSON.stringify(body),
    });
    if (res.status === 400) {
      console.log(`  !! 400 from server: ${await res.text()}`);
    }
  }

  await new Promise((r) => setTimeout(r, settle));
  ws.close();

  const nonNoopActions = actions.filter((a) => a.action !== "noop");

  let pass;
  let restraintNote = "";
  if (expectedList.length === 1 && expectedList[0].action === "noop") {
    pass = nonNoopActions.length === 0 && traces.length > 0;
  } else {
    const matchesAll = expectedList.every((exp) =>
      nonNoopActions.some((obs) => actionMatches(obs, exp))
    );
    // Restraint regression: even if every expected action was observed, more
    // non-noop actions than expected means the decider intervened more than
    // it should have — restraint is a first-class requirement, not just
    // "did the right action eventually fire".
    const restrained = nonNoopActions.length <= expectedList.length;
    pass = matchesAll && restrained;
    if (matchesAll && !restrained) {
      restraintNote = ` (restraint regression: ${nonNoopActions.length} non-noop actions, expected ${expectedList.length})`;
    }
  }

  const expStr = expectedList
    .map((e) => `${e.action}${e.target ? " " + e.target : ""}`)
    .join(", ");
  const obsStr = nonNoopActions.length
    ? nonNoopActions.map((a) => `${a.action}${a.target ? " " + a.target : ""}`).join(", ")
    : "(none)";

  console.log(
    `${pass ? "PASS" : "FAIL"} — expected: [${expStr}]  observed: [${obsStr}]${restraintNote}`
  );

  return pass;
}

async function main() {
  const { files, base, speed, settle } = parseArgs(process.argv.slice(2));
  if (files.length === 0) {
    console.error("usage: node replay.js <fixture.json> [more...] [--base url] [--speed n] [--settle ms]");
    process.exit(1);
  }

  let passed = 0;
  for (const file of files) {
    try {
      const ok = await runFixture(file, base, speed, settle);
      if (ok) passed++;
    } catch (err) {
      console.log(`FAIL — error: ${err.message}`);
    }
  }

  console.log(`\n${passed}/${files.length} passed`);
  process.exit(passed === files.length ? 0 : 1);
}

main();
