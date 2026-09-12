// Layer 0 — deterministic pre-filter, applied only in AGENT_MODE=llm (see
// index.js). Cheap rules that answer noop WITHOUT spending a model call on
// events that obviously don't need one. Runs after tick.js's shouldCallDecider
// already decided the event is a signal-class change (not a quiet tick).
//
// gate(state, session, event) → { pass: boolean, reason: string }
//
// Rewritten (see server/NOTES.md, "gate reasons over event counts, not
// state/time windows" defect class): the old version reasoned over EVENT
// COUNTS ("last 3 events") and over the single TRIGGERING event (e.g. a
// dwell event's own `meta.ms`), never over accumulated state or a real time
// window. At ~1 event/s (live dwell heartbeats), "last 3 events" is ~1-3s of
// history — a back_nav from 40s ago is buried instantly — and a heartbeat
// that happens to be the one crossing 5s pageMs can gate out a completely
// unrelated element with 48s of real attention sitting right there in
// `state.dwell.perTarget`. Every rule below is computed from `state` (the
// CURRENT accumulated situation) and `session.events` timestamps against a
// real wall-clock window, never from array position/count.
//
// computeSignals() is shared with tick.js (server/tick.js) on purpose: both
// modules need to agree on what these eight signals mean and exactly when they
// flip, the same "don't let two places reimplement the same window and drift
// apart" principle buckets.js already documents for isPageDwellTarget/
// bucketDwell.

import { COOLDOWN_MS } from "./policy.js"; // merchant-configurable (AGENT_COOLDOWN_MS), same value policy.js enforces
import { getSensitivityMultiplier, getConsultFloorMs } from "./policy-config.js"; // AGENT_SENSITIVITY: "demo" scales every window/dwell threshold below by 0.6
import { isPageDwellTarget } from "./buckets.js"; // consultFloorCheck's "shopper active" definition — see below

const FREE_DELIVERY_THRESHOLD = 2000; // fallback when neither state.facts.keys.free_delivery_threshold nor state.business.delivery.free_over is present

// AGENT_SENSITIVITY multiplier, resolved once at import (module-level
// singleton, same pattern as COOLDOWN_MS above). "demo" (0.6) makes every
// ms threshold/window below fire sooner; BREADTH_MIN_PRODUCTS is a COUNT,
// not a duration, so it's scaled+floored separately (see below) rather than
// multiplied directly like the ms constants.
const M = getSensitivityMultiplier();

// Re-tuned 2026-09-12 against the me_1 live session (server/NOTES.md has the
// full numbers): the original values were implicitly fit to a scripted
// "hover 8s on one element" recipe, not real multi-product browsing. me_1's
// actual per-ELEMENT attention samples (hover on a product card, size-picker,
// etc — excludes page-level dwell heartbeats) were
// [3218, 3291, 3900, 3901, 6293, 6900, 9291]ms, p50≈3901ms, p60≈5336ms;
// me_1's cart-page glance before leaving was 4600ms (well under the old 8s
// floor, so cartFriction never got a chance to fire on that visit even
// though the gap math would otherwise have qualified it).
const ELEMENT_ATTENTION_MS = 4000 * M; // rule 1 — was 5000; now ~p50 of me_1's real per-element attention, not p60, since p60 (5336ms) barely differs from the old value and still misses most real attention bursts
const RETURN_VISIT_ATTENTION_MS = 2000 * M; // rule 2 — was 3000; lower bar on a return visit
const NAV_FRICTION_WINDOW_MS = 60000 * M; // rule 3 — back_nav / cart<->checkout / product<->cart<->product bounce
const RAGE_CLICK_WINDOW_MS = 30000 * M; // rule 4
// rule 5 — "within 10% under" the free-delivery threshold. Exported so
// server/store/index.js's delivery_gap offer can reuse the exact same
// percentage instead of a second hardcoded copy that could drift from this
// one (same "one place defines a window" principle as computeSignals()
// being shared between gate.js/tick.js).
export const CART_GAP_PCT = 0.10;
const CART_DWELL_MS = 4000 * M; // rule 5 — page dwell floor on cart/checkout; was 8000, me_1's real cart glance was 4600ms
const SEARCH_FRICTION_WINDOW_MS = 60000 * M; // rule 6
export const PROMO_CART_DWELL_MS = CART_DWELL_MS; // rule 7 (promo_missed) reuses the same dwell floor

