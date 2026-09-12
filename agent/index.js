// Agent server — vertical slice.
// POST /event → store in session (immediately) → tick/gate → decide() →
// applyPolicy() → broadcast (asynchronously, never blocking the HTTP
// response). The state update (processEventCore) and the decision
// (decideAndBroadcast) are deliberately decoupled: cached mode / AGENT_RECORD
// run one decision per event, strictly serialized per session
// (runSerialized/processEventSerial); stub/llm mode COALESCE — at most one
// decision in flight per session plus at most one pending, latest-state-wins
// — so a burst of events from one browser tab (dwell heartbeats every few
// seconds while a live decider call takes 10-20s) never backs up a
// per-session queue. See the "per-session decision coordination" comment
// below for the full design and server/OPS.md's "Decision coalescing".
// Contracts mirror web/lib/contracts.ts (mirror now lives in server/contracts.js). Change both or neither.
//
// Route wiring only — logic lives in the imported modules (state.js,
// policy.js, tick.js, gate.js, decide/**, log.js, health.js).

import http from "node:http";
import { randomInt } from "node:crypto";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";

import { EVENT_TYPES, OUTCOME_KINDS, validateMeta, isValidSessionId } from "./contracts.js";
import {
  getSession,
  peekSession,
  pushEvent,
  buildState,
  sessionCount,
  summarize,
  evictLRUSessions,
  resetSession,
} from "./state.js";
import { applyPolicy } from "./policy.js";
import { decide } from "./decide/index.js";
import { record as recordCached, hasRecording } from "./decide/cached.js";
import { clearSessionInflight } from "./decide/llm.js";
import { FIXTURE_NAME_RE, loadFixture, listFixtureNames, fixtureDurationMs, verifyRecording } from "./demo-play.js";
import { shouldCallDecider } from "./tick.js";
import { gate } from "./gate.js";
import * as metrics from "./metrics.js";
import { log, recent as recentLogs } from "./log.js";
import { createHealthRouter } from "./health.js";
import { mountStatic } from "./serve-static.js";
import { inflightCount, withInflight } from "./inflight.js";
import { recordEvent, recordDecision, recordOutcome, lastEventIndex } from "./live-record.js";
import { computeContextFingerprint } from "./stale.js";
import { createResearchRouter } from "./research-routes.js";

// Last-resort safety net: any throw/rejection that slips past every local
// try/catch and per-promise handler in this codebase (a bug we didn't
// anticipate, not a substitute for fixing the anticipated ones above) must
// not take the whole process down. Node 20 terminates by default on an
// unhandled rejection; log it at error level, bump a counter, and keep
// serving. `uncaughtException` is genuinely unsafe to "keep running" after
// per Node's own docs (unknown state) but crashing the whole agent server
// over a single request's bug is worse for this project's uptime goals than
// logging and carrying on — this is a demo/cost-experiment server, not a
// system holding open transactions.
process.on("unhandledRejection", (reason) => {
  metrics.inc("unhandledRejections");
  log.error("unhandled rejection", { err: String(reason?.message ?? reason), stack: reason?.stack });
});
process.on("uncaughtException", (err) => {
  metrics.inc("uncaughtExceptions");
  log.error("uncaught exception", { err: String(err?.message ?? err), stack: err?.stack });
});

const PORT = process.env.PORT || 4000;
const AGENT_MODE = process.env.AGENT_MODE || "stub";
const AGENT_RECORD = process.env.AGENT_RECORD === "1";
const AGENT_DEBUG = process.env.AGENT_DEBUG === "1";
const AGENT_MAX_INFLIGHT = Number(process.env.AGENT_MAX_INFLIGHT) || 32;
const AGENT_MAX_SESSIONS = Number(process.env.AGENT_MAX_SESSIONS) || 5000;
const SOCKETS_PER_SESSION_MAX = 5;
const WS_PING_INTERVAL_MS = 30_000;

// ---- http + ws -------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));

const server = http.createServer(app);
// Reverse proxies (cloudflared, nginx) reuse idle keep-alive connections.
// Node's default keepAliveTimeout is 5s: an idle connection the proxy
// reuses at ~5s gets reset mid-request and surfaces in the browser as a
// 502 with no CORS headers ("blocked by CORS policy" on POST /event).
// Keep the socket open longer than any sane proxy idle window.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
const wss = new WebSocketServer({ server });

// Same category as the per-socket handler below: an unhandled 'error' on
// the http.Server or the WebSocketServer itself (not a specific connection)
// is also just an EventEmitter 'error' with no listener — same crash class.
server.on("error", (err) => {
  log.error("http server error", { err: String(err?.message ?? err) });
});
wss.on("error", (err) => {
  log.error("websocket server error", { err: String(err?.message ?? err) });
});

/** session id → Set<WebSocket> */
const sockets = new Map();

function closeSessionSockets(session, code, reason) {
  for (const ws of sockets.get(session) ?? []) {
    try {
      ws.close(code, reason);
    } catch {
      // socket already closing/closed — nothing to do
    }
  }
  sockets.delete(session);
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  const session = url.searchParams.get("session") || "anon";
  if (!isValidSessionId(session)) {
    ws.close(1008, "invalid session id");
    return;
  }

  const existing = sockets.get(session);
  if (existing && existing.size >= SOCKETS_PER_SESSION_MAX) {
    log.warn("ws connection rejected: per-session socket cap", { session, cap: SOCKETS_PER_SESSION_MAX });
    ws.close(1013, "too many sockets for this session");
    return;
  }

  if (!sockets.has(session)) sockets.set(session, new Set());
  sockets.get(session).add(ws);

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  ws.on("close", () => sockets.get(session)?.delete(ws));
  // An unhandled 'error' event on an EventEmitter (ws sockets included)
  // crashes the process — a flaky/misbehaving client connection must not
  // take the whole server down. "close" fires after "error" too, so cleanup
  // still happens via the handler above.
  ws.on("error", (err) => {
    log.warn("ws socket error", { session, err: String(err?.message ?? err) });
  });
});

// Ping every connected socket; terminate any that didn't pong since the last
// sweep (dead/half-open connection).
const pingInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // ignore — a failing ping means the socket is already on its way out
    }
  }
}, WS_PING_INTERVAL_MS);
pingInterval.unref?.();

