// Health/readiness endpoints. Mounted into index.js as a router — logic
// (the agent self-test, caching, readiness bookkeeping) lives here so
// index.js stays route-wiring only.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";

import { decide } from "./decide/index.js";
import { sessionCount } from "./state.js";
import * as metrics from "./metrics.js";
import { log } from "./log.js";
import { withInflight } from "./inflight.js";
import { describePolicyConfig } from "./policy-config.js";
import { storeStatus } from "./store/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf8"));

const AGENT_HEALTH_CACHE_MS = 60_000;
const AGENT_HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_SESSION_ID = "__health__";
// Even a `force=1` (itself gated behind AGENT_DEBUG=1, see the route below)
// can't re-run the self-test more often than this — a debug user hammering
// force=1 in a loop is still just as much an LLM-call amplifier as an
// unauthenticated one; this is the floor under both.
const AGENT_HEALTH_MIN_FORCE_INTERVAL_MS = 10_000;

let cachedAgentHealth = null; // { at: number, result }
// null = never run, true/false = last real outcome. Read by GET /ready.
let lastAgentHealthOk = null;
// In-flight self-test promise, if one is currently running — concurrent
// callers (force or not) await this SAME promise instead of each starting
// their own decide() call. Cleared once the run settles.
let inflightSelfTest = null;

/**
 * Fixed synthetic state — fixture-1 (sizing-hesitation)'s end-of-session
 * shape, built inline so the self-test never touches a real session or the
 * filesystem. Never fed through getSession()/pushEvent(), so it can't leak
 * into sessionCount() or the real session store.
 */
function syntheticState() {
  return {
    page: "/product/khadi-field-jacket",
    visibleTargets: [
      "product-image",
      "size-picker",
      "size-guide",
      "cart-add",
      "shipping-banner",
      "cart-link",
    ],
    cart: null,
    recent: [
      "page_view /product/khadi-field-jacket",
      "dwell size-guide 22s",
      "back_nav /",
      "page_view /product/khadi-field-jacket",
    ],
    dwell: { pageMs: 6000, perTarget: { "size-guide": 22000 } },
    lastIntervention: null,
  };
}

function syntheticSession() {
  return {
    id: HEALTH_SESSION_ID,
    events: [],
    lastInterventionAt: 0,
    lastInterventionTarget: null,
    actedTargets: new Set(),
    lastDeciderAt: 0,
    lastTrace: null,
    lastDwellBuckets: {},
  };
}

async function runAgentSelfTest() {
  const mode = process.env.AGENT_MODE || "stub";
  const backend = process.env.LLM_BACKEND || "codex";
  const state = syntheticState();
  const session = syntheticSession();

  const t0 = Date.now();
  let decision = null;
  let error = null;
  let ok = false;
  try {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("health check timed out")), AGENT_HEALTH_TIMEOUT_MS);
    });
    try {
      decision = await Promise.race([withInflight(() => decide(state, session)), timeout]);
      ok = true;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    error = String(err?.message ?? err);
    ok = false;
  }

  return {
    ok,
    mode,
    backend,
    latency_ms: Date.now() - t0,
    decision,
    error,
  };
}

/**
 * getAgentHealth(force) → cached (60s TTL) self-test result. `force` bypasses
 * the cache, but never more often than AGENT_HEALTH_MIN_FORCE_INTERVAL_MS
 * (10s) — and the route itself (below) only honours `force` at all when
 * AGENT_DEBUG=1, so an unauthenticated caller can never reach the
 * force-bypass path in the first place. Never throws — runAgentSelfTest()
 * catches decider failures itself; a decider failure is reported as
 * `ok:false` with a 200, not a 500.
 *
 * Concurrent callers (any mix of force/non-force, while a run is already in
 * flight) all await the SAME in-flight promise rather than each starting
 * their own decide() call — that's the real fix for the amplifier: without
 * it, N concurrent requests during the ~1 self-test's latency window each
 * fire their own model call regardless of any cache/interval check, since
 * none of them have written `cachedAgentHealth` yet.
 *
 * Cache is stamped with the time the call RETURNED (after runAgentSelfTest()
 * resolves), not when it started — stamping before the (possibly slow) call
 * would let the TTL window start ticking before the result even existed,
 * letting a slow self-test's cache entry look older/staler than it is the
 * instant it's written, and (combined with a low enough latency) shrinking
 * the effective cache window below AGENT_HEALTH_CACHE_MS.
 *
 * NOTE (known limit): in AGENT_MODE=llm, decide/llm.js unconditionally calls
 * metrics.inc("llmCalls"/"cacheHits"/"cacheMisses"/"llmErrors"/"llmMsTotal")
 * from inside decide() itself — metrics.js exposes no per-call opt-out, so
 * a self-test call in llm mode DOES nudge those counters (once per cache
 * TTL window, i.e. at most once/60s, or once per allowed --force, subject to
 * the 10s floor above). It never touches the "sessions" counter (that's
 * only incremented in index.js's /event handler, which the self-test never
 * goes through) and never affects any real session's cooldown/actedTargets
 * state. Documented per brief ("if metrics doesn't expose a way [to
 * exclude], note it").
 */
