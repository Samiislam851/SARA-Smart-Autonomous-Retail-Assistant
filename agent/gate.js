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
import { getSensitivityMultiplier, getConsultFloorMs, policyConfig } from "./policy-config.js"; // AGENT_SENSITIVITY: "demo" scales every window/dwell threshold below by 0.6
import { isPageDwellTarget } from "./buckets.js"; // consultFloorCheck's "shopper active" definition — see below
import { formatMoney } from "./store/currency.js"; // gate reasons must never hardcode ৳ — see server/store/currency.js's header comment

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

// Context-aware trigger signals (server/docs/BEHAVIOR-MATRIX.md P0 list,
// added 2026-09-12) — rules 13-19. Each reasons over a discrete client
// event (contracts.js EVENT_TYPES) rather than a dwell/window recompute,
// same "the client is the source of truth for the moment, gate.js just
// checks recency" shape as rule 4 (rage_click)/rule 3's backNavAgoMs.
const EXIT_INTENT_WINDOW_MS = 15000 * M; // rule 13 — exit_intent event just happened
const ATC_HESITATION_WINDOW_MS = 15000 * M; // rule 14
const VARIANT_CHURN_WINDOW_MS = 30000 * M; // rule 15 — >=2 variant_switch within this window, no cart-add since
const VARIANT_CHURN_MIN_SWITCHES = 2;
const PROMO_FOCUS_EMPTY_WINDOW_MS = 15000 * M; // rule 16
const TOTAL_DWELL_MS = 4000 * M; // rule 17 — element attention on a cart/checkout total line
const TOTAL_DWELL_TARGETS = ["cart-total", "checkout-total", "shipping-line"];
const SEARCH_REFINE_WINDOW_MS = 60000 * M; // rule 18 — >=2 consecutive DIFFERENT queries within this window
const SCROLL_UTURN_WINDOW_MS = 15000 * M; // rule 19 — scroll_uturn event just happened (on a product page)
const IDLE_MS = 20000 * M; // rule 20 — no real input for this long, tab visible, on PDP/cart — lowest priority (checked after every other rule and the floor)

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
// Sensitivity-aware default (2026-09-12 "trigger pops more frequently"
// brief) — same pattern as policy-config.js's MAX_NUDGES_DEFAULTS/
// CONSULT_FLOOR_DEFAULTS: "demo" gets a looser default (8) so a live demo
// session isn't rate-capped as readily as a real shopper session (6),
// without a merchant having to also set AGENT_MAX_MODEL_CALLS_PER_MIN by
// hand. An explicit env value always overrides either default.
const MAX_CALLS_PER_MIN_DEFAULTS = Object.freeze({ normal: 6, demo: 8 });

function parseMaxCallsPerMin(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    console.warn(`[gate] AGENT_MAX_MODEL_CALLS_PER_MIN=${JSON.stringify(raw)} must be a positive integer — using default (${fallback})`);
    return fallback;
  }
  return n;
}
export const MAX_MODEL_CALLS_PER_MIN = parseMaxCallsPerMin(
  process.env.AGENT_MAX_MODEL_CALLS_PER_MIN,
  MAX_CALLS_PER_MIN_DEFAULTS[policyConfig.sensitivity] ?? MAX_CALLS_PER_MIN_DEFAULTS.normal
);
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

// "trigger pops a little more frequently, based on scanned site context"
// brief (2026-09-12): a page_context arrival carrying a "strong fact" is
// itself a gate signal, once per page path per session — the shopper just
// landed on a page with a real, actionable fact (low stock, a near
// free-shipping gap, their selected variant sold out) and gate.js's rules
// 1-20 above may not fire on a fresh landing with no dwell/friction yet.
const LOW_STOCK_MAX_N = 5; // "only N left" counts as strong when N is this small or less
const FREE_SHIPPING_GAP_PCT = 0.20; // gap must be < this fraction of subtotal to count as "strong"

/**
 * pageFactCheck(state, session, event) → { hit, path, kind }
 * kind: "low_stock" | "free_shipping_gap" | "variant_out_of_stock" | null.
 * Only considers the event that JUST arrived (event.type === "page_context")
 * and only fires once per page path per session (session.pageFactPaths).
 */