function broadcast(session, msg) {
  const data = JSON.stringify(msg);
  for (const ws of sockets.get(session) ?? []) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

const ACTION_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** genActionId() → "a_" + 8 base36 chars — outcome-tracking correlation id
 * (server/RESEARCH.md "Outcomes" section). Not security-sensitive (a
 * client that knows another shopper's action id could only report an
 * outcome for it, same as it can today for any /event field), so
 * Math.random-grade randomness via crypto.randomInt (still non-blocking,
 * no new dep) is plenty — collision odds are irrelevant at this volume. */
function genActionId() {
  let s = "";
  for (let i = 0; i < 8; i++) s += ACTION_ID_ALPHABET[randomInt(36)];
  return `a_${s}`;
}

/** Build the exact wire shape for an action message. `kind` cannot be overridden. */
function actionMessage(action) {
  return {
    kind: "action",
    action: action.action,
    target: action.target,
    style: action.style,
    duration_ms: action.duration_ms,
    message: action.message,
    card: action.card ?? null,
    id: action.id ?? null,
  };
}

/** Build the exact wire shape for a trace message. `kind` cannot be overridden. */
function traceMessage(trace) {
  return {
    kind: "trace",
    ts: trace.ts,
    signals: trace.signals,
    hypothesis: trace.hypothesis,
    decision: trace.decision,
    confidence: trace.confidence,
    why: trace.why,
  };
}

// ---- per-session decision coordination -------------------------------------
// Two DISTINCT concurrency models, chosen by AGENT_MODE / AGENT_RECORD / the
// `x-agent-replay: 1` request header (the full split lives in one place —
// see the "AGENT_MODE SPLIT" comment inside decideAndBroadcast() below, and
// POST /event's `isReplay` check):
//
//   - cached mode / AGENT_RECORD=1 / any request tagged x-agent-replay: 1
//     (regardless of AGENT_MODE): STRICT PER-EVENT SERIAL. One decide() call
//     per event, in arrival order. Required for cached/AGENT_RECORD because
//     decide/cached.js indexes its recording by session.events.length, so
//     skipping or coalescing events would desync playback from the
//     recording; required for x-agent-replay because server/replay.js (the
//     day-of tuning-loop tool, used against stub AND llm) paces itself
//     awaiting one decision per event and sizes its own `--settle` wait off
//     that assumption — coalescing would silently collapse a multi-event
//     fixture into far fewer decisions and replay.js would close its
//     socket before a coalesced-away one ever ran. `runSerialized()` chains
//     each session's decision task onto a promise. No per-session cap: this
//     path is only ever driven by the demo player / replay.js, both of
//     which pace themselves (await each event before sending the next), so
//     it can't be flooded by unthrottled live traffic the way live llm/stub
//     traffic could — see server/NOTES.md for why the old
//     AGENT_MAX_QUEUE_PER_SESSION cap was removed instead of kept.
//
//   - stub / llm mode, live (non-replay) traffic: COALESCED. At most one decision
//     in-flight per session, plus at most one PENDING (latest-state-wins —
//     an event that arrives while a decision is already running doesn't get
//     its own queued decision, it just marks the session "pending" so the
//     NEXT decision (started the moment the current one finishes) sees the
//     now-current state). A burst of events (dwell heartbeats every few
//     seconds while a live decider call takes 10-20s) no longer backs up a
//     per-session queue at all — there is no queue to exceed.
//
// Either way, `POST /event` (below) never awaits a decision — only
// processEventCore()'s synchronous state update — so the widget's HTTP
// response never waits on the model.

const sessionChains = new Map();

/** session id -> { inFlight, pending, pendingEv, sawTrigger, foldedCount,
 * cancelled } — the coalescing bookkeeping for the stub/llm path (see
 * above). `pendingEv` is the HIGHEST-PRIORITY event seen while a decision
 * was already running for this session (see EVENT_PRIORITY_ORDER below) —
 * not simply the latest one, so a rage_click/back_nav/etc folded in behind a
 * burst of dwell heartbeats is never displaced by a later, lower-priority
 * dwell tick (the "non-dwell trigger swallowed by coalescing" defect class).
 * `sawTrigger` is true if ANY non-dwell event was folded in during the
 * current in-flight decision — the pending run forces a decider call off
 * that flag alone (bypassing tick.js's quiet-tick class-change check, which
 * only looks at the single `pendingEv` it's handed), so a trigger folded in
 * behind a same-priority-or-lower event can't be silently absorbed as a
 * "quiet tick". `foldedCount` is how many events folded in total (for the
 * "pending decision run" log line). `cancelled` — see resetSessionFully()
 * and runCoalescedLoop() below — marks a record whose session was reset
 * while its (uncancelable, already in-flight) decision was still running. */
const sessionCoalesce = new Map();

// Priority order for `pendingEv` selection while coalescing (highest first).
// Any type not listed (shouldn't happen — EVENT_TYPES is fixed by
// contracts.js) sorts as lowest priority.
const EVENT_PRIORITY_ORDER = [
  "rage_click",
  "back_nav",
  "cart_update",
  "search",
  "cart_view",
  "page_view",
  "scroll_depth",
  "dwell",
];
function eventPriorityRank(type) {
  const idx = EVENT_PRIORITY_ORDER.indexOf(type);
  return idx === -1 ? EVENT_PRIORITY_ORDER.length : idx; // lower rank = higher priority
}

function coalesceStateOf(sessionId) {
  let s = sessionCoalesce.get(sessionId);
  if (!s) {
    s = { inFlight: false, pending: false, pendingEv: null, sawTrigger: false, foldedCount: 0, cancelled: false };
    sessionCoalesce.set(sessionId, s);
  }
  return s;
}

/**
 * Wipes ALL server-side memory of one session — events, cooldowns,
 * actedTargets, dwell buckets, this file's own per-session chain/coalescing
 * bookkeeping, decide/llm.js's in-flight flag. Shared by `DELETE /session/:id`
 * (dev-only demo aid) and `POST /demo/play/:fixture` (in-page player resets
 * the fixture's session before every play so a retake doesn't inherit the
 * previous take's cooldown / never-same-target memory from policy.js).
 * Does NOT close the session's WebSockets — see the comment on
 * `DELETE /session/:id` below for why.
 */
function resetSessionFully(id) {
  const existed = resetSession(id);
  sessionChains.delete(id);

  // Reset-mid-flight defect class: deleting an IN-FLIGHT coalesce record
  // here would let the very next event for this session see no record at
  // all and start a brand-new runCoalescedLoop() while the old one (already
  // awaiting an uncancelable decide() call) is still running — two
  // concurrent decision loops for one session, and whichever loop finishes
  // LAST wins the "delete the map entry" race regardless of which loop it
  // actually owns (loop A's terminal delete can remove loop B's record).
  // Instead: if a record is in-flight, cancel it IN PLACE — clear anything
  // folded in so far and mark `cancelled` — and leave it to the running
  // loop (runCoalescedLoop below) to notice `cancelled` once its current
  // decision finishes and exit without a pending run, deleting the record
  // itself (identity-guarded, so it only ever removes ITS OWN record). Only
  // safe to delete synchronously here when nothing is actually running.
  const coalesce = sessionCoalesce.get(id);
  if (coalesce) {
    if (coalesce.inFlight) {
      coalesce.pending = false;
      coalesce.pendingEv = null;
      coalesce.sawTrigger = false;
      coalesce.foldedCount = 0;
      coalesce.cancelled = true;
    } else {
      sessionCoalesce.delete(id);
    }
  }

  clearSessionInflight(id);
  return existed;
}

// ---- cached/AGENT_RECORD path: strict per-event serial chain ---------------

function runSerialized(sessionId, task) {
  const prev = sessionChains.get(sessionId) ?? Promise.resolve();
  const chained = prev.catch(() => {}).then(task);
  sessionChains.set(sessionId, chained);
  // `.then(cleanup, cleanup)` (not `.finally(cleanup)`): `.finally()` returns
  // a NEW derived promise that nobody holds a reference to or awaits — if
  // `task` throws, that derived promise rejects too (finally's callback
  // doesn't swallow the original rejection) and, being unobserved, becomes
  // an unhandledRejection that crashes the process on Node 20. `.then(cb,
  // cb)` runs the same cleanup on both branches but its own returned promise
  // resolves either way (cleanup doesn't rethrow), so nothing is left
  // dangling. The caller's `chained` (returned below) is unaffected either
  // way — its own rejection is handled by whichever caller invoked
  // runSerialized() (app.post("/event") below, or processEventSerial()).
  const cleanup = () => {
    if (sessionChains.get(sessionId) === chained) sessionChains.delete(sessionId);
  };
  chained.then(cleanup, cleanup);
  return chained;
}

/** processEventSerial(ev) → Promise, resolves once this event's FULL
 * decision cycle (state update + decide/policy/broadcast) has completed,
 * chained after any earlier event for the same session. Two callers:
 *   - the in-page demo player (POST /demo/play/:fixture below), which
 *     drives synthetic events directly — not through POST /event — and
 *     paces itself by AWAITING each event before sending the next (cached
 *     mode only — see the AGENT_MODE!=="cached" 409 below).
 *   - POST /event itself, for cached mode / AGENT_RECORD=1 / any request
 *     tagged `x-agent-replay: 1` (server/replay.js) — NOT awaited there
 *     (the HTTP response never waits on a decision), but critically the
 *     event's push into session state (processEventCore) happens INSIDE
 *     this chained task, not eagerly before it, so a slow decider can never
 *     let session.events race ahead of the decision queue — see POST
 *     /event's own comment for why that alignment matters (decide/cached.js's
 *     index, decide/stub.js's "current event" check, and replay.js's
 *     one-decision-per-event pacing model all depend on it).
 */
function processEventSerial(ev, opts = {}) {
  return runSerialized(ev.session, () => {
    const session = processEventCore(ev, opts);
    return decideAndBroadcast(session, ev, opts);
  });
}

// ---- global in-flight decider cap ------------------------------------------
// Backpressure valve: past AGENT_MAX_INFLIGHT concurrent decide() calls
// in-flight process-wide, WAIT for capacity rather than skipping the
// decision — events are never dropped (see server/OPS.md "Decision
// coalescing"). The counter itself lives in inflight.js so health.js's
// self-test (GET /health/agent) is counted against the same cap.
const OVERLOAD_RETRY_MS = 50;
// How long decideAndBroadcast() will wait for global in-flight capacity to
// free before giving up and answering with the quiet-tick trace instead
// (reason "overloaded") — see the wait loop in decideAndBroadcast() below.
// Previously unbounded: a sustained overload could wait forever, which
// mattered less back when "skip immediately" was the only alternative but
// now just means a request can hang far longer than any caller (widget,
// replay.js --settle, coalesce loop) is prepared to wait.
const AGENT_OVERLOAD_WAIT_MS = Number(process.env.AGENT_OVERLOAD_WAIT_MS) || 30_000;

/** Session ids with a decideAndBroadcast() call CURRENTLY executing (used to
 * both detect and report the reset-mid-flight / coalesce-record-corruption
 * defect class — two concurrent decision cycles for the same session should
 * be structurally impossible; this is the tripwire). Exposed as the
 * "inFlightSessions" gauge (its current size) via metrics.js. */
const activeDecisionSessions = new Set();

/**
 * decision log reason — derived only from what this handler already knows
 * (tick/gate verdicts and the trace's own `why` prefix), never by reaching
 * into decide/llm.js internals. Extends the brief's gate|quiet|cache|llm|
 * stub|cached set with two more outcomes: "guard" (policy.js denied the
 * proposal) and "overloaded" (AGENT_OVERLOAD_WAIT_MS elapsed waiting for
 * in-flight capacity — see decideAndBroadcast()'s in-flight-cap handling
 * below, which waits up to that deadline before falling back to a quiet
 * tick instead of either skipping immediately or waiting forever).
 */
function deriveReason({ callDecider, skipReason, trace, mode }) {
  if (!callDecider) {
    if (skipReason === "overloaded") return "overloaded";
    if (skipReason?.startsWith("gated")) return "gate";
    return "quiet";
  }
  if (trace?.why?.startsWith("(cached)")) return "cache";
  if (trace?.why?.includes("(guard:")) return "guard";
  if (mode === "stub") return "stub";
  if (mode === "cached") return "cached";
  if (mode === "llm") return "llm";
  return "unknown";
}

app.get("/state/:session", (req, res) => {
  if (!isValidSessionId(req.params.session)) {
    return res.status(400).json({ error: "bad session id" });
  }
  const session = peekSession(req.params.session);
  if (!session) return res.status(404).json({ error: "no such session" });
  res.json(buildState(session));
});

/**
 * processEventCore(ev) — the ALWAYS-IMMEDIATE, never-queued half of event
 * processing: validate, append to session state, evict LRU sessions, bump
 * per-event metrics. No decider call, no broadcast — safe (and required) to
 * run synchronously inside the HTTP handler so `POST /event` can respond
 * before any decision starts. Returns the session so the caller can hand it
 * straight to decideAndBroadcast() without a second getSession() lookup.
 */
function processEventCore(ev, opts = {}) {
  ev.ts ??= Date.now();
  validateMeta(ev.type, ev.meta);

  const session = getSession(ev.session);
  pushEvent(session, ev);
  // Research loop (server/RESEARCH.md): record this event into the
  // session's live-recording file, if recording is on and this isn't a
  // fx_*/rp_* synthetic session — see live-record.js's module comment.
  recordEvent(ev, { replay: Boolean(opts.replay) });
  // A page_view is a hard per-page boundary for dwell-bucket history
  // (tick.js's session.lastDwellBuckets, keyed by dwell "subject" —
  // "__page__" or a target name). Without this reset, a target name reused
  // across two different pages (e.g. "size-guide" appearing on two product
  // pages) could land in the SAME bucket its dwell already reached on the
  // PREVIOUS page, making shouldCallDecider() see "no class change" and
  // silently swallow the new page's own, legitimate dwell signal — the
  // per-target-state-leak-across-navigation defect class, in its
  // false-negative direction (see server/state.js buildState() and
  // server/NOTES.md for the false-positive direction that motivated this).
  if (ev.type === "page_view") session.lastDwellBuckets = {};
  metrics.inc("ticks");
  metrics.inc("sessions", ev.session);

  // Bound the session store: evict least-recently-active sessions beyond the
  // cap and close their sockets. Checked after pushEvent so a brand new
  // session that just tipped the store over the cap is itself eligible.
  const evicted = evictLRUSessions(AGENT_MAX_SESSIONS);
  for (const evictedId of evicted) {
    closeSessionSockets(evictedId, 1001, "session evicted (LRU cap)");
    log.warn("session evicted", { session: evictedId, cap: AGENT_MAX_SESSIONS });
  }

  return session;
}

/**
 * decideAndBroadcast(session, ev) — one full decision cycle: tick/gate
 * throttle (llm mode), the global in-flight cap, decide(), applyPolicy(),
 * broadcast, logging. Always recomputes buildState(session) itself rather
 * than accepting a caller-supplied snapshot: for the coalesced path this IS
 * "the current state" a folded-in pending run must decide against; for the
 * strict-serial path (cached/AGENT_RECORD/demo player) it's equivalent to
 * the old per-event snapshot since nothing else touches the session
 * concurrently on that path anyway.
 *
 * `ev` supplies the tick.js/gate.js trigger context (event type/target) and
 * the metrics/log labels — the actual decision is always against fresh
 * state, never against `ev`'s own snapshot in time.
 *
 * Increments "decisionsStarted" exactly once per call, whether or not the
 * decider actually ran (tick/gate skips still count as "a decision cycle
 * ran, and decided to stay quiet") — that's the counter server/coalesce.test.js
 * asserts against: 30 events in, ~1-3 decisionsStarted out, because the
 * coalescing scheduler below calls this once per "round" rather than once
 * per event.
 *
 * `opts.forceDecide` (coalesced path only — see runCoalescedLoop's
 * `sawTrigger`) forces `callDecider = true` past tick.js's quiet-tick
 * class-change check in llm mode, WITHOUT bypassing gate.js. Needed because
 * `ev` here is `pendingEv` — the single highest-priority event folded into a
 * pending run — and tick.js's shouldCallDecider() only ever looks at that
 * one event's own class-change, not at everything that got folded behind
 * it; without this, a genuine trigger (rage_click, etc.) folded into a
 * pending run that also folded in a later same-or-lower-priority dwell tick
 * could still read as "no new signal" once bucketed. See
 * EVENT_PRIORITY_ORDER above for why `pendingEv` itself is already usually
 * (but see next line) enough on its own.
 */
async function decideAndBroadcast(session, ev, opts = {}) {
  const tickStart = Date.now();
  metrics.inc("decisionsStarted");

  // Reset-mid-flight / coalesce-corruption tripwire: two decideAndBroadcast
  // calls for the SAME session must never be executing at once — the
  // coalescing scheduler and the strict-serial chain are both designed to
  // guarantee that (see resetSessionFully()'s cancel-in-place handling and
  // runCoalescedLoop()'s identity-guarded terminal delete). If this ever
  // fires, one of those invariants broke; log loudly and count it rather
  // than silently letting two decisions race each other's session mutations
  // (session.lastInterventionAt, actedTargets, lastDwellBuckets, ...).
  if (activeDecisionSessions.has(ev.session)) {
    metrics.inc("overlappingDecisions");
    log.error("overlapping decideAndBroadcast for one session (invariant violation)", { session: ev.session });
  }
  activeDecisionSessions.add(ev.session);
  metrics.setGauge("inFlightSessions", activeDecisionSessions.size);

  try {
    // buildState() is cheap (no model call) — computed once here for the
    // tick.js/gate.js throttle checks below (need SOME state to check
    // against), then recomputed fresh right before the actual decide() call
    // if that call is going to happen — seeAGENT_OVERLOAD_WAIT_MS wait below,
    // which can take up to 30s and must not hand the decider stale state
    // from before the wait.
    let state = buildState(session);

    // ---- AGENT_MODE SPLIT (the one place this pass makes it explicit) -----
    // - stub: relies on a decider call per dwell tick to see fresh
    //   dwell.meta.ms, so it bypasses the quiet-tick throttle. It's on the
    //   COALESCED scheduling path below, same as llm — AGENT_STUB_DELAY_MS
    //   (decide/stub.js, test-only) simulates a slow decider so
    //   server/coalesce.test.js can exercise coalescing without a real model.
    // - cached: its recording has exactly one entry per event, so playback
    //   must stay index-aligned — bypasses the throttle AND is driven only
    //   via the STRICT-SERIAL path (processEventSerial / runSerialized),
    //   never coalesced.
    // - AGENT_RECORD=1: same strict-serial requirement in reverse — the
    //   recording itself needs exactly one entry per event.
    // - llm: gets the signal-class trigger (tick.js) plus the layer-0 gate
    //   (gate.js) — both cost layers that only make sense once real model
    //   calls are on the line — and is on the coalesced path.
    const bypassThrottle = AGENT_MODE === "stub" || AGENT_MODE === "cached" || AGENT_RECORD;

    let callDecider = true;
    let skipReason = null;
    // opts.force (research loop's POST /session/:id/decide — see
    // research-routes.js) bypasses tick.js's quiet-tick check AND gate.js's
    // layer-0 gate, same as bypassThrottle above, WITHOUT touching
    // bypassThrottle itself (that flag also drives the cached-only
    // skipCooldown policyOpts below, which forced decisions must NOT get —
    // cooldown and policy still apply to a forced decision per the brief).
    if (!bypassThrottle && !opts.force) {
      if (AGENT_MODE === "llm" && !opts.forceDecide && !shouldCallDecider(session, ev, state)) {
        callDecider = false;
        skipReason = "quiet tick: dwell within same bucket, no new signal";
        metrics.inc("quietTicks");
      } else if (AGENT_MODE === "llm") {
        const g = gate(state, session, ev);
        if (!g.pass) {
          callDecider = false;
          skipReason = `gated: ${g.reason}`;
          metrics.inc("gated");
        }
      }
    }

    // Global backpressure valve, checked last so it never masks a cheaper
    // quiet-tick/gate skip that would have avoided a decider call anyway.
    // Past AGENT_MAX_INFLIGHT concurrent decide() calls process-wide, WAIT
    // (poll every OVERLOAD_RETRY_MS) up to AGENT_OVERLOAD_WAIT_MS for
    // capacity to free, rather than either skipping immediately or waiting
    // forever — past the deadline, fall back to the quiet-tick trace with
    // reason "overloaded" so this event's own response cycle still
    // terminates. Safe to loop here at all: the coalescing scheduler
    // (runCoalescedLoop) and the strict-serial chain (runSerialized) both
    // guarantee at most one decideAndBroadcast in flight per session — see
    // the tripwire above — so this wait can't itself pile up into an
    // amplifier for a single session.
    if (callDecider) {
      let waited = false;
      const waitStart = Date.now();
      while (inflightCount() >= AGENT_MAX_INFLIGHT) {
        if (!waited) {
          metrics.inc("overloaded");
          log.warn("decider waiting: overloaded", {
            session: ev.session,
            inflight: inflightCount(),
            cap: AGENT_MAX_INFLIGHT,
          });
          waited = true;
        }
        if (Date.now() - waitStart >= AGENT_OVERLOAD_WAIT_MS) {
          metrics.inc("overloadTimeouts");
          log.warn("decider gave up waiting: overloaded", {
            session: ev.session,
            inflight: inflightCount(),
            cap: AGENT_MAX_INFLIGHT,
            waitedMs: Date.now() - waitStart,
          });
          callDecider = false;
          skipReason = "overloaded";
          break;
        }
        await new Promise((r) => setTimeout(r, OVERLOAD_RETRY_MS));
      }
    }

    let action, trace;
    if (callDecider) {
      // Rebuild fresh — the overload wait above can take up to
      // AGENT_OVERLOAD_WAIT_MS; events may have landed (and did land, for
      // the coalesced path) while we waited. The decider must see the
      // CURRENT state, not whatever was true when this cycle started.
      state = buildState(session);
      session.lastDeciderAt = Date.now();
      // Stale-response guard (server/stale.js): captured HERE, the moment
      // this decision starts being computed against "now" — the decider
      // call below can take 10-20s (real LLM latency), during which the
      // shopper's product/cart/page/attention can change. applyPolicy()
      // compares this against a freshly re-derived live fingerprint as its
      // FIRST check, denying with `stale_context:<class>` if they diverge.
      const contextFingerprint = computeContextFingerprint(session);
      let proposed;
      try {
        // decide() may be sync (stub/cached) or async (llm, or stub with
        // AGENT_STUB_DELAY_MS set) — await handles both; awaiting a plain
        // value just resolves to it.
        proposed = await withInflight(() => decide(state, session));
      } catch (err) {
      // Decider threw (e.g. decide/llm.js stub on build day) — hand policy an
      // invalid proposal so it produces the standard guard trace instead of
      // crashing the request.
      proposed = {
        action: { action: "error", target: null, style: null, duration_ms: 0, message: null },
        trace: { ts: Date.now(), signals: [], hypothesis: "", decision: "error", confidence: 0, why: `decider threw: ${err.message}` },
      };
    }

    // Record the PRE-policy proposal — cached playback re-applies policy
    // itself, so recording the post-policy result would double-apply guards
    // (and bake in cooldown timing from the recording run, which doesn't
    // match a `--speed`d playback run).
    if (AGENT_RECORD) recordCached(ev.session, proposed);

    const policyOpts = AGENT_MODE === "cached" ? { skipCooldown: true, contextFingerprint } : { contextFingerprint };
    ({ action, trace } = applyPolicy(session, state, proposed, policyOpts));
    session.lastTrace = trace;
  } else {
    trace = {
      ts: Date.now(),
      signals: summarize(session.events),
      hypothesis: "No new signal since last decision.",
      decision: "noop",
      confidence: 0.5,
      why: skipReason || "quiet tick: no new signal",
    };
    action = { action: "noop", target: null, style: null, duration_ms: 0, message: null };
    session.lastTrace = trace;
  }

  // Outcome tracking (server/RESEARCH.md "Outcomes" section): every
  // non-noop action gets a server-assigned id, echoed back by the widget in
  // agent_outcome.meta.action_id — the SAME action object reference is used
  // below for both the broadcast and recordDecision(), so the id lands in
  // both the wire message and the live-recorded decision entry.
  if (action.action !== "noop" && !action.id) action.id = genActionId();

  broadcast(ev.session, traceMessage(trace));
  if (action.action !== "noop") broadcast(ev.session, actionMessage(action));
  // Widget's onmessage falls through to apply() for any kind !== "trace",
  // but apply()'s switch has no case for a metrics message (a.action is
  // undefined) so it's a silent no-op there — confirmed safe to broadcast.
  // See NOTES.md "Cost design" for the widget-panel ask.
  broadcast(ev.session, { kind: "metrics", ...metrics.snapshot() });

  const decided = action.action === "noop" ? "noop" : [action.action, action.target].filter(Boolean).join(" ");
  const ms = Date.now() - tickStart;
  // opts.reasonLabel (research loop's forced-decide route) overrides the
  // derived reason with "forced" — both the log line and the live-recorded
  // decision entry should say so, not whatever llm/stub/cache/etc. the
  // decider happened to run under.
  const reason = opts.reasonLabel ?? deriveReason({ callDecider, skipReason, trace, mode: AGENT_MODE });

  log.info("decision", {
    session: ev.session,
    event: ev.type,
    decided,
    reason,
    ms,
  });

  // Research loop (server/RESEARCH.md): record this decision cycle into the
  // triggering session's live-recording file (no-op for fx_*/rp_*/recording
  // disabled — see live-record.js). eventIndex is this recorder's own
  // (unbounded) event index, not state.js's ring-buffered session.events
  // length, so it stays meaningful even once a long session's ring buffer
  // has wrapped.
  recordDecision(ev.session, {
    ts: trace.ts ?? Date.now(),
    eventIndex: lastEventIndex(ev.session),
    trigger: ev.type,
    decided,
    reason,
    ms,
    action,
    trace,
    delivered: action.action !== "noop",
  });

  return { action, trace, reason, ms };
  } finally {
    activeDecisionSessions.delete(ev.session);
    metrics.setGauge("inFlightSessions", activeDecisionSessions.size);
  }
}

// ---- stub/llm path: coalesced decision scheduling ---------------------------

/** scheduleCoalescedDecision(session, ev) — call once per event, AFTER
 * processEventCore() has already updated state for it. Never queues per
 * event: if a decision is already running for this session, this event just
 * marks the session `pending` and folds into `pendingEv` (HIGHEST-PRIORITY
 * event wins — see EVENT_PRIORITY_ORDER; a same-or-lower-priority event
 * never displaces an already-folded higher-priority one, so e.g. a dwell
 * heartbeat after a folded rage_click can't quietly demote it back to a
 * dwell tick) and bumps `coalesced`; the loop below folds it into exactly
 * one more decision once the current one finishes. If no decision is
 * running, starts one now. */
function scheduleCoalescedDecision(session, ev) {
  const s = coalesceStateOf(ev.session);
  if (s.inFlight) {
    if (ev.type !== "dwell") s.sawTrigger = true;
    if (!s.pendingEv || eventPriorityRank(ev.type) <= eventPriorityRank(s.pendingEv.type)) {
      s.pendingEv = ev;
    }
    s.pending = true;
    s.foldedCount++;
    metrics.inc("coalesced");
    return;
  }
  s.inFlight = true;
  runCoalescedLoop(session, ev, s);
}

async function runCoalescedLoop(session, firstEv, s) {
  let ev = firstEv;
  let forceDecide = false;
  for (;;) {
    // Nit fix: re-fetch the LIVE session object every cycle rather than
    // reusing the one this loop was started with — if the session was
    // evicted (AGENT_MAX_SESSIONS LRU) or reset mid-flight and later
    // recreated, a pending run must decide against the CURRENT session
    // object (getSession() lazily recreates one if it's gone), not a
    // detached snapshot from whenever this loop started. Cheap: no model
    // call, just a Map lookup (or a fresh empty-session allocation).
    const liveSession = getSession(ev.session);
    try {
      await decideAndBroadcast(liveSession, ev, { forceDecide });
    } catch (err) {
      log.error("unhandled error in coalesced decision", { session: ev.session, err: String(err?.message ?? err) });
    }
    // Reset-mid-flight: resetSessionFully() cancels this record IN PLACE
    // (see its comment) rather than deleting it out from under this loop —
    // once cancelled, this loop must not run a pending decision (the
    // session's own state was just wiped; a fresh event afterward will
    // start its own fresh loop once this one tears down below).
    if (s.cancelled || !s.pending) break;
    const folded = s.foldedCount;
    ev = s.pendingEv;
    forceDecide = s.sawTrigger;
    s.pending = false;
    s.pendingEv = null;
    s.sawTrigger = false;
    s.foldedCount = 0;
    metrics.inc("pendingRuns");
    log.info("pending decision run: folding coalesced events", { session: session.id, foldedEvents: folded });
  }
  s.inFlight = false;
  // Identity-guarded: only remove the map entry if it's still THIS loop's
  // own record. A record can be replaced (never deleted while in-flight —
  // see resetSessionFully()) between this loop starting and finishing only
  // if it was already cancelled and torn down by an earlier pass through
  // this same loop, which can't happen for a single loop instance — this
  // guard exists for defense in depth against exactly the corruption class
  // this pass fixes (one loop's terminal delete removing another loop's
  // record), not because a live code path is known to still hit it.
  if (sessionCoalesce.get(session.id) === s) sessionCoalesce.delete(session.id);
}

/**
 * handleOutcomeEvent(ev, res) — the agent_outcome-only path out of
 * POST /event (see the dedicated branch there for why this is entirely
 * separate from processEventCore/decideAndBroadcast). Validates the
 * outcome-specific meta, records it (live-record.js, deduped by
 * action_id — a duplicate report, e.g. an explicit dismiss racing a
 * tab-close beacon, is acknowledged but ignored, not an error), and
 * responds — no state.js session lookup needed beyond validating the id.
 */
function handleOutcomeEvent(ev, res) {
  ev.ts ??= Date.now();
  validateMeta(ev.type, ev.meta);
  const meta = ev.meta || {};
  const actionId = typeof meta.action_id === "string" && meta.action_id ? meta.action_id : null;
  const outcome = typeof meta.outcome === "string" ? meta.outcome : null;
  if (!actionId || !OUTCOME_KINDS.includes(outcome)) {
    return res.status(400).json({ error: "bad agent_outcome meta", expected: OUTCOME_KINDS });
  }
  const entry = {
    action_id: actionId,
    action: typeof meta.action === "string" ? meta.action : null,
    target: ev.target ?? null,
    cta_kind: typeof meta.cta_kind === "string" ? meta.cta_kind : null,
    outcome,
    ms_visible: typeof meta.ms_visible === "number" ? meta.ms_visible : null,
    ts: ev.ts,
  };
  const { recorded, duplicate } = recordOutcome(ev.session, entry);
  if (recorded) metrics.inc("outcomes");
  // recordEvent() (the same generic per-event live-recording call every
  // other event type gets via processEventCore) also gets this one, so the
  // raw agent_outcome frame shows up in the session's `events` list too —
  // recordOutcome() above is the one that lands it in the queryable
  // `outcomes` array research-routes.js joins against decisions.
  recordEvent(ev, { replay: false });
  res.json({ ok: true, duplicate });
}

app.post("/event", (req, res) => {
  const ev = req.body;
  if (!isValidSessionId(ev?.session)) {
    return res.status(400).json({ error: "bad session id" });
  }
  if (!EVENT_TYPES.includes(ev.type)) {
    return res.status(400).json({ error: "bad event", expected: EVENT_TYPES });
  }

  // Outcome tracking (server/RESEARCH.md "Outcomes" section): agent_outcome
  // is handled ENTIRELY separately from every other event type below — it
  // must never enter session state (processEventCore/pushEvent), never feed
  // gate.js/tick.js's friction signals or buildState()'s `recent` log
  // (those all read session.events, which this branch never touches), and
  // never trigger a decision (no processEventSerial/scheduleCoalescedDecision
  // call here). It's still recorded to the live-recording file (when
  // recording is on) via live-record.js's recordOutcome(), keyed by
  // session and deduped by action_id — see that function for the
  // exactly-one-outcome-per-action-id guarantee (defense in depth alongside
  // the widget's own client-side Set of already-reported ids).
  if (ev.type === "agent_outcome") {
    return handleOutcomeEvent(ev, res);
  }

  // Cached-mode replay isolation: on camera, a live browser tab is pinned to
  // a recorded session's id (see AgentWidget.tsx / agent.js `?agent_session`)
  // while server/replay.js drives that same session id to reproduce the
  // recording. The browser tab keeps emitting its own events too (page_view,
  // dwell heartbeats) — decide/cached.js indexes the recording by
  // session.events.length, so any extra event pushed in from the live tab
  // would shift that index and desync playback. replay.js tags its own
  // POSTs with `x-agent-replay: 1`; for a session that has a recording file,
  // any request WITHOUT that header is acknowledged (200 + a quiet noop
  // trace, so the widget still shows *something*) but never pushed into
  // session state and never sent to decide() — only replay's own events
  // advance the recording index. No-op outside cached mode / for sessions
  // with no recording.
  if (AGENT_MODE === "cached" && req.headers["x-agent-replay"] !== "1" && hasRecording(ev.session)) {
    const trace = {
      ts: Date.now(),
      signals: [],
      hypothesis: "",
      decision: "noop",
      confidence: 0,
      why: "cached demo: live browser event ignored (replay drives this session)",
    };
    broadcast(ev.session, traceMessage(trace));
    return res.json({ ok: true, decision: "noop" });
  }

  // `queued` (in the response) tells the caller whether this event's own
  // decision cycle started now (false) or folded into/behind an
  // already-running one (true) — informational only, the widget doesn't
  // wait on it either way.
  //
  // x-agent-replay: 1 (server/replay.js's own tuning-loop tool) ALSO takes
  // the strict-serial path, in every AGENT_MODE — not just cached/
  // AGENT_RECORD. replay.js paces itself, awaiting one decision per event
  // (that's the whole point of the tool: reproduce a fixture's exact event
  // sequence against a real/stub decider one at a time); under llm/stub
  // mode's normal COALESCING, a burst of replayed events posted faster than
  // the decider responds would collapse into far fewer decisions than
  // events (e.g. an 11-event fixture producing only 2 decisions), and
  // replay.js's own `--settle` window (how long it waits after the last
  // event before closing its WS) is sized for "one decision per event",
  // not for coalescing's "wait for whatever's still pending" — it would
  // close the socket before a coalesced-away decision ever ran. Live
  // browser traffic (no x-agent-replay header) is UNAFFECTED — it still
  // coalesces exactly as before.
  const isReplay = req.headers["x-agent-replay"] === "1";
  let queued;
  if (AGENT_MODE === "cached" || AGENT_RECORD || isReplay) {
    // Strict per-event serial via processEventSerial() (see the module
    // comment above and that function's own doc) — CRITICALLY, this pushes
    // the event into session state (processEventCore) INSIDE the same
    // chained task as its decision, not before/outside it. That ordering
    // is what keeps "one decision per event, decided against exactly that
    // event's own state" true when the decider is slow (a live/stub call
    // taking 10-20s): with a slow decider, POSTs for later events in a
    // fixture arrive and get ACKed long before earlier events' decisions
    // even start running — pushing state eagerly (as the coalesced branch
    // below does, and as this branch itself used to do) would let
    // session.events race ahead of the decision queue, so by the time
    // event 3's decision finally runs it would see event 11's state
    // instead of event 3's (decide/stub.js's "current event" checks, and
    // decide/cached.js's index, both silently decide against the wrong
    // event). Chaining the push itself onto the serial queue means event
    // N's state update literally cannot happen until event N-1's full
    // decision cycle has finished, matching the demo player's (already
    // correct) pacing model exactly. Not awaited by this response —
    // `queued` below is checked BEFORE the chain link for THIS event is
    // added by processEventSerial()/runSerialized(), same information the
    // eager-push version reported.
    queued = sessionChains.has(ev.session);
    metrics.inc("serialEvents");
    processEventSerial(ev, { replay: isReplay }).catch((err) => {
      log.error("unhandled error in serial decision", { session: ev.session, err: String(err?.message ?? err) });
    });
  } else {
    // ---- immediate, never-queued state update (coalesced path only) -----
    // The widget must never wait on the model: validate + pushEvent + LRU
    // eviction + metrics happen synchronously, right here, before the
    // response goes out. Safe to push eagerly on THIS path specifically
    // because the coalesced scheduler is explicitly designed around "decide
    // against whatever is CURRENT" (see decideAndBroadcast's doc) — there's
    // no per-event alignment to preserve, unlike the serial path above.
    let session;
    try {
      session = processEventCore(ev);
    } catch (err) {
      log.error("error processing event", { session: ev.session, err: String(err?.message ?? err) });
      return res.status(500).json({ error: "internal error" });
    }
    // Coalesced (stub/llm) — see scheduleCoalescedDecision() above.
    queued = coalesceStateOf(ev.session).inFlight;
    scheduleCoalescedDecision(session, ev);
  }

  res.json({ ok: true, queued });
});

app.get("/metrics", (_req, res) => res.json(metrics.snapshot()));

// Gated on an explicit opt-in env var, not NODE_ENV — NODE_ENV!=="production"
// meant this endpoint was live by default in every dev/demo run (including
// inside the docker-compose server, which never sets NODE_ENV=production),
// letting anything that can reach the port zero the cost counters mid-run.
// AGENT_METRICS_RESET=1 must be set explicitly (e.g. by cost-compare.js's
// measurement recipe) for this route to exist at all; otherwise 404.
if (process.env.AGENT_METRICS_RESET === "1") {
  app.post("/metrics/reset", (_req, res) => {
    metrics.reset();
    res.json({ ok: true });
  });
}

// Debug-only: last 500 structured log entries. 404 (not just empty/403) when
// AGENT_DEBUG isn't set, so its existence isn't observable from outside.
if (AGENT_DEBUG) {
  app.get("/logs/recent", (req, res) => {
    const n = req.query.n;
    const level = typeof req.query.level === "string" ? req.query.level : undefined;
    res.json(recentLogs(n, level));
  });

  // Dev-only demo aid: wipes ALL server-side memory of one session (events,
  // cooldowns, actedTargets, dwell buckets, this file's own per-session
  // queue-depth/chain entries, decide/llm.js's in-flight flag) so a fixture
  // replay can be retaken on camera without restarting the server — policy's
  // cooldown / never-same-target guards would otherwise remember the first
  // take and deny/alter the second. Gated the same way as /logs/recent: the
  // route doesn't exist at all (plain 404) unless AGENT_DEBUG=1, so it's
  // never reachable on a demo server left running with defaults. Does NOT
  // close the session's WebSockets — the widget (AgentWidget.tsx) has no
  // reconnect-on-close logic, so closing here would leave a pinned demo tab
  // dead instead of live for the retake; resetting server-side state alone
  // is enough, since decide/cached.js's replay index is keyed off
  // session.events.length, which resetSession() zeroes by dropping the
  // session entirely. hasRecording()'s replay-header guard (index.js's
  // x-agent-replay handling above) is unaffected — it only checks for the
  // recording FILE on disk, not session state.
  app.delete("/session/:id", (req, res) => {
    const id = req.params.id;
    if (!isValidSessionId(id)) {
      return res.status(400).json({ error: "bad session id" });
    }
    const existed = resetSessionFully(id);
    log.info("session reset", { session: id, existed });
    res.json({ ok: true, existed });
  });
}

// Research loop (server/RESEARCH.md): list/inspect/label/replay recorded
// live sessions, and force a decision now. Debug-only, same treatment as
// every other route in this block — plain 404 (route not registered) unless
// AGENT_DEBUG=1, checked once here rather than per-route inside
// research-routes.js.
if (AGENT_DEBUG) {
  app.use(
    createResearchRouter({
      broadcast,
      decideAndBroadcast,
      processEventSerial,
      getSession,
      peekSession,
      isSessionDecisionInFlight: (id) => activeDecisionSessions.has(id),
    })
  );
}

// ---- in-page ("no-terminal") demo player -----------------------------------
// Same idea as scripts/demo.sh + server/replay.js, but driven from inside the
// web page instead of a terminal: GET /demo/fixtures lists the fixtures that
// can be played, POST /demo/play/:fixture replays one in-process at
// fixture-scripted timing / `speed`. See DEMO.md's "No-terminal demo"
// section.
//
// Two independent gates, not one:
//   - AGENT_DEBUG=1 is required for POST /demo/play/:fixture to exist at
//     all (plain 404, not 401/403, unless set — same treatment as every
//     other debug route above) AND for GET /demo/fixtures to return
//     anything beyond an empty list.
//   - AGENT_MODE==="cached" is additionally required for the full fixture
//     listing and for an actual play to run — /demo/play would otherwise be
//     an unauthenticated LLM-call amplifier (each play feeds a whole
//     fixture's worth of events through the live decider). Outside cached
//     mode, POST /demo/play/:fixture (when reachable at all, i.e.
//     AGENT_DEBUG=1) responds 409, and GET /demo/fixtures responds 200 []
//     rather than the full list — so a production page's demo-fixtures probe
//     never logs a console 404.

// One playback per fixture SESSION at a time (not globally) — the fixture
// session is also the pinned session id a tab must be on to watch it, so two
// concurrent plays of the same fixture would race each other's events
// through the same per-session state. Different fixtures (different
// sessions) can play concurrently.
const playingDemoSessions = new Set();

function listPlayableFixtures() {
  return listFixtureNames()
    .map((name) => loadFixture(name))
    // f.page != null: a fixture with no page_view event has no page a
    // browser tab could be pinned to watch it play — drop it rather than
    // shipping a non-string `page` to clients that type it as `string`.
    // hasRecording(): only fixtures with a recorded decision sequence at
    // all can be replayed (decide/cached.js).
    // verifyRecording(): the recording must actually reproduce the
    // fixture's declared `expect` — an all-noop recording under a
    // message/highlight expect would visibly do nothing when played.
    .filter((f) => f && f.page != null && hasRecording(f.session) && verifyRecording(f));
}

// Startup visibility: a fixture can have a recording (so hasRecording() is
// true) that still doesn't verify against its own `expect` — log which ones
// got excluded and why, once, so this isn't a silent gap.
for (const name of listFixtureNames()) {
  const f = loadFixture(name);
  if (!f) continue;
  if (f.page == null) {
    log.warn("demo fixture excluded from /demo/fixtures: no page_view event", { fixture: name });
    continue;
  }
  if (!hasRecording(f.session)) continue; // not meant to be playable at all
  if (!verifyRecording(f)) {
    log.warn("demo fixture excluded from /demo/fixtures: recording does not verify against expect", {
      fixture: name,
      session: f.session,
      expect: f.expect,
    });
  }
}

if (AGENT_DEBUG && AGENT_MODE === "cached") {
  app.get("/demo/fixtures", (_req, res) => {
    const list = listPlayableFixtures().map((f) => ({
      name: f.name,
      session: f.session,
      description: f.description,
      expect: f.expect,
      page: f.page,
      events: f.events.length,
    }));
    res.json(list);
  });
} else {
  // Not the full "no-terminal demo" configuration (either AGENT_DEBUG isn't
  // set, or it is but the server isn't in cached mode) — 200 empty list, not
  // 404, so an embedding page's demo-fixtures probe stays quiet.
  app.get("/demo/fixtures", (_req, res) => res.json([]));
}

if (AGENT_DEBUG) {
  app.post("/demo/play/:fixture", (req, res) => {
    // Cached mode only: replaying a fixture feeds a full event sequence
    // through the live decider path. In any other mode that would be an
    // unauthenticated LLM-call amplifier (llm mode) or just meaningless
    // (stub mode has no recording to match against).
    if (AGENT_MODE !== "cached") {
      return res.status(409).json({ error: "demo player requires AGENT_MODE=cached" });
    }

    const name = req.params.fixture;
    if (!FIXTURE_NAME_RE.test(name)) {
      return res.status(400).json({ error: "bad fixture name" });
    }
    const fixture = loadFixture(name);
    if (!fixture || !hasRecording(fixture.session) || !verifyRecording(fixture)) {
      return res.status(404).json({ error: "unknown fixture" });
    }

    const bodySession = req.body?.session;
    if (bodySession !== undefined && bodySession !== null) {
      if (!isValidSessionId(bodySession)) {
        return res.status(400).json({ error: "bad session id" });
      }
      if (bodySession !== fixture.session) {
        log.warn("demo play: session mismatch", { fixture: name, expected: fixture.session, got: bodySession });
        return res.status(400).json({
          error: `this fixture always plays on its own recorded session — open the page with ?agent_session=${fixture.session} first`,
        });
      }
    }

    let speed = Number(req.query.speed);
    if (!Number.isFinite(speed)) speed = 1;
    speed = Math.min(50, Math.max(1, speed));

    if (playingDemoSessions.has(fixture.session)) {
      return res.status(409).json({ error: "already playing", fixture: name, session: fixture.session });
    }
    playingDemoSessions.add(fixture.session);

    resetSessionFully(fixture.session);

    const estimatedMs = Math.round(fixtureDurationMs(fixture) / speed);
    // Hard ceiling on the whole play, independent of any one event's delay —
    // catches a hung decideAndBroadcast() (e.g. a stuck decider call) that would
    // otherwise leave playingDemoSessions permanently marked "playing" and
    // the widget waiting forever for an "end" it will never see.
    const watchdogMs = estimatedMs * 3 + 10_000;
    log.info("demo play start", { fixture: name, session: fixture.session, events: fixture.events.length, speed });
    res.status(202).json({ ok: true, fixture: name, session: fixture.session, events: fixture.events.length, estimatedMs });

    // Feed events asynchronously, after responding — the caller (the web
    // panel) doesn't wait on the whole playback, just watches the session's
    // WS for {kind:"demo"} + the usual trace/action messages.
    (async () => {
      const startedAt = Date.now();
      try {
        broadcast(fixture.session, { kind: "demo", state: "start", fixture: name, events: fixture.events.length });
        for (const ev of fixture.events) {
          if (Date.now() - startedAt > watchdogMs) {
            throw new Error(`watchdog: play exceeded ${watchdogMs}ms`);
          }

          const delay = (ev.delay_ms ?? 0) / speed;
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));

          const body = { ...ev, session: fixture.session, ts: Date.now() };
          delete body.delay_ms;

          // Same per-session ordering as live traffic (runSerialized), same
          // decision path as a real POST /event in cached mode
          // (processEventSerial — core + decideAndBroadcast, chained) — this
          // is an in-process call, not an HTTP self-call, so it never goes
          // through app.post("/event")'s cached-mode replay-header guard at
          // all (that guard only gates requests arriving on the HTTP
          // route). Awaited here (unlike the HTTP route) because the player
          // paces itself by fixture delay between events, not by watching
          // for a broadcast.
          await processEventSerial(body).catch((err) => {
            log.error("demo play: event failed", { fixture: name, session: fixture.session, err: String(err?.message ?? err) });
          });
        }
      } catch (err) {
        const shortMsg = String(err?.message ?? err).slice(0, 200);
        log.error("demo play error", { fixture: name, session: fixture.session, err: shortMsg });
        broadcast(fixture.session, { kind: "demo", state: "error", fixture: name, error: shortMsg });
      } finally {
        broadcast(fixture.session, { kind: "demo", state: "end", fixture: name });
        log.info("demo play end", { fixture: name, session: fixture.session });
        playingDemoSessions.delete(fixture.session);
      }
    })();
  });
}

app.use(createHealthRouter({ sockets, server }));

// Static embed hosting (server/public/{agent.js,demo.html} + /embed) — mounted
// last among the real routes so it never shadows an API route above it.
mountStatic(app);

// Body-parser errors (e.g. the 32KB /event limit) and any other route error
// land here instead of Express's default HTML error page.
app.use((err, req, res, _next) => {
  if (err?.type === "entity.too.large") {
    log.warn("request body too large", { path: req.path });
    return res.status(413).json({ error: "payload too large" });
  }
  log.error("unhandled route error", { path: req.path, err: String(err?.message ?? err) });
  res.status(500).json({ error: "internal error" });
});

server.listen(PORT, () => {
  log.info("agent server listening", { port: PORT, mode: AGENT_MODE });
});
