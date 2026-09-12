// Shared global backpressure counter/helper. Both index.js's /event handler
// and health.js's /health/agent self-test call the same decider
// (decide/index.js's decide()) and must be counted against the SAME
// process-wide in-flight cap (AGENT_MAX_INFLIGHT) — otherwise an
// unauthenticated flood of `/health/agent?force=1` requests (or any other
// future caller of decide()) bypasses index.js's cap entirely and becomes an
// LLM-call amplifier of its own. Kept as its own tiny module (rather than
// exported straight out of index.js) so health.js doesn't have to import
// route-wiring code to get at it.

let inflight = 0;

/** Current count of in-flight decide() calls, process-wide. */
export function inflightCount() {
  return inflight;
}

/** withInflight(fn) — runs fn() with the shared counter incremented for its
 * duration (sync or async fn; always decremented via finally, even on
 * throw/rejection). Returns/rejects with whatever fn() returns/throws. */
export async function withInflight(fn) {
  inflight++;
  try {
    return await fn();
  } finally {
    inflight--;
  }
}