export function pageFactCheck(state, session, event) {
  if (event.type !== "page_context") return { hit: false, path: null, kind: null };
  const path = event.target ?? state.page ?? null;
  const seen = session.pageFactPaths || (session.pageFactPaths = new Set());
  if (path && seen.has(path)) return { hit: false, path, kind: null };

  const page = state.page_context;
  const econ = state.cart_economics;
  let kind = null;
  if (page?.stock?.lowStockN != null && page.stock.lowStockN <= LOW_STOCK_MAX_N) {
    kind = "low_stock";
  } else if (econ && econ.gapToFreeShipping > 0 && econ.subtotal > 0 && econ.gapToFreeShipping / econ.subtotal < FREE_SHIPPING_GAP_PCT) {
    kind = "free_shipping_gap";
  } else if (page?.type === "product" && page?.variants?.unavailableJoined) {
    kind = "variant_out_of_stock";
  }
  if (!kind) return { hit: false, path, kind: null };
  return { hit: true, path, kind };
}

// "Undecided comparer" brief (2026-09-12): 2+ product pages in the SAME
// category viewed within this window, with the specs/details section
// reached (spec_seen) on fewer than every one of them — a shopper
// ping-ponging between similar products without ever reading what tells
// them apart. Fires at most once per session (session.undecidedCompareFired)
// since it's a session-shape signal, not a per-page one.
const UNDECIDED_COMPARE_WINDOW_MS = 180000; // 3 minutes

/**
 * undecidedCompareCheck(state, session, now) → { hit, categories }
 * Reads session.pageContext directly (not just the latest page_context
 * event) since it needs the LAST TWO product pages' own scans, not just the
 * current one. Requires store.js's productSlugFromPage/catalog lookup to
 * resolve each page_context path to a category — done by the caller
 * (buildState already resolved `state.spec_diff` off the same data), so
 * this check just asks "does a real spec_diff exist AND was at least one
 * of the two pages never scrolled to its specs section".
 */
export function undecidedCompareCheck(state, session, now) {
  if (session.undecidedCompareFired) return { hit: false };
  if (!state.spec_diff) return { hit: false };
  const byPath = session.pageContext?.byPath || {};
  const currentSpecSeen = Boolean(byPath[state.page]?.spec_seen);
  const otherSpecSeen = Boolean(byPath[state.spec_diff.other_path]?.spec_seen);
  const history = session.pageContext?.history || [];
  const otherEntry = history.find((h) => h.path === state.spec_diff.other_path);
  const withinWindow = otherEntry ? now - otherEntry.ts <= UNDECIDED_COMPARE_WINDOW_MS : false;
  if (!withinWindow) return { hit: false };
  if (currentSpecSeen && otherSpecSeen) return { hit: false }; // both reached specs — not "undecided", just thorough
  return { hit: true };
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

// rule 13 — exit_intent: the widget already gates this to once per session
// client-side (mouse left the viewport upward, or the tab was hidden >3s
// then came back) — gate.js just checks recency of the most recent one.
function exitIntentSignal(events, now, windowMs) {
  const ms = msSince(events, "exit_intent", now);
  return { hit: ms <= windowMs, agoMs: ms };
}

// rule 14 — atc_hesitation: hovered/focused the add-to-cart control without
// clicking it (agent.js decides the 1.5s/2-hover threshold; gate.js just
// checks recency, same shape as rage_click).
function atcHesitationSignal(events, now, windowMs) {
  const ms = msSince(events, "atc_hesitation", now);
  return { hit: ms <= windowMs, agoMs: ms };
}

// rule 15 — variant_churn: >=2 variant_switch events within the window,
// with no cart-add since the first of those switches (an add-to-cart right
// after switching once is normal shopping, not churn).
function variantChurnSignal(events, now, windowMs, minSwitches) {
  const switches = events.filter((e) => e.type === "variant_switch" && now - (e.ts ?? now) <= windowMs);
  if (switches.length < minSwitches) return { hit: false, count: switches.length };
  const firstSwitchTs = switches[0].ts ?? now;
  const addedSince = events.some((e) => e.type === "cart_update" && e.target === "cart-add" && (e.ts ?? now) >= firstSwitchTs);
  return { hit: !addedSince, count: switches.length };
}

// rule 16 — promo_focus_empty: focused the promo code field and blurred it
// empty (agent.js reports meta.empty; a blur with a code typed is not a
// signal — the shopper may just be about to click Apply).
function promoFocusEmptySignal(events, now, windowMs) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "promo_focus_blur") continue;
    const ms = now - (e.ts ?? now);
    return { hit: ms <= windowMs && !!e.meta?.empty, agoMs: ms };
  }
  return { hit: false, agoMs: Infinity };
}

