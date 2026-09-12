// Cost measurement script — no deps. Resets server-side metrics, replays the
// three fixtures against a running server (AGENT_MODE=llm), reads back
// /metrics, prints a comparison row, and saves the raw run as JSON.
//
// The script does NOT start/stop the server (LLM_CACHE is an env var read
// once at process start in decide/llm.js, so a cache-off vs cache-on
// comparison needs two separate server processes) — see server/NOTES.md
// "Cost design" for the exact recipe (three server starts: cache-off,
// cache-cold, cache-warm).
//
// Usage:
//   node cost-compare.js --label cache-off [--base http://localhost:4000]
//     [--price-in 0.10] [--price-out 0.40] [--sessions 1000000]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fail(msg, code = 1) {
  console.error(`[cost-compare] ERROR: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    base: process.env.AGENT_HTTP || "http://localhost:4000",
    priceIn: 0.05,
    priceOut: 0.4,
    sessions: 1_000_000,
    label: null,
    speed: 2,
    settle: 15000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") opts.base = argv[++i];
    else if (a === "--price-in") opts.priceIn = Number(argv[++i]);
    else if (a === "--price-out") opts.priceOut = Number(argv[++i]);
    else if (a === "--sessions") opts.sessions = Number(argv[++i]);
    else if (a === "--label") opts.label = argv[++i];
    else if (a === "--speed") opts.speed = Number(argv[++i]);
    else if (a === "--settle") opts.settle = Number(argv[++i]);
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(1);
    }
  }
  if (!opts.label) {
    console.error("usage: node cost-compare.js --label <name> [--base url] [--price-in n] [--price-out n] [--sessions n]");
    process.exit(1);
  }
  // Minor #7: every numeric flag must be a finite number — a typo'd or
  // missing value (e.g. `--price-in` at the end of argv) silently produces
  // NaN today, which then poisons the cost formula and prints "$NaN" with
  // exit code 0, looking like a successful (if odd) measurement.
  for (const [name, val] of [
    ["--price-in", opts.priceIn],
    ["--price-out", opts.priceOut],
    ["--sessions", opts.sessions],
    ["--speed", opts.speed],
    ["--settle", opts.settle],
  ]) {
    if (!Number.isFinite(val)) fail(`${name} must be a finite number, got: ${val}`);
  }
  return opts;
}

async function resetMetrics(base) {
  const res = await fetch(`${base}/metrics/reset`, { method: "POST" });
  if (!res.ok) {
    // M2: /metrics/reset now 404s unless the server was started with
    // AGENT_METRICS_RESET=1. A cost-compare run against a server missing
    // that env var would otherwise silently measure on top of whatever
    // counters already existed from prior traffic — loud failure instead.
    fail(
      `POST /metrics/reset failed: ${res.status}. Start the server with AGENT_METRICS_RESET=1 ` +
        `(the reset route 404s otherwise — see server/NOTES.md's measurement recipe).`,
      2
    );
  }
}

async function getMetrics(base) {
  const res = await fetch(`${base}/metrics`);
  if (!res.ok) throw new Error(`GET /metrics failed: ${res.status}`);
  return res.json();
}

/** Runs the three fixtures as a child `node replay.js` process, capturing
 * stdout so we can report per-fixture PASS/FAIL alongside the cost numbers. */
