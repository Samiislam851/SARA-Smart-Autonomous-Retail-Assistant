// Replay-count probe — replays a saved live session's raw events through
// tick.js + gate.js (NO model call, no HTTP) and counts how many events
// would have reached the decider under the current thresholds. This is the
// "cost check" from server/NOTES.md's shopper-pattern-signals fix: before
// the fix, me_1 (a real ~3-minute browsing session, server/sessions/samples/
// me_1.json) called the model 4 times in ~3 minutes even though 8+ friction
// signals existed in the raw events — the pre-model layers were tuned for a
// scripted hover-8-seconds recipe, not real multi-product browsing.
//
// Run standalone: node server/replay-count.test.js
// Run with the suite: node --test server/*.test.js

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSession, resetSession, pushEvent, buildState } from "./state.js";
import { gate, MAX_MODEL_CALLS_PER_MIN } from "./gate.js";
import { shouldCallDecider } from "./tick.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "sessions", "samples", "me_1.json");

// server/sessions/samples/final_tm_242431.json — the live Acme session
// (server/NOTES.md, "model only consulted on signal edges, no floor" defect,
// found live 2026-09-12: session you_2 had 47 events/31 decisions/0 model
// calls before the consult-floor/page-moment/cost-cap fix below) saved via
// `curl -s localhost:4000/sessions/final_tm_242431 > server/sessions/samples/
// final_tm_242431.json`. Research-recording shape ({session, events, ...}),
// not the plain {events:[...]} shape me_1.json uses, but replayCount() only
// ever reads `.events`, so both fixture shapes work unmodified.
const FIXTURE_TM = path.join(__dirname, "sessions", "samples", "final_tm_242431.json");

/**
 * replayCount(fixturePath, sessionId) → { total, wouldCall, callsPerMinute, calls: [{i, type, target, reason}] }
 * Replays every event in order through the real buildState/shouldCallDecider/
 * gate pipeline (same order index.js uses for AGENT_MODE=llm), independent
 * of any model/decide.js call.
 *
 * Known replay-harness gap (consult floor only): index.js's decideAndBroadcast
 * sets session.lastDeciderAt on every ACTUAL decide() call, which is what
 * resets gate.js's consultFloorCheck() timer in production. This harness
 * never calls decide(), so lastDeciderAt stays 0 for the whole replay and
 * the floor's "since last call" baseline stays pinned to the session's own
 * first event throughout — i.e. once floorMs has elapsed since session
 * start, floor.hit stays eligible on every qualifying active event for the
 * rest of the replay, gated only by MAX_MODEL_CALLS_PER_MIN. That makes this
 * harness a pessimistic (upper-bound) count of floor-driven calls, not an
 * exact replica of the real per-call-reset cadence — acceptable for a cost
 * check (worst case still respects the cap) but not for testing the floor's
 * own reset behavior in isolation (gate.test.js (xiv)/(xv)/(xvii) cover that
 * directly against consultFloorCheck()).
 */
export function replayCount(fixturePath, sessionId) {
  const raw = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  const events = raw.events;
  assert.ok(Array.isArray(events) && events.length > 0, `fixture ${fixturePath} must have a non-empty events array`);

  resetSession(sessionId);
  const session = getSession(sessionId);

  const calls = [];
  for (const event of events) {
    pushEvent(session, event);
    const state = buildState(session);
    const trigger = shouldCallDecider(session, event, state);
    if (!trigger) continue;
    const g = gate(state, session, event);
    if (g.pass) calls.push({ i: event.i, type: event.type, target: event.target, reason: g.reason });
  }
  resetSession(sessionId);

  const firstTs = events[0].ts ?? 0;
  const lastTs = events[events.length - 1].ts ?? firstTs;
  const durationMin = Math.max((lastTs - firstTs) / 60000, 1 / 60);

  return {
    total: events.length,
    wouldCall: calls.length,
    callsPerMinute: calls.length / durationMin,
    durationMin,
    calls,
  };
}