// rule 17 — total_dwell: real attention (not mere visibility — same
// perTarget attention map rule 1 uses) on the cart/checkout total or
// shipping line — a shopper staring at the number, not just glancing at it.
function totalDwellSignal(perTarget, thresholdMs, targets) {
  for (const t of targets) {
    const ms = perTarget?.[t] ?? 0;
    if (ms >= thresholdMs) return { hit: true, target: t, ms };
  }
  return { hit: false, target: null, ms: 0 };
}

// rule 18 — search_refine: >=2 CONSECUTIVE searches this window with a
// DIFFERENT (non-empty) query each time — distinct from searchFriction's
// "same query repeated" rule above; refining ("kantha" -> "kantha scarf")
// is its own friction shape (can't find it, keeps narrowing).
function searchRefineSignal(events, now, windowMs) {
  const searches = events
    .filter((e) => e.type === "search" && now - (e.ts ?? now) <= windowMs)
    .map((e) => String(e.meta?.q ?? "").trim().toLowerCase())
    .filter((q) => q.length > 0);
  let refines = 0;
  for (let i = 1; i < searches.length; i++) {
    if (searches[i] !== searches[i - 1]) refines++;
  }
  return { hit: searches.length >= 2 && refines >= 1, distinctCount: searches.length };
}

// rule 19 — scroll_uturn: the widget itself computes the down->top-within-5s
// shape (needs continuous scroll position tracking agent.js already does
// for scroll_depth); gate.js just checks recency, on a product page only
// (a cart-page scroll u-turn isn't a meaningful "still deciding" signal).
function scrollUturnSignal(state, events, now, windowMs) {
  if (!state.page || !state.page.startsWith("/product/")) return { hit: false, agoMs: Infinity };
  const ms = msSince(events, "scroll_uturn", now);
  return { hit: ms <= windowMs, agoMs: ms };
}

