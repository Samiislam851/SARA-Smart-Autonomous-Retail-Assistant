// buildState() page-scoping probe — plain node asserts (same style as
// probe-policy.test.js / coalesce.test.js). Run with `npm run test:state`
// (node state.test.js).
//
// Reproduces the defect this pass fixes: per-target dwell (and, via
// tick.js's dwell-bucket history, whether a NEW dwell signal is even
// noticed) used to be able to survive a page_view for a different path —
// e.g. a shopper dwells 13s on a sized product's "size-picker", navigates
// to a one-size product with no size-* targets at all, and a stale/buggy
// client (or a race between the route-change reset and an in-flight dwell
// tick — see web/components/AgentWidget.tsx and server/public/agent.js's
// route-change reset comments) still emits one more "dwell size-picker"
// event after the new page_view lands. That leaked dwell must never be
// attributed to the new page — this is what a live shopper actually hit
// (see server/NOTES.md "per-element state leak across navigations").
//
// Asserts, directly against buildState()/shouldCallDecider() (no HTTP, no
// decider):
//   (i)   dwell.perTarget on the new page excludes the leaked "size-picker"
//         entry, even though it's positioned AFTER the page_view in the
//         event log (state.js's visibleTargets cross-check).
//   (ii)  dwell.pageMs on the new page reflects only page-B's own
//         page-level dwell, not page-A's.
//   (iii) visibleTargets is exactly page B's targets.
//   (iv)  the false-negative direction of the same defect class: without
//         resetting session.lastDwellBuckets on page_view (what
//         index.js's processEventCore does on real traffic),
//         shouldCallDecider() would treat page B's own legitimate dwell as
//         "no class change" just because page A's dwell on a same-named
//         target already reached the same bucket — asserted by comparing
//         the reset-applied vs. not-applied runs.

import assert from "node:assert/strict";
import { getSession, resetSession, pushEvent, buildState, summarize } from "./state.js";
import { shouldCallDecider } from "./tick.js";
import * as metrics from "./metrics.js";

const SANDALS = "/product/leather-mojari-sandals";
const SAREE = "/product/jamdani-saree-classic";
const SANDALS_TARGETS = ["product-image", "size-picker", "size-guide", "cart-add", "shipping-banner", "cart-link"];
const SAREE_TARGETS = ["product-image", "fabric-note", "cart-add", "shipping-banner", "cart-link"];

function ev(type, target, meta) {
  return { session: "state_test_session", type, target, ts: Date.now(), meta };
}

// ---- (i)-(iii): buildState() page-scoping ---------------------------------
{
  resetSession("state_test_session");
  const session = getSession("state_test_session");

  pushEvent(session, ev("page_view", SANDALS, { targets: SANDALS_TARGETS }));
  pushEvent(session, ev("dwell", SANDALS, { ms: 5000 }));
  pushEvent(session, ev("dwell", "size-picker", { ms: 8000 }));
  pushEvent(session, ev("dwell", "size-picker", { ms: 13000 }));

  pushEvent(session, ev("page_view", SAREE, { targets: SAREE_TARGETS }));
  // Simulates the observed leak: a dwell for a target that only exists on
  // the PREVIOUS page, arriving after the new page's page_view.
  pushEvent(session, ev("dwell", "size-picker", { ms: 13000 }));
  pushEvent(session, ev("dwell", SAREE, { ms: 5000 }));
  pushEvent(session, ev("dwell", SAREE, { ms: 10000 }));

  const state = buildState(session);

  assert.equal(state.page, SAREE, "page reflects the latest page_view");
  assert.deepEqual(state.visibleTargets, SAREE_TARGETS, "visibleTargets is page B's targets only");
  assert.equal(
    Object.prototype.hasOwnProperty.call(state.dwell.perTarget, "size-picker"),
    false,
    "leaked size-picker dwell (target not on the current page) must not appear in dwell.perTarget"
  );
  assert.equal(state.dwell.pageMs, 10000, "pageMs reflects only page B's own page-level dwell, not page A's");
  console.log("(i)-(iii) ok — buildState() is page-scoped:", state.dwell, state.visibleTargets);

  resetSession("state_test_session");
}