function runFixture(fixturePath, label, sessionId) {
  if (!fs.existsSync(fixturePath)) {
    console.log(`[replay-count] fixture not found at ${fixturePath} — skipping (see server/NOTES.md)`);
    return null;
  }
  const result = replayCount(fixturePath, sessionId);
  console.log(
    `[replay-count] ${label}: ${result.total} events over ${result.durationMin.toFixed(1)}min -> ${result.wouldCall} would-call decisions (${result.callsPerMinute.toFixed(2)}/min)`
  );
  for (const c of result.calls) console.log(`  [${c.i}] ${c.type} ${c.target ?? ""} — ${c.reason}`);
  return result;
}

const me1 = runFixture(FIXTURE, "me_1", "replay_count_me_1");
if (me1) {
  // Target from the brief: 2-4 calls per active minute in "normal"
  // sensitivity (default, no AGENT_SENSITIVITY env set here) — a real
  // shopper's session should now surface enough friction signals to be
  // asked about multiple times a minute, not once every ~90s.
  assert.ok(
    me1.callsPerMinute >= 2,
    `expected >= 2 would-call decisions/minute on me_1 under normal sensitivity, got ${me1.callsPerMinute.toFixed(2)}`
  );
}

// final_tm_242431 — see server/NOTES.md, "model only consulted on signal
// edges, no floor" defect: the live session (you_2) that surfaced 0 model
// calls over 47 events/31 decisions before the consult-floor/page-moment/
// cost-cap fix. Post-fix target from the brief: 3-6 would-call decisions per
// minute in "demo" sensitivity, never exceeding MAX_MODEL_CALLS_PER_MIN in
// ANY rolling 60s window regardless of trigger reason (checked directly
// below, not just via the overall average, since a burst under the average
// could still spike over the per-minute cap).
const tm = runFixture(FIXTURE_TM, "final_tm_242431", "replay_count_final_tm");
if (tm) {
  assert.ok(
    tm.callsPerMinute > 0,
    `expected > 0 would-call decisions/minute on final_tm_242431 (was 0 model calls live before this fix), got ${tm.callsPerMinute.toFixed(2)}`
  );
  assert.ok(
    tm.callsPerMinute <= MAX_MODEL_CALLS_PER_MIN + 0.5, // small slack for the fixture's own first/last-event duration rounding
    `expected <= ~${MAX_MODEL_CALLS_PER_MIN}/min average on final_tm_242431, got ${tm.callsPerMinute.toFixed(2)}`
  );
  // Hard per-session cap check: no rolling 60s window of would-call
  // timestamps may exceed MAX_MODEL_CALLS_PER_MIN, regardless of how the
  // calls are distributed across the session. calls[] only carries
  // i/type/target/reason, so re-fetch actual ts values by index from the
  // fixture (already parsed once, cheap for a few hundred events).
  const raw = JSON.parse(fs.readFileSync(FIXTURE_TM, "utf8"));
  const tsByIndex = new Map(raw.events.map((e) => [e.i, e.ts]));
  const callTimestamps = tm.calls.map((c) => tsByIndex.get(c.i)).filter((t) => t !== undefined);
  let maxInWindow = 0;
  for (const t of callTimestamps) {
    const inWindow = callTimestamps.filter((t2) => t2 >= t && t2 - t < 60000).length;
    if (inWindow > maxInWindow) maxInWindow = inWindow;
  }
  assert.ok(
    maxInWindow <= MAX_MODEL_CALLS_PER_MIN,
    `expected no rolling 60s window to exceed the ${MAX_MODEL_CALLS_PER_MIN}/min cap on final_tm_242431, got ${maxInWindow}`
  );
  console.log(`[replay-count] final_tm_242431: max calls in any rolling 60s window = ${maxInWindow} (cap ${MAX_MODEL_CALLS_PER_MIN})`);
}

console.log("replay-count.test: all assertions passed");