// rule 20 — idle: no real (non-heartbeat) input for idleMs while the tab is
// visible, on a product or cart page. Lowest-priority signal (checked last,
// after even the consult floor) — a low-priority nudge, not friction, so
// every actual friction signal above always wins first say.
function idleSignal(state, events, now, idleMs) {
  if (state.page !== "/cart" && !(state.page || "").startsWith("/product/")) return { hit: false, sinceMs: 0 };
  if (!events.length) return { hit: false, sinceMs: 0 };
  const lastReal = [...events].reverse().find((e) => !isHeartbeatEvent(e, state.page));
  if (!lastReal) return { hit: false, sinceMs: 0 };
  const sinceMs = now - (lastReal.ts ?? now);
  return { hit: sinceMs >= idleMs, sinceMs };
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

  const exitIntent = exitIntentSignal(events, now, EXIT_INTENT_WINDOW_MS);
  const atcHesitation = atcHesitationSignal(events, now, ATC_HESITATION_WINDOW_MS);
  const variantChurn = variantChurnSignal(events, now, VARIANT_CHURN_WINDOW_MS, VARIANT_CHURN_MIN_SWITCHES);
  const promoFocusEmpty = promoFocusEmptySignal(events, now, PROMO_FOCUS_EMPTY_WINDOW_MS);
  const totalDwell = totalDwellSignal(perTarget, TOTAL_DWELL_MS, TOTAL_DWELL_TARGETS);
  const searchRefine = searchRefineSignal(events, now, SEARCH_REFINE_WINDOW_MS);
  const scrollUturn = scrollUturnSignal(state, events, now, SCROLL_UTURN_WINDOW_MS);
  const idle = idleSignal(state, events, now, IDLE_MS);

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
    exitIntent,
    atcHesitation,
    variantChurn,
    promoFocusEmpty,
    totalDwell,
    searchRefine,
    scrollUturn,
    idle,
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

  // page_fact / undecided_compare (2026-09-12 brief): checked right after
  // computing sig, ahead of the friction cascade below — these are page-
  // landing moments (the shopper just arrived with a real fact in hand),
  // not friction accumulated over a dwell window, so they get first say
  // rather than waiting for rules 1-20 to fail first.
  const pageFact = pageFactCheck(state, session, event);
  if (pageFact.hit) {
    session.pageFactPaths.add(pageFact.path);
    recordModelCall(session, now);
    return { pass: true, reason: `page fact: ${pageFact.kind} on ${pageFact.path}` };
  }

  const undecidedCompare = undecidedCompareCheck(state, session, now);
  if (undecidedCompare.hit) {
    session.undecidedCompareFired = true;
    recordModelCall(session, now);
    return {
      pass: true,
      reason: `undecided compare: ${state.page} vs ${state.spec_diff.other_path}, specs not seen on both`,
    };
  }

  // total_dwell is checked BEFORE the generic elementAttention rule below:
  // both watch the same perTarget attention map at the same threshold, so
  // without this ordering a cart-total/checkout-total attention hit would
  // always be reported as the generic "element attention" reason and the
  // more specific total_dwell template/reason would be unreachable.
  if (sig.totalDwell.hit) {
    recordModelCall(session, now);
    return {
      pass: true,
      reason: `total dwell: ${sig.totalDwell.target} attention ${(sig.totalDwell.ms / 1000).toFixed(1)}s >= ${Math.round(TOTAL_DWELL_MS / 1000)}s`,
    };
  }

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
      reason: `cart friction: gap ${formatMoney(sig.cartFriction.gap, state.business?.currency)} <= 10% of ${formatMoney(sig.cartFriction.threshold, state.business?.currency)} on ${state.page}, page dwell ${(sig.cartFriction.pageDwellMs / 1000).toFixed(1)}s >= 8s`,
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

  if (sig.exitIntent.hit) {
    recordModelCall(session, now);
    return { pass: true, reason: `exit intent: ${(sig.exitIntent.agoMs / 1000).toFixed(1)}s ago` };
  }

  if (sig.atcHesitation.hit) {
    recordModelCall(session, now);
    return { pass: true, reason: `add-to-cart hesitation: ${(sig.atcHesitation.agoMs / 1000).toFixed(1)}s ago` };
  }

  if (sig.variantChurn.hit) {
    recordModelCall(session, now);
    return {
      pass: true,
      reason: `variant churn: ${sig.variantChurn.count} option switches within ${Math.round(VARIANT_CHURN_WINDOW_MS / 1000)}s, no add-to-cart`,
    };
  }

  if (sig.promoFocusEmpty.hit) {
    recordModelCall(session, now);
    return { pass: true, reason: `promo code focused then left empty ${(sig.promoFocusEmpty.agoMs / 1000).toFixed(1)}s ago` };
  }

  if (sig.searchRefine.hit) {
    recordModelCall(session, now);
    return {
      pass: true,
      reason: `search refine: ${sig.searchRefine.distinctCount} queries within ${Math.round(SEARCH_REFINE_WINDOW_MS / 1000)}s, narrowing`,
    };
  }

  if (sig.scrollUturn.hit) {
    recordModelCall(session, now);
    return { pass: true, reason: `scroll u-turn on ${state.page}: ${(sig.scrollUturn.agoMs / 1000).toFixed(1)}s ago` };
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

  if (sig.idle.hit) {
    recordModelCall(session, now);
    return { pass: true, reason: `idle: no input for ${Math.round(sig.idle.sinceMs / 1000)}s on ${state.page} (>= ${Math.round(IDLE_MS / 1000)}s), tab visible` };
  }

  const backNavPresent = sig.backNavAgoMs <= NAV_FRICTION_WINDOW_MS ? "back_nav present" : "no back_nav";
  const cartDesc = state.cart
    ? `${formatMoney(state.cart.total, state.business?.currency)} (gap ${sig.cartFriction.gap != null ? formatMoney(sig.cartFriction.gap, state.business?.currency) : "?"})`
    : "none";
  return {
    pass: false,
    reason: `no friction signal in last 60s: max attention ${(sig.attention.ms / 1000).toFixed(1)}s, ${backNavPresent}, cart ${cartDesc}`,
  };
}

// ---- signal name / template hint map --------------------------------------
// Machine-readable counterpart of prompts/decide.md's "Context-aware trigger
// templates" prose table (reason prefix -> template id) — added so
// server/decide/llm.js can hand the model an explicit `signals_fired: [...]`
// array (the SIGNAL NAME, e.g. "variant_churn") with a `for_signals` map to
// the matching template id, instead of making the model re-parse gate.js's
// own free-text `reason` string to guess which template it implies.
// server/index.js also uses this to put a `signals` array on the decision
// record for observability (server/NOTES.md "generic reasons in the log"
// defect class) — so server.log/the trace panel can say "variant churn ->
// card variant_help" instead of just "reason: llm".
//
// One entry per rule 13-19 context-aware trigger PLUS idle (rule 20, lowest
// priority) — the eight reasons that have a matching template in
// prompts/templates.json's "Context-aware trigger templates". Rules 1-12
// (the original behavioral signals + shopper-pattern flags) don't get a
// single-template mapping here — they ground a `card` via `offers`/
// `patterns` fields directly (see decide.md's "Card recipes"), not via a
// gate-reason-name -> template lookup, so they're intentionally absent.
const SIGNAL_TEMPLATE_MAP = [
  { name: "exit_intent", prefix: "exit intent:", template: "exit_intent_help" },
  { name: "atc_hesitation", prefix: "add-to-cart hesitation:", template: "atc_nudge" },
  { name: "variant_churn", prefix: "variant churn:", template: "variant_help" },
  { name: "promo_focus_empty", prefix: "promo code focused", template: "promo_hint" },
  { name: "total_dwell", prefix: "total dwell:", template: "total_reassure" },
  { name: "search_refine", prefix: "search refine:", template: "search_refine_help" },
  { name: "idle", prefix: "idle:", template: "idle_check_in" },
  // Page-scan-context templates (2026-09-12 brief) — page_fact's `kind`
  // selects which template, undecided_compare always maps to spec_diff_hint.
  { name: "page_fact_low_stock", prefix: "page fact: low_stock", template: "low_stock_nudge" },
  { name: "page_fact_free_shipping_gap", prefix: "page fact: free_shipping_gap", template: "free_shipping_gap" },
  { name: "page_fact_variant_out_of_stock", prefix: "page fact: variant_out_of_stock", template: "size_availability" },
  { name: "undecided_compare", prefix: "undecided compare:", template: "spec_diff_hint" },
];

/**
 * signalsForReason(reason) → [{ name, template }] — the context-aware
 * trigger signal(s) whose reason-string prefix matches `reason` (gate()'s
 * own `reason`, e.g. "variant churn: 2 option switches..."). Empty array for
 * a reason with no matching context-aware trigger (rules 1-12, the floor,
 * or page_moment — none of those name a single template the same way).
 * Pure string matching, safe to call with any string (including null/
 * undefined, which just yields []).
 */
export function signalsForReason(reason) {
  if (typeof reason !== "string" || !reason) return [];
  return SIGNAL_TEMPLATE_MAP.filter((s) => reason.startsWith(s.prefix)).map((s) => ({ name: s.name, template: s.template }));
}

/** forSignalsMap() → { [signalName]: templateId } — every known signal->template pairing, for prompt injection (decide/llm.js). */
export function forSignalsMap() {
  const out = {};
  for (const s of SIGNAL_TEMPLATE_MAP) out[s.name] = s.template;
  return out;
}
