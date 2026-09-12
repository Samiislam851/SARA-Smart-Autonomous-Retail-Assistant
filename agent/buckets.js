// Shared bucketing helpers — used by decide/llm.js (fingerprint cache key)
// and tick.js (signal-class trigger) so both agree on bucket boundaries.
// Moving these here (rather than duplicating) is what keeps "dwell crossed a
// bucket boundary" (tick.js) and "same dwell bucket → same cache key"
// (llm.js) from silently drifting apart.

/** isPageDwellTarget(target, page) → true when a dwell event's `target`
 * refers to the page itself (widget sends dwell with target = page path, or
 * null, for page-level dwell) rather than a specific element (per-element
 * dwell, e.g. "size-guide"). Shared by state.js (buildState), tick.js, and
 * gate.js so all three agree on which dwell events are "page" dwell vs.
 * "target" dwell — a prior drift here (tick.js/gate.js checking
 * state.dwell.pageMs unconditionally, ignoring per-target dwell) silently
 * dropped repeated per-element dwell as a signal; see server/NOTES.md. */
export function isPageDwellTarget(target, page) {
  return !target || target === page || target.startsWith("/");
}

/** bucketDwell(ms) → "0-5s" | "5-20s" | "20-60s" | "60s+" */
export function bucketDwell(ms) {
  const n = Number(ms) || 0;
  if (n < 5000) return "0-5s";
  if (n < 20000) return "5-20s";
  if (n < 60000) return "20-60s";
  return "60s+";
}

/** bucketAttention(ms, multiplier = 1) → "<3s" | "3-5s" | "5-10s" | "10-20s" | "20s+"
 * Per-ELEMENT attention bucketing (dwell.perTarget), boundaries 3/5/10/20s —
 * deliberately finer/different from bucketDwell's 5/20/60s (page-level dwell,
 * used by decide/llm.js's fingerprint cache key; left untouched so that cache
 * doesn't drift). Used by tick.js's signal-class trigger to decide "attention
 * on this element crossed a boundary worth another decider call" — the same
 * 3s/5s thresholds gate.js's return-visit/element-attention rules use, so a
 * bucket crossing here lines up with a signal actually flipping in gate.js.
 * `multiplier` scales the boundaries themselves (see policy-config.js's
 * AGENT_SENSITIVITY: "demo" passes 0.6 so bucket crossings — and thus decider
 * calls — happen sooner during a live demo; labels stay literal to the
 * DEFAULT 3/5/10/20s boundaries regardless of multiplier since they're only
 * ever compared for equality, never shown to a shopper). */
export function bucketAttention(ms, multiplier = 1) {
  const n = Number(ms) || 0;
  const m = Number(multiplier) || 1;
  if (n < 3000 * m) return "<3s";
  if (n < 5000 * m) return "3-5s";
  if (n < 10000 * m) return "5-10s";
  if (n < 20000 * m) return "10-20s";
  return "20s+";
}

/** bucketCart(cart) → "none" | "above" | "below:<gap rounded up to nearest 50>" */
export function bucketCart(cart) {
  if (!cart) return "none";
  const gap = 2000 - (cart.total ?? 0);
  if (gap <= 0) return "above";
  const bucket = Math.ceil(gap / 50) * 50;
  return `below:${bucket}`;
}