// ---- (iv): lastDwellBuckets reset on page_view (index.js's job on real
// traffic) prevents the false-negative direction of the same defect class --
{
  resetSession("state_test_session");
  const session = getSession("state_test_session");

  // Page A: dwell on "size-guide" (also present on page B) reaches the
  // "60s+" bucket.
  pushEvent(session, ev("page_view", SANDALS, { targets: SANDALS_TARGETS }));
  pushEvent(session, ev("dwell", "size-guide", { ms: 65000 }));
  let state = buildState(session);
  const changedOnA = shouldCallDecider(session, session.events.at(-1), state);
  assert.equal(changedOnA, true, "sanity: page A's own first size-guide dwell tick is a class change");

  // Page B also has "size-guide"; WITHOUT the page_view reset, its own
  // fresh dwell landing straight in "60s+" would look like "no class
  // change" (false negative) purely because of page A's leftover bucket.
  pushEvent(session, ev("page_view", SAREE, { targets: [...SAREE_TARGETS, "size-guide"] }));
  // No reset here — reproduces the pre-fix behavior for comparison.
  pushEvent(session, ev("dwell", "size-guide", { ms: 65000 }));
  state = buildState(session);
  const changedWithoutReset = shouldCallDecider(session, session.events.at(-1), state);
  assert.equal(
    changedWithoutReset,
    false,
    "reproduction: without a page_view reset, page B's own dwell false-negatives against page A's leftover bucket"
  );

  // Now with the reset index.js applies on every page_view (session.
  // lastDwellBuckets = {}), the same page-B dwell IS seen as a class change.
  session.lastDwellBuckets = {};
  pushEvent(session, ev("dwell", "size-guide", { ms: 500 })); // page B's own dwell starts fresh, low bucket
  state = buildState(session);
  const changedWithReset = shouldCallDecider(session, session.events.at(-1), state);
  assert.equal(
    changedWithReset,
    true,
    "with the page_view reset, page B's own dwell is correctly seen as a class change"
  );

  console.log("(iv) ok — lastDwellBuckets reset on page_view prevents the false-negative leak direction");
  resetSession("state_test_session");
}

// ---- per-element-dwell-is-viewport-time defect class -----------------------
// buildState()/summarize() must not treat an above-the-fold element's mere
// on-screen presence as a signal: a client that never sends element-level
// dwell for untouched-but-visible targets (the fixed behavior — see
// web/components/AgentWidget.tsx / server/public/agent.js) must leave
// dwell.perTarget/perTargetEvidence empty for those targets, and summarize()
// must not manufacture an "attention" line for anything that was never
// reported.
{
  resetSession("state_test_session");
  const session = getSession("state_test_session");

  pushEvent(session, ev("page_view", SANDALS, { targets: SANDALS_TARGETS }));
  pushEvent(session, ev("dwell", SANDALS, { ms: 25000 })); // page dwell only — no element ever hovered/focused/tapped
  pushEvent(session, ev("cart_update", "cart-add", { total: 3450, items: [{ sku: "leather-mojari-sandals", qty: 1, price: 3450 }] }));

  const state = buildState(session);
  assert.equal(state.dwell.pageMs, 25000, "page dwell reflects the heartbeat");
  assert.deepEqual(state.dwell.perTarget, {}, "above-fold, untouched elements contribute ZERO element dwell");
  assert.deepEqual(state.dwell.perTargetEvidence, {}, "no attention evidence for anything never reported");

  const lines = summarize(session.events);
  assert.equal(
    lines.some((l) => l.startsWith("attention ")),
    false,
    "summarize() must not contain an 'attention' line when no element attention was ever sent"
  );
  console.log("(v) ok — visible-only session has zero per-target attention:", state.dwell, lines);

  resetSession("state_test_session");
}