// New shopper-pattern signals (rules 9-12) — see server/NOTES.md, "pre-model
// layers tuned for scripted hover, not real browsing" defect class. A real
// shopper moves between several products, returns to one, visits cart and
// leaves without checking out, all within normal small windows — none of
// rules 1-8 above fire on that shape by itself.
const PING_PONG_WINDOW_MS = 90000 * M; // rule 9 — same product viewed twice with another page in between
const CART_LEAVE_WINDOW_MS = 60000 * M; // rule 11 — cart page_view then navigation away, no checkout
const RETURN_AFTER_CART_WINDOW_MS = 90000 * M; // rule 12 — a product seen before the cart visit, seen again after
const BREADTH_MIN_PRODUCTS = Math.max(2, Math.round(3 * M)); // rule 10 — distinct products viewed with zero add-to-cart all session

// Consult floor + page-moment trigger + cost cap — added 2026-09-12 (see
// server/NOTES.md, "model only consulted on signal edges, no floor" defect:
// live Acme session you_2 had 47 events/31 decisions/0 model calls,
// every single decision skipped because a normal first minute of browsing
// trips none of the twelve signals above). These three are a distinct
// category from rules 1-12: they don't detect friction, they guarantee the
// model still gets consulted periodically (floor), on real page moments
// (page_moment), and never more than a hard ceiling regardless of reason
// (cap) — see consultFloorCheck/pageMomentCheck/gate() below.

export const CONSULT_FLOOR_MS = getConsultFloorMs(); // AGENT_CONSULT_FLOOR_MS, sensitivity-aware default 30000/20000 — NOT scaled by M, see policy-config.js; exported for gate.test.js/replay-count.test.js introspection
const CONSULT_FLOOR_ACTIVE_WINDOW_MS = 20000; // "shopper active" = >=1 non-heartbeat event in the last 20s

// AGENT_MAX_MODEL_CALLS_PER_MIN — hard cost ceiling, deliberately NOT run
// through policy-config.js's loadPolicyConfig() (this is the one merchant
// knob this fix's file-scope keeps out of that module — see the brief);
// same parse-with-fallback shape as policy-config.js's parseIntEnv, applied
// inline here since it's a single simple int with no sensitivity coupling.
function parseMaxCallsPerMin(raw) {
  if (raw === undefined || raw === null || raw === "") return 6;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    console.warn(`[gate] AGENT_MAX_MODEL_CALLS_PER_MIN=${JSON.stringify(raw)} must be a positive integer — using default (6)`);
    return 6;
  }
  return n;
}
export const MAX_MODEL_CALLS_PER_MIN = parseMaxCallsPerMin(process.env.AGENT_MAX_MODEL_CALLS_PER_MIN);
const RATE_WINDOW_MS = 60000;

/** isHeartbeatEvent(e, page) → true for a page-level dwell tick (the
 * periodic "still on this page" heartbeat, not a real shopper action) —
 * everything else (page_view, cart_*, search, back_nav, rage_click,
 * scroll_depth, and per-ELEMENT dwell) counts as activity for the consult
 * floor. Shares buckets.js's isPageDwellTarget so this can't drift from
 * tick.js/gate.js's own page-vs-element dwell distinction. */
function isHeartbeatEvent(e, page) {
  return e.type === "dwell" && isPageDwellTarget(e.target, page);
}

/**
 * consultFloorCheck(state, session, event, now) → { hit, active, sinceLastCallMs }
 * hit when the shopper is active (>=1 non-heartbeat event in the last
 * CONSULT_FLOOR_ACTIVE_WINDOW_MS) AND it has been at least floorMs since the
 * last model call. "Last model call" baselines to session.lastDeciderAt
 * (set by index.js's decideAndBroadcast the moment a decider call actually
 * starts — reused here rather than a second "last call" field, same
 * one-place-tracks-it principle as computeSignals() being shared between
 * tick.js/gate.js) when the model HAS already been consulted this session;
 * when it hasn't (lastDeciderAt defaults to 0 in state.js), baselines to the
 * session's own FIRST event instead of epoch 0 — a brand new session must
 * get its own floorMs grace period before the floor fires, not be treated
 * as having been "overdue" since the start of Unix time.
 */