function runFixturesChild(base, speed, settle) {
  return new Promise((resolve, reject) => {
    const replayPath = path.join(__dirname, "replay.js");
    const sessionsGlob = path.join(__dirname, "sessions", "*.json");
    const args = [replayPath, sessionsGlob, "--base", base, "--speed", String(speed), "--settle", String(settle)];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      out += d.toString();
      process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** Parses replay.js's own PASS/FAIL lines into { fixtureName: "PASS"|"FAIL" }. */
function parseFixtureVerdicts(out) {
  const verdicts = {};
  const lines = out.split("\n");
  let currentFixture = null;
  for (const line of lines) {
    const header = line.match(/^=== (\S+)/);
    if (header) currentFixture = header[1];
    const verdict = line.match(/^(PASS|FAIL)\b/);
    if (verdict && currentFixture) {
      verdicts[currentFixture] = verdict[1];
      currentFixture = null;
    }
  }
  return verdicts;
}

function fmtUsd(n) {
  if (n < 1) return `$${n.toFixed(4)}`;
  if (n < 1000) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  console.log(`\n[cost-compare] label=${opts.label} base=${opts.base} speed=${opts.speed} settle=${opts.settle}`);
  console.log(`[cost-compare] assumed pricing: $${opts.priceIn}/1M input tokens, $${opts.priceOut}/1M output tokens (default: gpt-5-nano list price, cached-input tier not applied — pass --price-in/--price-out to override)`);

  await resetMetrics(opts.base);
  const { code, out } = await runFixturesChild(opts.base, opts.speed, opts.settle);
  const fixtureVerdicts = parseFixtureVerdicts(out);
  const snap = await getMetrics(opts.base);

  const costPerCall = (snap.tokensPerCallIn * opts.priceIn + snap.tokensPerCallOut * opts.priceOut) / 1e6;
  const costPerSession = snap.callsPerSession * costPerCall;
  const costPerNSessions = costPerSession * opts.sessions;

  // Minor #6: a non-zero replay.js exit means at least one fixture failed
  // (or replay itself errored) — the cost numbers in this run are still
  // computed from whatever calls DID happen, but the run should never be
  // mistaken for a clean measurement. Mark it invalid in the saved JSON and
  // fail loudly instead of the previous silent "printed a row, exit 0".
  const valid = code === 0;
  if (!valid) {
    console.error(`[cost-compare] WARNING: replay.js exited with code ${code} — at least one fixture failed or errored. This run is NOT a clean measurement.`);
  }

  const row = {
    label: opts.label,
    base: opts.base,
    valid,
    replayExitCode: code,
    fixtureVerdicts,
    ticks: snap.ticks,
    quietTicks: snap.quietTicks,
    gated: snap.gated,
    llmCalls: snap.llmCalls,
    sessions: snap.sessions,
    callsPerSession: snap.callsPerSession,
    cacheHits: snap.cacheHits,
    cacheMisses: snap.cacheMisses,
    cacheHitRate: snap.cacheHitRate,
    tokensPerCallIn: snap.tokensPerCallIn,
    tokensPerCallOut: snap.tokensPerCallOut,
    avgLlmMs: snap.avgLlmMs,
    llmErrors: snap.llmErrors,
    tokensTotalCodex: snap.tokensTotalCodex,
    pricePerMIn: opts.priceIn,
    pricePerMOut: opts.priceOut,
    sessionsExtrapolated: opts.sessions,
    estCostPerNSessions: costPerNSessions,
    fullSnapshot: snap,
  };

  console.log(`\n=== ${opts.label} ===`);
  console.log(`ticks=${snap.ticks}  quietTicks=${snap.quietTicks}  gated=${snap.gated}  llmCalls=${snap.llmCalls}  sessions=${snap.sessions}`);
  console.log(`callsPerSession=${snap.callsPerSession.toFixed(2)}  cacheHitRate=${(snap.cacheHitRate * 100).toFixed(1)}%  (${snap.cacheHits} hits / ${snap.cacheMisses} misses)`);
  console.log(`tokens/call: in=${snap.tokensPerCallIn.toFixed(0)} out=${snap.tokensPerCallOut.toFixed(0)} (API-comparable estimate; codex backend only, chars/4)`);
  console.log(`avg ms/call=${snap.avgLlmMs.toFixed(0)}  llmErrors=${snap.llmErrors}`);
  console.log(`est. cost per ${opts.sessions.toLocaleString()} sessions = ${fmtUsd(costPerNSessions)}  (assumed $${opts.priceIn}/$${opts.priceOut} per 1M in/out tokens)`);
  if (snap.tokensTotalCodex > 0) {
    const avgCodexTokens = snap.llmCalls > 0 ? snap.tokensTotalCodex / snap.llmCalls : 0;
    console.log(`codex total-token figure: ${snap.tokensTotalCodex} total / ${avgCodexTokens.toFixed(0)} per call — INCLUDES codex's own system instructions, NOT what an API deployment would pay. Informational only.`);
  }
  console.log(`fixture verdicts: ${JSON.stringify(fixtureVerdicts)}`);

  const outDir = path.join(__dirname, "metrics-runs");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${opts.label}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(row, null, 2));
  console.log(`saved: ${outFile}`);

  if (!valid) process.exit(1);
}

main().catch((err) => {
  console.error(`[cost-compare] error: ${err.message}`);
  process.exit(1);
});