// ---- attention IS present when the client reports hover/focus/click evidence
{
  resetSession("state_test_session");
  const session = getSession("state_test_session");

  pushEvent(session, ev("page_view", SANDALS, { targets: SANDALS_TARGETS }));
  pushEvent(session, ev("dwell", SANDALS, { ms: 5000 }));
  pushEvent(
    session,
    ev("dwell", "size-guide", {
      ms: 21000,
      kind: "attention",
      interactions: { hover_ms: 15000, focus_ms: 0, clicks: 2, scrolled_to: false },
    })
  );

  const state = buildState(session);
  assert.equal(state.dwell.perTarget["size-guide"], 21000, "perTarget keeps the plain ms number");
  assert.deepEqual(
    state.dwell.perTargetEvidence["size-guide"],
    { kind: "attention", interactions: { hover_ms: 15000, focus_ms: 0, clicks: 2, scrolled_to: false } },
    "perTargetEvidence surfaces the interaction evidence behind the ms number"
  );

  const lines = summarize(session.events);
  assert.ok(
    lines.some((l) => l === "attention size-guide 21s (hover 15s, 2 clicks)"),
    `expected an "attention size-guide 21s (hover 15s, 2 clicks)" line, got ${JSON.stringify(lines)}`
  );
  console.log("(vi) ok — hover/click-backed attention is present and evidenced:", state.dwell, lines);

  resetSession("state_test_session");
}

// ---- (vii): S5 — a target visible under an EARLIER page_view of the SAME
// path/visit (e.g. a modal's targets, present before the modal closed and a
// re-fired page_view on the same path dropped them from `meta.targets`)
// must still be accepted for dwell.perTarget, not treated as "off page" —
// the false-NEGATIVE direction of the per-element-state-leak defect class.
// A target that never appeared under ANY page_view of this path/visit is
// still correctly dropped, and counted via metrics.dwellDroppedOffPage.
{
  resetSession("state_test_session");
  metrics.reset();
  const session = getSession("state_test_session");

  // First page_view of this path includes "size-modal-note" (e.g. a size
  // chart modal open at first paint); the second page_view of the SAME path
  // (no navigation in between) no longer lists it (modal closed), but the
  // shopper's dwell on it — attributed to an event between the two
  // page_views — must still count.
  pushEvent(session, ev("page_view", SANDALS, { targets: [...SANDALS_TARGETS, "size-modal-note"] }));
  pushEvent(session, ev("dwell", "size-modal-note", { ms: 4000, kind: "attention", interactions: { clicks: 1 } }));
  pushEvent(session, ev("page_view", SANDALS, { targets: SANDALS_TARGETS }));
  pushEvent(session, ev("dwell", "size-modal-note", { ms: 6000, kind: "attention", interactions: { clicks: 1 } }));
  // Genuinely off-page: never appeared under any page_view of this visit.
  pushEvent(session, ev("dwell", "never-on-this-page", { ms: 9000 }));

  const state = buildState(session);
  assert.equal(
    state.dwell.perTarget["size-modal-note"],
    6000,
    "target visible under an EARLIER page_view of the same path/visit is still accepted, not dropped as off-page"
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(state.dwell.perTarget, "never-on-this-page"),
    false,
    "a target that never appeared under any page_view of this visit is still dropped"
  );
  const snap = metrics.snapshot();
  assert.equal(snap.dwellDroppedOffPage, 1, "the genuinely off-page dwell is counted via dwellDroppedOffPage");
  console.log("(vii) ok — same-visit, earlier-page_view targets accepted; genuine off-page drops counted:", state.dwell, snap.dwellDroppedOffPage);

  resetSession("state_test_session");
}

// ---- journey/focus/patterns/recent — fixture-based (server/NOTES.md "raw
// event tails, not a shopper narrative" defect class) ----------------------
//
// Two REAL fixtures pulled live via curl from a running server
// (server/sessions/samples/*-events.json) plus one hand-authored SYNTHETIC
// fixture for pattern coverage no single real session happened to exhibit
// together. See NOTES.md for the full live-pull provenance/dates.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadFixtureEvents(file) {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "sessions", "samples", file), "utf8"));
  return raw.events.map((e) => ({ session: "fixture", type: e.type, target: e.target, ts: e.ts, meta: e.meta }));
}