export function consultFloorCheck(state, session, event, now, floorMs = CONSULT_FLOOR_MS) {
  const events = session.events || [];
  const active = events.some(
    (e) => !isHeartbeatEvent(e, state.page) && now - (e.ts ?? now) <= CONSULT_FLOOR_ACTIVE_WINDOW_MS
  );
  const baseline = session.lastDeciderAt || events[0]?.ts || now;
  const sinceLastCallMs = now - baseline;
  return { hit: active && sinceLastCallMs >= floorMs, active, sinceLastCallMs };
}

/**
 * pageMomentCheck(state, session, event, now) → { hit, category, priorPageViews }
 * hit when `event` is a page_view landing on a product/cart/checkout page
 * AND the shopper has already made >=2 other page_view events this session
 * (so this isn't itself one of the first couple of pages — those already
 * get tick.js's "first-ever page_view of this path" trigger for free).
 * Reuses classifyPath() so "product/cart/checkout" can't drift from every
 * other rule above that already uses it.
 */
export function pageMomentCheck(state, session, event, now) {
  if (event.type !== "page_view") return { hit: false, category: null, priorPageViews: 0 };
  const category = classifyPath(event.target);
  if (category !== "product" && category !== "cart" && category !== "checkout") {
    return { hit: false, category, priorPageViews: 0 };
  }
  const priorPageViews = (session.events || []).slice(0, -1).filter((e) => e.type === "page_view").length;
  return { hit: priorPageViews >= 2, category, priorPageViews };
}

/** recordModelCall(session, now) → mutate session.modelCallTimestamps
 * (rolling 60s window, pruned on every call) — the ONE place a model call
 * gets counted for MAX_MODEL_CALLS_PER_MIN, whether it passed via a friction
 * signal, the consult floor, or a page moment. Lazily created (same pattern
 * tick.js already uses for lastCartTotal/lastSignalFlags — not initialized
 * in state.js's getSession(), plain session-scoped memoization). */
function recordModelCall(session, now) {
  const pruned = (session.modelCallTimestamps || []).filter((t) => now - t < RATE_WINDOW_MS);
  pruned.push(now);
  session.modelCallTimestamps = pruned;
  return pruned;
}

function classifyPath(path) {
  if (!path) return "other";
  if (path === "/cart") return "cart";
  if (path === "/checkout") return "checkout";
  if (path.startsWith("/product/")) return "product";
  return "other";
}

function maxAttention(perTarget) {
  let bestTarget = null;
  let bestMs = -1;
  for (const [target, ms] of Object.entries(perTarget || {})) {
    if (ms > bestMs) {
      bestMs = ms;
      bestTarget = target;
    }
  }
  return { target: bestTarget, ms: bestMs < 0 ? 0 : bestMs };
}

function pageViewCount(events, path) {
  if (!path) return 0;
  return events.filter((e) => e.type === "page_view" && e.target === path).length;
}

function msSince(events, type, now) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return now - (events[i].ts ?? now);
  }
  return Infinity;
}

// Bounce pattern: any 3 consecutive page_views (chronological, within the
// window) that form cart->checkout->cart or product->cart->product. Detects
// the "arrived at checkout, bounced back to cart" shape even when no
// back_nav event fired (e.g. an in-page "back to cart" link).
function bouncePattern(events, now, windowMs) {
  const cats = events
    .filter((e) => e.type === "page_view" && now - (e.ts ?? now) <= windowMs)
    .map((e) => classifyPath(e.target));
  const patterns = [
    { seq: ["cart", "checkout", "cart"], label: "cart→checkout→cart" },
    { seq: ["product", "cart", "product"], label: "product→cart→product" },
  ];
  for (let i = 0; i + 3 <= cats.length; i++) {
    const window = cats.slice(i, i + 3);
    for (const p of patterns) {
      if (window[0] === p.seq[0] && window[1] === p.seq[1] && window[2] === p.seq[2]) {
        return { hit: true, label: p.label };
      }
    }
  }
  return { hit: false, label: null };
}

