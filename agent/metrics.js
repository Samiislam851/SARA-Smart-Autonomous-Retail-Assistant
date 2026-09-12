// In-process cost counters. No persistence — reset() clears everything,
// and process restart clears everything. Wired into index.js (ticks/quiet
// ticks/gated/sessions), gate.js (nothing — index.js counts gate verdicts),
// and decide/llm.js (llmCalls/cacheHits/cacheMisses/llmErrors/tokens*/llmMs).

const counters = {
  ticks: 0,
  quietTicks: 0,
  gated: 0,
  llmCalls: 0,
  cacheHits: 0,
  cacheMisses: 0,
  llmErrors: 0,
  tokensIn: 0,
  tokensOut: 0,
  tokensTotalCodex: 0,
  llmMsTotal: 0,
};

/** Distinct session ids seen (via inc("sessions", sessionId)). */
const sessionsSeen = new Set();

/**
 * Gauges — point-in-time values (not running totals), set via setGauge().
 * Distinct from `counters` above: reset() clears these back to 0 too, but
 * inc() never touches them. Used for e.g. "inFlightSessions" (index.js) —
 * how many sessions currently have a decideAndBroadcast() call actually
 * executing, right now, as opposed to a cumulative count.
 */
const gauges = {};

/** setGauge(name, value) — overwrites the current value of a point-in-time metric. */
export function setGauge(name, value) {
  gauges[name] = value;
}

/**
 * Whether decide/llm.js's fingerprint cache is enabled this process
 * (LLM_CACHE !== "0"). Set once via setCacheEnabled() at llm.js module init;
 * exposed in the snapshot so a consumer (e.g. cost-compare.js) can tell
 * whether cacheHits/cacheMisses==0 means "no traffic yet" or "cache is off
 * and hit/miss isn't tracked" (M3: when disabled, hits/misses aren't
 * incremented at all, see decide/llm.js). Defaults to true (the LLM_CACHE
 * default) for modes that never import decide/llm.js (stub/cached), where
 * the field is moot since llmCalls stays 0 anyway.
 */
let cacheEnabled = true;

export function setCacheEnabled(v) {
  cacheEnabled = Boolean(v);
}

/**
 * inc(name, n=1) — increments a numeric counter by n.
 * Special case: inc("sessions", sessionId) adds sessionId to a Set instead
 * of adding a number — "sessions" is a distinct-count, not a running total.
 */
export function inc(name, n = 1) {
  if (name === "sessions") {
    sessionsSeen.add(n);
    return;
  }
  if (!(name in counters)) counters[name] = 0;
  counters[name] += n;
}

/** snapshot() → counters + derived rates, safe against divide-by-zero. */
export function snapshot() {
  const c = { ...counters, sessions: sessionsSeen.size };
  const totalCacheLookups = c.cacheHits + c.cacheMisses;
  const derived = {
    callsPerSession: c.sessions > 0 ? c.llmCalls / c.sessions : 0,
    cacheHitRate: totalCacheLookups > 0 ? c.cacheHits / totalCacheLookups : 0,
    tokensPerCallIn: c.llmCalls > 0 ? c.tokensIn / c.llmCalls : 0,
    tokensPerCallOut: c.llmCalls > 0 ? c.tokensOut / c.llmCalls : 0,
    avgLlmMs: c.llmCalls > 0 ? c.llmMsTotal / c.llmCalls : 0,
  };
  return { ...c, cacheEnabled, ...derived, ...gauges };
}

export function reset() {
  for (const k of Object.keys(counters)) counters[k] = 0;
  sessionsSeen.clear();
  for (const k of Object.keys(gauges)) gauges[k] = 0;
}