// ---- me_1: REAL dwell-flood / no-page-snapshot regression case -----------
// Pulled live (curl localhost:4000/sessions/me_1) — 371 events, every one of
// them "dwell", ZERO page_view/click/cart_update/search ever recorded for
// this session. NOT "the owner browsed 2 pages for 6 minutes": me_1's
// page_views were in-memory (session.events, RING_SIZE) and were lost when
// the server container was recreated at ~02:20; only post-restart dwell
// heartbeats got recorded from that point on. This IS the reported bug's
// live reproduction: product null (pre-fix), dwell.perTarget empty,
// `recent` full of ~20 near-identical "dwell ... {ms:...}" lines.
{
  resetSession("fixture");
  const session = getSession("fixture");
  session.events = loadFixtureEvents("me_1-events.json");

  const state = buildState(session);
  assert.equal(state.needsResnapshot, true, "a session with events but never a page_view flags needsResnapshot");
  assert.equal(
    state.product?.slug,
    "khadi-field-jacket",
    "product resolves from the dwell-derived fallback path even with no page_view at all"
  );
  assert.equal(state.recent.length, 0, "recent has zero heartbeat lines — this fixture never emits an element-attention dwell");
  const bytes = Buffer.byteLength(JSON.stringify(state), "utf8");
  assert.ok(bytes <= 2500, `state size ${bytes}B must stay <= 2.5KB for this ~4min session`);
  console.log(`me_1 (real, dwell-flood) ok — needsResnapshot, product resolved, recent=[], ${bytes}B`);

  resetSession("fixture");
}

// ---- s_kmtgye1g: REAL rich-journey fixture --------------------------------
// Pulled live (curl localhost:4000/sessions/s_kmtgye1g) — 593 events across
// page_view/dwell/scroll_depth/cart_update/cart_view, real multi-product
// browsing + cart + checkout. Numbers below are DERIVED from this fixture's
// actual events (not asserted against an assumed shape) — see the worker
// report for the full before/after dump.
{
  resetSession("fixture");
  const session = getSession("fixture");
  session.events = loadFixtureEvents("s_kmtgye1g-events.json");

  const state = buildState(session);
  assert.equal(state.journey.pagesVisited, 12, "12 collapsed page visits");
  assert.equal(state.journey.distinctProducts, 4, "4 distinct products (khadi, nakshi, leather-mojari, jamdani)");
  assert.ok(state.journey.returnsToSameProduct >= 1, "returns to a previously-seen product at least once");
  assert.equal(state.journey.cartVisits, 3, "3 cart-page visits");
  assert.equal(state.journey.checkoutReached, true, "checkout was reached");
  assert.equal(state.needsResnapshot, false, "this session has real page_views, no resnapshot needed");
  console.log("s_kmtgye1g (real, rich journey) ok —", state.journey.pagesVisited, "visits,", state.journey.distinctProducts, "products, cartVisits", state.journey.cartVisits, "checkoutReached", state.journey.checkoutReached);

  resetSession("fixture");
}

// ---- SYNTHETIC: pingPong / breadthNoCommit / cartVisitedThenLeft /
// returnedAfterCart, all in one minimal session no real fixture happened to
// combine. Hand-authored, not live data.
{
  resetSession("fixture");
  const session = getSession("fixture");
  let ts = 1000;
  const step = (ms) => (ts += ms);
  const A = "/product/khadi-field-jacket";
  const B = "/product/jamdani-saree-classic";
  const C = "/product/nakshi-kantha-scarf";
  pushEvent(session, { ...ev("page_view", A, { targets: [] }), ts });
  pushEvent(session, { ...ev("page_view", B, { targets: [] }), ts: step(20000) });
  pushEvent(session, { ...ev("page_view", A, { targets: [] }), ts: step(20000) }); // pingPong: A seen again with B in between
  pushEvent(session, { ...ev("page_view", C, { targets: [] }), ts: step(20000) }); // 3 distinct products, never added to cart
  pushEvent(session, { ...ev("page_view", "/cart", {}), ts: step(20000) });
  pushEvent(session, { ...ev("page_view", A, { targets: [] }), ts: step(20000) }); // left cart for a non-checkout page; A seen again after cart

  const state = buildState(session);
  assert.equal(state.patterns.pingPong, true, "synthetic: pingPong");
  assert.equal(state.patterns.breadthNoCommit, true, "synthetic: breadthNoCommit (3 distinct products, no cart-add ever)");
  assert.equal(state.patterns.cartVisitedThenLeft, true, "synthetic: cartVisitedThenLeft");
  assert.equal(state.patterns.returnedAfterCart, true, "synthetic: returnedAfterCart");
  console.log("synthetic patterns fixture ok —", state.patterns);

  resetSession("fixture");
}