export async function getAgentHealth(force) {
  const now = Date.now();
  const forceAllowed = force && (!cachedAgentHealth || now - cachedAgentHealth.at >= AGENT_HEALTH_MIN_FORCE_INTERVAL_MS);

  if (!forceAllowed && cachedAgentHealth && now - cachedAgentHealth.at < AGENT_HEALTH_CACHE_MS) {
    return { ...cachedAgentHealth.result, cached: true, ts: cachedAgentHealth.at };
  }

  if (inflightSelfTest) {
    const result = await inflightSelfTest;
    // A caller that arrived while a run was already in flight (rather than
    // triggering it) is served that shared result — same "cached" framing
    // as the TTL-cache-hit branch above, since no new decide() call was
    // made on this caller's behalf.
    return { ...result, cached: true, ts: cachedAgentHealth?.at ?? now };
  }

  inflightSelfTest = runAgentSelfTest();
  try {
    const result = await inflightSelfTest;
    const at = Date.now();
    cachedAgentHealth = { at, result };
    lastAgentHealthOk = result.ok;
    return { ...result, cached: false, ts: at };
  } finally {
    inflightSelfTest = null;
  }
}

/** null = self-test never run, true/false = last outcome. Used by /ready. */
export function lastAgentHealthStatus() {
  return lastAgentHealthOk;
}

/**
 * createHealthRouter({ sockets, server }) → express.Router with /health,
 * /health/agent, /ready. `sockets` is index.js's session→Set<WebSocket> map
 * (read-only here, just to count open sockets); `server` is the http.Server
 * instance (read-only, just to check .listening).
 */
export function createHealthRouter({ sockets, server }) {
  const router = express.Router();

  router.get("/health", (_req, res) => {
    const snap = metrics.snapshot();
    let socketCount = 0;
    for (const set of sockets.values()) socketCount += set.size;

    res.json({
      ok: true,
      sessions: sessionCount(),
      uptime_s: Math.round(process.uptime()),
      mode: process.env.AGENT_MODE || "stub",
      policy: describePolicyConfig(),
      backend: process.env.LLM_BACKEND || "codex",
      version: pkg.version,
      sockets: socketCount,
      store: storeStatus(),
      metrics: {
        llmCalls: snap.llmCalls,
        cacheHits: snap.cacheHits,
        llmErrors: snap.llmErrors,
        avgLlmMs: snap.avgLlmMs,
      },
    });
  });

  router.get("/health/agent", async (req, res) => {
    try {
      // `force=1` is a self-test-on-demand knob that costs a real model
      // call (LLM_BACKEND permitting) — this route sits on the public
      // tunnel (per brief B4), so an unauthenticated caller must never be
      // able to trigger one. Only honoured when AGENT_DEBUG=1 is set on the
      // server process; otherwise `force` is silently ignored and this
      // behaves exactly like a plain GET /health/agent (cached result).
      const force = process.env.AGENT_DEBUG === "1" && req.query.force === "1";
      const result = await getAgentHealth(force);
      res.json(result);
    } catch (err) {
      // Only reachable on an actual bug in this route (runAgentSelfTest
      // already catches decider failures) — 500 for that case only.
      log.error("health/agent route threw", { err: String(err?.message ?? err) });
      res.status(500).json({ ok: false, error: "internal error" });
    }
  });

  router.get("/ready", (_req, res) => {
    const listening = Boolean(server.listening);
    const agentOk = lastAgentHealthOk === null || lastAgentHealthOk === true;
    if (listening && agentOk) return res.status(200).json({ ready: true });
    return res.status(503).json({ ready: false, listening, agentHealthOk: lastAgentHealthOk });
  });

  return router;
}