function searchFriction(events, now, windowMs) {
  const searches = events.filter((e) => e.type === "search" && now - (e.ts ?? now) <= windowMs);
  for (const s of searches) {
    if (s.meta && s.meta.results === 0) {
      return { hit: true, reason: `zero-result search "${s.meta.q ?? ""}"` };
    }
  }
  const seen = new Map();
  for (const s of searches) {
    const q = String(s.meta?.q ?? "").trim().toLowerCase();
    if (!q) continue;
    const count = (seen.get(q) ?? 0) + 1;
    seen.set(q, count);
    if (count >= 2) return { hit: true, reason: `repeated search "${q}" (${count}x)` };
  }
  return { hit: false, reason: null };
}

// rule 7 — promo_missed: a `missed_discount` store offer exists (see
// server/store/index.js) AND the shopper is hesitating on the cart/checkout
// flow — either dwelling there past PROMO_CART_DWELL_MS, or bouncing
// cart<->checkout (reuses bouncePattern()'s "cart→checkout→cart" label so
// this can't drift from rule 3's own bounce definition).
function promoMissedSignal(state, bounce) {
  const hasMissed = Array.isArray(state.offers) && state.offers.some((o) => o.kind === "missed_discount");
  if (!hasMissed) return { hit: false, hasMissed: false };
  const onCartFlow = state.page === "/cart" || state.page === "/checkout";
  const pageDwellMs = state.dwell?.pageMs ?? 0;
  const dwelling = onCartFlow && pageDwellMs >= PROMO_CART_DWELL_MS;
  const bouncing = bounce.hit && bounce.label === "cart→checkout→cart";
  return { hit: dwelling || bouncing, hasMissed, onCartFlow, pageDwellMs, bouncing };
}

// rule 8 — similar_promo: a `similar_on_promo` store offer exists AND the
// shopper shows repeated attention on the current (non-promo) product —
// reuses the same elementAttention/returnVisit signals rule 1/2 already
// compute, so "what counts as attention" can't drift between the two.
function similarPromoSignal(state, elementAttention, returnVisit) {
  const hasSimilar = Array.isArray(state.offers) && state.offers.some((o) => o.kind === "similar_on_promo");
  return { hit: hasSimilar && (elementAttention || returnVisit), hasSimilar };
}

// rule 9 — product ping-pong: the same product path shows up twice in
// page_view history within the window, with at least one OTHER page_view
// between the two visits (a plain double-view from clicking "back" twice in
// a row without leaving isn't ping-pong — the events array only ever has
// consecutive duplicate page_views for that anyway; the "at least one other
// page_view between" check is what distinguishes "left and came back" from
// noise).
function pingPongSignal(events, now, windowMs) {
  const pv = events.filter((e) => e.type === "page_view" && now - (e.ts ?? now) <= windowMs);
  const lastSeenAt = new Map();
  for (let i = 0; i < pv.length; i++) {
    const e = pv[i];
    if (classifyPath(e.target) !== "product") continue;
    const prevIdx = lastSeenAt.get(e.target);
    if (prevIdx !== undefined && i - prevIdx >= 2) {
      return { hit: true, path: e.target };
    }
    lastSeenAt.set(e.target, i);
  }
  return { hit: false, path: null };
}

// rule 10 — breadth without commit: several distinct products looked at
// this session, never a single add-to-cart. Session-wide (no time window —
// "browsed a lot, never committed" is a whole-session shape, not a recent-
// window one); cart-add is identified the same way tick.js's cartTotalTrigger
// and gate.js's cartFrictionSignal read cart state, via the cart_update
// event's target ("cart-add" per the web widget's contract).
function breadthNoCommitSignal(events) {
  const distinctProducts = new Set(
    events.filter((e) => e.type === "page_view" && classifyPath(e.target) === "product").map((e) => e.target)
  );
  const hasAddedToCart = events.some((e) => e.type === "cart_update" && e.target === "cart-add");
  return { hit: distinctProducts.size >= BREADTH_MIN_PRODUCTS && !hasAddedToCart, count: distinctProducts.size };
}