// ---- SYNTHETIC: checkoutBounce — category (a) fix (live finding session
// final_tm_242431: checkout->login->checkout->login->/shop produced 0
// interventions across 9 real LLM calls because no pre-computed pattern
// flag existed for "reached checkout, then walked away"). Two cases: the
// walk-away (true) and the checkout<->cart bounce it must NOT fire for
// (false — that shape is the pre-existing cartVisitedThenLeft/delivery-gap-
// priority rule instead; conflating the two caused a real regression on
// sessions/gap-over-promo.json during this fix, see server/NOTES.md).
{
  resetSession("fixture");
  const session = getSession("fixture");
  let ts = 1000;
  const step = (ms) => (ts += ms);
  pushEvent(session, { ...ev("page_view", "/checkout", { targets: [] }), ts });
  pushEvent(session, { ...ev("page_view", "/login", { targets: [] }), ts: step(5000) });
  pushEvent(session, { ...ev("page_view", "/checkout", { targets: [] }), ts: step(5000) });
  pushEvent(session, { ...ev("page_view", "/login", { targets: [] }), ts: step(5000) });
  pushEvent(session, { ...ev("page_view", "/shop", { targets: [] }), ts: step(5000) });

  const state = buildState(session);
  assert.equal(state.patterns.checkoutBounce, true, "checkout -> login -> checkout -> login -> /shop is a real walk-away");
  console.log("synthetic checkoutBounce (walk-away) ok —", state.patterns.checkoutBounce);

  resetSession("fixture");
}
{
  resetSession("fixture");
  const session = getSession("fixture");
  let ts = 1000;
  const step = (ms) => (ts += ms);
  pushEvent(session, { ...ev("page_view", "/checkout", { targets: [] }), ts });
  pushEvent(session, { ...ev("back_nav", "/cart"), ts: step(1000) });
  pushEvent(session, { ...ev("page_view", "/cart", { targets: [] }), ts: step(1000) });

  const state = buildState(session);
  assert.equal(state.patterns.checkoutBounce, false, "checkout -> cart must NOT set checkoutBounce (that's cartVisitedThenLeft's shape)");
  console.log("synthetic checkoutBounce (checkout->cart, excluded) ok —", state.patterns.checkoutBounce);

  resetSession("fixture");
}

// ---- page_context merge + comparison block (2026-09-12 "richer scanned
// site context" brief) ------------------------------------------------------
{
  resetSession("pagectx_fixture");
  const session = getSession("pagectx_fixture");

  pushEvent(session, ev("page_view", SANDALS, { targets: SANDALS_TARGETS }));
  pushEvent(
    session,
    ev("page_context", SANDALS, {
      page_type: "product",
      product: { title: "Leather Mojari Sandals", price: 1800, compareAt: null, currency: "৳" },
      variants: [
        { name: "M", available: false },
        { name: "L", available: true },
      ],
      stock_text: "Only 3 left in stock",
      promo_present: false,
    })
  );

  let state = buildState(session);
  assert.ok(state.page_context, "page_context block present after a page_context event");
  assert.equal(state.page_context.type, "product");
  assert.equal(state.page_context.product.title, "Leather Mojari Sandals");
  assert.equal(state.page_context.stock.lowStockN, 3, "'Only 3 left in stock' parses to lowStockN=3");
  assert.equal(state.page_context.variants.availableJoined, "L");
  assert.equal(state.page_context.variants.unavailableJoined, "M");
  assert.equal(state.comparison.length, 0, "no other product viewed yet — comparison is empty");

  // View a second, cheaper product — comparison should now show it with a
  // negative delta (current minus other: 1800 - 1200 -> +600 means current
  // is pricier, so delta here is CURRENT - OTHER = +600).
  pushEvent(session, ev("page_view", SAREE, { targets: SAREE_TARGETS }));
  pushEvent(
    session,
    ev("page_context", SAREE, {
      page_type: "product",
      product: { title: "Jamdani Saree Classic", price: 1200, compareAt: null, currency: "৳" },
      promo_present: false,
    })
  );
  state = buildState(session);
  assert.equal(state.comparison.length, 1, "one prior product now in comparison");
  assert.equal(state.comparison[0].title, "Leather Mojari Sandals");
  assert.equal(state.comparison[0].delta, 1200 - 1800, "delta = current price (1200) minus other price (1800) = -600");
  console.log("(page_context) ok — page_context merges into state.page_context + comparison", {
    page: state.page_context,
    comparison: state.comparison,
  });

  resetSession("pagectx_fixture");
}

console.log("state.test.js: all assertions passed");