// rule 11 — cart-visit-and-leave: shopper looked at the cart, then moved on
// to a non-checkout page without checking out, within the window. Distinct
// from rule 3's bounce pattern (cart->checkout->cart), which needs the
// shopper to have reached checkout first; this fires on the far more common
// "peeked at cart, went back to browsing" shape that never touches checkout
// at all.
function cartLeaveSignal(events, now, windowMs) {
  let cartIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "page_view" && classifyPath(events[i].target) === "cart") cartIdx = i;
  }
  if (cartIdx === -1) return { hit: false };
  for (let i = cartIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type !== "page_view") continue;
    const cat = classifyPath(e.target);
    if (cat === "checkout") return { hit: false }; // went on to checkout, not a "leave"
    return { hit: now - (e.ts ?? now) <= windowMs, leftTo: e.target };
  }
  return { hit: false }; // hasn't navigated away from cart yet
}

// rule 12 — return-to-product-after-cart: a product seen BEFORE the most
// recent cart visit is seen again AFTER it, within the window — the shopper
// went back to compare/reconsider something they'd already looked at before
// checking their cart.
function returnAfterCartSignal(events, now, windowMs) {
  let cartIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === "page_view" && classifyPath(events[i].target) === "cart") cartIdx = i;
  }
  if (cartIdx === -1) return { hit: false, path: null };
  const seenBefore = new Set(
    events.slice(0, cartIdx).filter((e) => e.type === "page_view" && classifyPath(e.target) === "product").map((e) => e.target)
  );
  for (let i = cartIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type === "page_view" && classifyPath(e.target) === "product" && seenBefore.has(e.target)) {
      if (now - (e.ts ?? now) <= windowMs) return { hit: true, path: e.target };
    }
  }
  return { hit: false, path: null };
}

function cartFrictionSignal(state) {
  if (!state.cart) return { hit: false, gap: null, threshold: null };
  const threshold =
    state.facts?.keys?.free_delivery_threshold ??
    state.business?.delivery?.free_over ??
    FREE_DELIVERY_THRESHOLD;
  const gap = threshold - (state.cart.total ?? 0);
  const onCartFlow = state.page === "/cart" || state.page === "/checkout";
  const pageDwellMs = state.dwell?.pageMs ?? 0;
  const withinGap = gap > 0 && gap <= threshold * CART_GAP_PCT;
  return {
    hit: withinGap && onCartFlow && pageDwellMs >= CART_DWELL_MS,
    gap,
    threshold,
    onCartFlow,
    pageDwellMs,
  };
}

/**
 * computeSignals(state, session, now) → twelve friction signals (six original
 * behavioral + two store-offer-driven + four shopper-pattern signals added
 * 2026-09-12: pingPong, breadthNoCommit, cartLeave, returnAfterCart) plus the
 * raw numbers behind each, computed purely from `state` and
 * `session.events` timestamps vs. `now`. No side effects; safe to call from
 * both gate.js and tick.js.
 */
export function computeSignals(state, session, now) {
  const events = session.events || [];
  const perTarget = state.dwell?.perTarget || {};
  const attention = maxAttention(perTarget);

  const elementAttention = attention.ms >= ELEMENT_ATTENTION_MS;

  const visits = pageViewCount(events, state.page);
  const returnVisit = visits >= 2 && attention.ms >= RETURN_VISIT_ATTENTION_MS;

  const backNavAgoMs = msSince(events, "back_nav", now);
  const bounce = bouncePattern(events, now, NAV_FRICTION_WINDOW_MS);
  const navFriction = backNavAgoMs <= NAV_FRICTION_WINDOW_MS || bounce.hit;

  const rageAgoMs = msSince(events, "rage_click", now);
  const rageClick = rageAgoMs <= RAGE_CLICK_WINDOW_MS;

  const cart = cartFrictionSignal(state);

  const search = searchFriction(events, now, SEARCH_FRICTION_WINDOW_MS);

  const promoMissed = promoMissedSignal(state, bounce);
  const similarPromo = similarPromoSignal(state, elementAttention, returnVisit);

  const pingPong = pingPongSignal(events, now, PING_PONG_WINDOW_MS);
  const breadthNoCommit = breadthNoCommitSignal(events);
  const cartLeave = cartLeaveSignal(events, now, CART_LEAVE_WINDOW_MS);
  const returnAfterCart = returnAfterCartSignal(events, now, RETURN_AFTER_CART_WINDOW_MS);

  return {
    attention,
    elementAttention,
    visits,
    returnVisit,
    backNavAgoMs,
    bounce,
    navFriction,
    rageAgoMs,
    rageClick,
    cartFriction: cart,
    searchFriction: search,
    promoMissed,
    similarPromo,
    pingPong,
    breadthNoCommit,
    cartLeave,
    returnAfterCart,
  };
}

export function gate(state, session, event) {
  const now = event?.ts ?? Date.now();

  // We just intervened; asking the model again inside the cooldown window is
  // wasted spend since policy.js would deny any non-noop proposal anyway.
  if (state.lastIntervention && state.lastIntervention.agoMs < COOLDOWN_MS) {
    return {
      pass: false,
      reason: `cooldown: non-noop intervention ${Math.round(state.lastIntervention.agoMs / 1000)}s ago (< ${Math.round(COOLDOWN_MS / 1000)}s)`,
    };
  }

  // Cost guard: hard cap on model calls per session per rolling 60s window,
  // across EVERY reason below (signals, floor, page_moment) — checked right
  // after the cooldown hard-guard and before any reason-specific pass, so
  // nothing below can exceed it. Floor/page_moment (unlike rules 1-12) are
  // engineered to fire on their own timer/page-moment rather than a real
  // spike in friction, so this is what stops a long quiet-but-active session
  // from burning unlimited model calls on floor alone.
  const recentCalls = (session.modelCallTimestamps || []).filter((t) => now - t < RATE_WINDOW_MS);
  session.modelCallTimestamps = recentCalls;
  if (recentCalls.length >= MAX_MODEL_CALLS_PER_MIN) {
    const floorCandidate = consultFloorCheck(state, session, event, now);
    // Once the cap saturates, floor.hit stays true for every subsequent
    // event (lastDeciderAt can't advance — the call keeps getting trimmed),
    // which would otherwise log once per event for as long as the shopper
    // stays active. Dedup to at most one warning per RATE_WINDOW_MS per
    // session so a busy session logs "trimming" rather than flooding logs.
    const lastWarnAt = session.lastRateCapWarnAt || 0;
    if (floorCandidate.hit && now - lastWarnAt >= RATE_WINDOW_MS) {
      session.lastRateCapWarnAt = now;
      console.warn(
        `[gate] rate cap trimmed a floor call: session=${session.id ?? "?"} ${recentCalls.length}/${MAX_MODEL_CALLS_PER_MIN} model calls in the last ${RATE_WINDOW_MS / 1000}s`
      );
    }
    return {
      pass: false,
      reason: `rate capped: ${recentCalls.length}/${MAX_MODEL_CALLS_PER_MIN} model calls in the last ${RATE_WINDOW_MS / 1000}s`,
    };
  }

  const sig = computeSignals(state, session, now);

  if (sig.elementAttention) {
    recordModelCall(session, now);
    return {
      pass: true,
      reason: `element attention: ${sig.attention.target} ${(sig.attention.ms / 1000).toFixed(1)}s >= 5s on current page`,
    };
  }

  if (sig.returnVisit) {
    recordModelCall(session, now);
    return {
      pass: true,
      reason: `return visit: ${state.page} viewed ${sig.visits}x, attention ${sig.attention.target} ${(sig.attention.ms / 1000).toFixed(1)}s >= 3s`,
    };
  }

  if (sig.navFriction) {
    const reason =
      sig.backNavAgoMs <= NAV_FRICTION_WINDOW_MS
        ? `back_nav ${(sig.backNavAgoMs / 1000).toFixed(1)}s ago (< 60s)`
        : `bounce pattern ${sig.bounce.label} within 60s`;
    recordModelCall(session, now);
    return { pass: true, reason: `navigation friction: ${reason}` };
  }

  if (sig.rageClick) {
    recordModelCall(session, now);
    return { pass: true, reason: `rage click ${(sig.rageAgoMs / 1000).toFixed(1)}s ago (< 30s)` };
  }

  if (sig.cartFriction.hit) {
    recordModelCall(session, now);
    return {
      pass: true,
      reason: `cart friction: gap ৳${sig.cartFriction.gap} <= 10% of ৳${sig.cartFriction.threshold} on ${state.page}, page dwell ${(sig.cartFriction.pageDwellMs / 1000).toFixed(1)}s >= 8s`,
    };
  }

  if (sig.promoMissed.hit) {
    const reason = sig.promoMissed.bouncing
      ? "bounce pattern cart→checkout→cart within 60s"
      : `page dwell ${(sig.promoMissed.pageDwellMs / 1000).toFixed(1)}s >= 8s on ${state.page}`;
    recordModelCall(session, now);
    return { pass: true, reason: `promo missed: unapplied code offer in cart, ${reason}` };
  }

  if (sig.similarPromo.hit) {
    recordModelCall(session, now);
    return {
      pass: true,
      reason: `similar promo: current product not on promo, a similar product is — ${sig.returnVisit ? "return visit" : "element attention"} on this page`,
    };
  }

  if (sig.searchFriction.hit) {
    recordModelCall(session, now);
    return { pass: true, reason: `search friction: ${sig.searchFriction.reason} within 60s` };
  }

  if (sig.pingPong.hit) {
    recordModelCall(session, now);
    return {
      pass: true,
      reason: `product ping-pong: ${sig.pingPong.path} viewed again after browsing elsewhere, within ${Math.round(PING_PONG_WINDOW_MS / 1000)}s`,
    };
  }

  if (sig.cartLeave.hit) {
    recordModelCall(session, now);
    return {
      pass: true,
      reason: `cart visit and leave: navigated to ${sig.cartLeave.leftTo} without checkout, within ${Math.round(CART_LEAVE_WINDOW_MS / 1000)}s of cart`,
    };
  }

  if (sig.returnAfterCart.hit) {
    recordModelCall(session, now);
    return {
      pass: true,
      reason: `return to product after cart: ${sig.returnAfterCart.path} revisited within ${Math.round(RETURN_AFTER_CART_WINDOW_MS / 1000)}s of cart visit`,
    };
  }

  if (sig.breadthNoCommit.hit) {
    recordModelCall(session, now);
    return {
      pass: true,
      reason: `breadth without commit: ${sig.breadthNoCommit.count} distinct products viewed, no add-to-cart this session`,
    };
  }

  // Consult floor / page moment: fallback ONLY — every rule above (1-12)
  // already gets first say, so an actual friction signal always keeps its
  // own specific reason. These two exist for the opposite case: NOTHING
  // above fired, which under the old rules meant silence for as long as the
  // shopper kept browsing quietly (see server/NOTES.md, "model only
  // consulted on signal edges, no floor" defect: live 2026-09-12, session
  // you_2, 47 events/31 decisions/0 model calls — a normal first minute of
  // browsing trips none of rules 1-12). Checked here, past the cooldown and
  // rate-cap hard guards above but past every real signal too, so floor
  // never masks something the model would actually have something to act
  // on.
  const floor = consultFloorCheck(state, session, event, now);
  if (floor.hit) {
    recordModelCall(session, now);
    const since = session.lastDeciderAt
      ? `no model call in ${Math.round(floor.sinceLastCallMs / 1000)}s (>= ${Math.round(CONSULT_FLOOR_MS / 1000)}s)`
      : "no model call yet this session";
    return { pass: true, reason: `floor: ${since}, shopper active` };
  }

  const pageMoment = pageMomentCheck(state, session, event, now);
  if (pageMoment.hit) {
    recordModelCall(session, now);
    return {
      pass: true,
      reason: `page moment: ${pageMoment.category} page after ${pageMoment.priorPageViews} prior page views this session`,
    };
  }

  const backNavPresent = sig.backNavAgoMs <= NAV_FRICTION_WINDOW_MS ? "back_nav present" : "no back_nav";
  const cartDesc = state.cart ? `৳${state.cart.total} (gap ৳${sig.cartFriction.gap ?? "?"})` : "none";
  return {
    pass: false,
    reason: `no friction signal in last 60s: max attention ${(sig.attention.ms / 1000).toFixed(1)}s, ${backNavPresent}, cart ${cartDesc}`,
  };
}
