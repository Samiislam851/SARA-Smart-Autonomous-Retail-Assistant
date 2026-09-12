// gate.js / tick.js probe — plain node asserts (same style as
// probe-policy.test.js / coalesce.test.js / state.test.js). Run with
// `npm run test:gate` (node gate.test.js).
//
// Reproduces the live free-browsing defects (see server/NOTES.md, round 3):
// gate.js used to reason over EVENT COUNTS ("last 3 events") and over the
// single TRIGGERING event's own numbers, so ~1 event/s of dwell heartbeats
// buried a 40s-old back_nav within 3 events, and a heartbeat carrying 4s of
// its own dwell gated out an unrelated element sitting at 48s of real
// attention. This file drives gate()/shouldCallDecider() against realistic
// 1Hz-heartbeat sessions built through the real buildState() pipeline (no
// HTTP, no decider) and asserts state/time-window reasoning, not event
// counts.

import assert from "node:assert/strict";
import { getSession, resetSession, pushEvent, buildState } from "./state.js";
import { gate, computeSignals, consultFloorCheck, pageMomentCheck, CONSULT_FLOOR_MS, MAX_MODEL_CALLS_PER_MIN, signalsForReason, forSignalsMap } from "./gate.js";
import { shouldCallDecider } from "./tick.js";

const SID = "gate_test_session";
const T0 = 1_000_000_000; // fixed base ts so all windows below are exact, no Date.now() flakiness

function ev(type, target, ms, meta) {
  return { session: SID, type, target, ts: ms, meta };
}

function heartbeats(session, page, startMs, count, startAccumMs, stepMs) {
  for (let i = 0; i < count; i++) {
    pushEvent(session, ev("dwell", page, startMs + i * 1000, { ms: startAccumMs + i * stepMs }));
  }
}

// ---- (i) back_nav 40s ago buried under 40 heartbeats -> gate passes -------
{
  resetSession(SID);
  const session = getSession(SID);
  const CHECKOUT_TARGETS = ["address-form", "payment-options", "place-order", "cart-link"];
  const CART_TARGETS = ["cart-items", "cart-total", "shipping-banner", "checkout-btn", "cart-link"];

  pushEvent(session, ev("page_view", "/checkout", T0, { targets: CHECKOUT_TARGETS }));
  pushEvent(session, ev("back_nav", "/cart", T0 + 1000));
  pushEvent(session, ev("page_view", "/cart", T0 + 2000, { targets: CART_TARGETS }));
  heartbeats(session, "/cart", T0 + 3000, 40, 1000, 1000); // 40 page-level heartbeats, 1s apart

  const lastEvent = session.events.at(-1); // ts = T0 + 3000 + 39000 = T0 + 42000; back_nav is 41s earlier
  const state = buildState(session);
  const result = gate(state, session, lastEvent);

  assert.equal(result.pass, true, `expected gate to pass on a 41s-old back_nav, got: ${result.reason}`);
  assert.match(result.reason, /back_nav/, `reason should name back_nav, got: ${result.reason}`);
  console.log("(i) ok — back_nav 41s ago, buried under 40 heartbeats, still passes:", result.reason);

  resetSession(SID);
}

// ---- (ii) 48s attention on size-picker, triggering event a 4s heartbeat ---
{
  resetSession(SID);
  const session = getSession(SID);
  const TARGETS = ["product-image", "size-picker", "size-guide", "cart-add", "shipping-banner", "cart-link"];

  pushEvent(session, ev("page_view", "/product/khadi-field-jacket", T0, { targets: TARGETS }));
  pushEvent(
    session,
    ev("dwell", "size-picker", T0 + 1000, {
      ms: 48000,
      kind: "attention",
      interactions: { hover_ms: 40000, focus_ms: 0, clicks: 2, scrolled_to: false },
    })
  );
  // The triggering event: an unrelated page-level heartbeat carrying only 4s.
  pushEvent(session, ev("dwell", "/product/khadi-field-jacket", T0 + 2000, { ms: 4000 }));

  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const result = gate(state, session, lastEvent);

  assert.equal(
    result.pass,
    true,
    `expected gate to pass on 48s size-picker attention despite a 4s triggering heartbeat, got: ${result.reason}`
  );
  assert.match(result.reason, /size-picker/, `reason should name size-picker, got: ${result.reason}`);
  console.log("(ii) ok — 48s size-picker attention passes despite a 4s triggering heartbeat:", result.reason);

  resetSession(SID);
}

// ---- (iii) reader: 25s page dwell, zero attention -> gated with window reason
{
  resetSession(SID);
  const session = getSession(SID);
  const TARGETS = ["product-image", "size-picker", "size-guide", "cart-add", "shipping-banner", "cart-link"];

  pushEvent(session, ev("page_view", "/product/jamdani-saree-classic", T0, { targets: TARGETS }));
  pushEvent(session, ev("dwell", "/product/jamdani-saree-classic", T0 + 1000, { ms: 25000 }));

  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const result = gate(state, session, lastEvent);

  assert.equal(result.pass, false, `expected a plain reader to be gated, got pass with: ${result.reason}`);
  assert.match(result.reason, /no friction signal in last 60s/, `reason should name the window, got: ${result.reason}`);
  console.log("(iii) ok — plain reader gated with a window-named reason:", result.reason);

  resetSession(SID);
}

// ---- (iv) return visit + 3s attention -> passes ----------------------------
{
  resetSession(SID);
  const session = getSession(SID);
  const PATH = "/product/khadi-field-jacket";
  const TARGETS = ["product-image", "size-picker", "size-guide", "cart-add", "shipping-banner", "cart-link"];

  pushEvent(session, ev("page_view", PATH, T0, { targets: TARGETS }));
  pushEvent(session, ev("dwell", PATH, T0 + 1000, { ms: 3000 }));
  pushEvent(session, ev("page_view", "/", T0 + 2000, { targets: ["search-box"] }));
  pushEvent(session, ev("page_view", PATH, T0 + 3000, { targets: TARGETS })); // second visit, same path
  pushEvent(
    session,
    ev("dwell", "size-guide", T0 + 4000, {
      ms: 3000,
      kind: "attention",
      interactions: { hover_ms: 3000, clicks: 0 },
    })
  );

  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const result = gate(state, session, lastEvent);

  assert.equal(result.pass, true, `expected a return visit with 3s attention to pass, got: ${result.reason}`);
  assert.match(result.reason, /return visit/, `reason should name return visit, got: ${result.reason}`);
  console.log("(iv) ok — return visit + 3s attention passes:", result.reason);

  resetSession(SID);
}

// ---- (v) cart friction: ৳1,950/2,000 on /cart with 10s dwell -> passes;
//          same cart on /product -> gated ----------------------------------
{
  resetSession(SID);
  const session = getSession(SID);
  const CART_TARGETS = ["cart-items", "cart-total", "shipping-banner", "checkout-btn", "cart-link"];

  pushEvent(session, ev("page_view", "/cart", T0, { targets: CART_TARGETS }));
  pushEvent(session, ev("cart_view", "/cart", T0 + 1000, { total: 1950, items: [{ sku: "s", qty: 1, price: 1950 }] }));
  pushEvent(session, ev("dwell", "/cart", T0 + 2000, { ms: 10000 }));

  let lastEvent = session.events.at(-1);
  let state = buildState(session);
  let result = gate(state, session, lastEvent);

  assert.equal(result.pass, true, `expected cart friction on /cart to pass, got: ${result.reason}`);
  assert.match(result.reason, /cart friction/, `reason should name cart friction, got: ${result.reason}`);
  console.log("(v.a) ok — cart friction on /cart with 10s dwell passes:", result.reason);

  resetSession(SID);

  const session2 = getSession(SID);
  const PRODUCT_TARGETS = ["product-image", "cart-add", "cart-link"];
  pushEvent(session2, ev("page_view", "/product/other-item", T0, { targets: PRODUCT_TARGETS }));
  pushEvent(session2, ev("cart_view", "/product/other-item", T0 + 1000, { total: 1950, items: [{ sku: "s", qty: 1, price: 1950 }] }));
  pushEvent(session2, ev("dwell", "/product/other-item", T0 + 2000, { ms: 10000 }));

  lastEvent = session2.events.at(-1);
  state = buildState(session2);
  result = gate(state, session2, lastEvent);

  assert.equal(result.pass, false, `expected the same near-threshold cart on /product to be gated, got pass with: ${result.reason}`);
  console.log("(v.b) ok — same cart on /product gated:", result.reason);

  resetSession(SID);
}

// ---- (vi) tick.js: 30 identical heartbeats after a decision -> quiet;
//           attention crossing 5s -> decide ---------------------------------
{
  resetSession(SID);
  const session = getSession(SID);
  const PATH = "/product/khadi-field-jacket";
  const TARGETS = ["product-image", "size-picker", "size-guide", "cart-add", "shipping-banner", "cart-link"];

  pushEvent(session, ev("page_view", PATH, T0, { targets: TARGETS }));
  let state = buildState(session);
  let decide = shouldCallDecider(session, session.events.at(-1), state);
  assert.equal(decide, true, "sanity: first page_view of an unseen path is always a decision");
  session.lastDeciderAt = T0;

  // 19 identical page-level dwell heartbeats — page dwell alone is never a
  // bucket/friction signal, and nothing else about the situation changes.
  // Capped at 19s (< IDLE_MS's 20s default): rule 20 (idle, added
  // 2026-09-12) is DELIBERATELY a real trigger once the shopper has given
  // no real input for 20s+ on a product/cart page — see gate.js's
  // idleSignal and BEHAVIOR-MATRIX.md's P0 item 8 — so "heartbeats alone
  // stay quiet forever" is no longer the invariant; "heartbeats alone stay
  // quiet until the idle floor" is.
  let allQuiet = true;
  for (let i = 1; i <= 19; i++) {
    pushEvent(session, ev("dwell", PATH, T0 + i * 1000, { ms: i * 1000 }));
    state = buildState(session);
    const should = shouldCallDecider(session, session.events.at(-1), state);
    if (should) allQuiet = false;
  }
  assert.equal(allQuiet, true, "expected page-level heartbeats before the idle floor to all be quiet ticks");
  console.log("(vi.a) ok — page-level heartbeats before the idle floor (19s) are all quiet ticks");

  // The 20th heartbeat (20s of no real input) crosses IDLE_MS and SHOULD
  // now trigger — via gate.js's own idle rule, not a dwell-bucket trigger.
  pushEvent(session, ev("dwell", PATH, T0 + 20000, { ms: 20000 }));
  state = buildState(session);
  const idleShould = shouldCallDecider(session, session.events.at(-1), state);
  assert.equal(idleShould, true, "expected the 20s-idle heartbeat to trigger via gate.js's idle rule");
  const idleGateResult = gate(state, session, session.events.at(-1));
  assert.equal(idleGateResult.pass, true, `expected gate() to pass on the same idle tick, got: ${idleGateResult.reason}`);
  assert.match(idleGateResult.reason, /^idle:/);
  console.log("(vi.a.2) ok — 20s idle heartbeat triggers + gate() passes:", idleGateResult.reason);
  session.lastDeciderAt = T0 + 20000; // re-baseline so the rest of this test's dwell-bucket assertions aren't polluted by idle staying true

  // Now element attention on size-guide crosses the 5s bucket boundary.
  pushEvent(
    session,
    ev("dwell", "size-guide", T0 + 32000, {
      ms: 6000,
      kind: "attention",
      interactions: { hover_ms: 6000, clicks: 0 },
    })
  );
  state = buildState(session);
  const shouldDecideNow = shouldCallDecider(session, session.events.at(-1), state);
  assert.equal(shouldDecideNow, true, "expected attention crossing the 5s bucket boundary to trigger a decision");
  console.log("(vi.b) ok — element attention crossing 5s bucket triggers a decision");

  resetSession(SID);
}

// ---- (vii) promo_missed: dwelling on /cart with a missed_discount offer --
{
  resetSession(SID);
  const session = getSession(SID);
  const CART_TARGETS = ["cart-items", "cart-total", "shipping-banner", "checkout-btn", "cart-link", "promo-code"];
  pushEvent(session, ev("page_view", "/cart", T0, { targets: CART_TARGETS }));
  pushEvent(session, ev("cart_view", "/cart", T0 + 1000, { total: 3450, items: [{ sku: "khadi-field-jacket", qty: 1, price: 3450 }], promo: null }));
  pushEvent(session, ev("dwell", "/cart", T0 + 9000, { ms: 9000 }));

  let state = buildState(session);
  // Inject a synthetic offer — computeOffers() itself is unit-tested in
  // store.test.js; here we only need gate.js to react correctly to
  // state.offers containing a missed_discount, independent of whichever
  // real promos.json happens to ship.
  state = { ...state, offers: [{ kind: "missed_discount", slug: "khadi-field-jacket", promo_id: "jacket10", code: "JACKET10", label: "10% off", saving: 345, ends_in_min: 60, urgent: true, target_hint: "promo-code" }] };

  const lastEvent = session.events.at(-1);
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass on a missed-discount offer + 9s cart dwell, got: ${result.reason}`);
  assert.match(result.reason, /promo missed/, `reason should name the promo-missed signal, got: ${result.reason}`);
  console.log("(vii) ok — promo_missed fires on cart dwell with an unapplied code offer:", result.reason);

  resetSession(SID);
}

// ---- (viii) promo_missed does NOT fire without cart/checkout dwell or bounce ----
{
  resetSession(SID);
  const session = getSession(SID);
  const PRODUCT_TARGETS = ["product-image", "size-picker", "size-guide", "cart-add", "shipping-banner", "cart-link"];
  pushEvent(session, ev("page_view", "/product/khadi-field-jacket", T0, { targets: PRODUCT_TARGETS }));
  pushEvent(session, ev("dwell", "/product/khadi-field-jacket", T0 + 2000, { ms: 2000 }));

  let state = buildState(session);
  state = { ...state, offers: [{ kind: "missed_discount", slug: "khadi-field-jacket", promo_id: "jacket10", code: "JACKET10", label: "10% off", saving: 345, ends_in_min: 60, urgent: true, target_hint: "promo-code" }] };

  const lastEvent = session.events.at(-1);
  const sig = computeSignals(state, session, lastEvent.ts);
  assert.equal(sig.promoMissed.hit, false, "browsing the product page (not cart/checkout, no dwell there) must not fire promo_missed");
  console.log("(viii) ok — promo_missed stays quiet off the cart/checkout flow:", sig.promoMissed);

  resetSession(SID);
}

// ---- (ix) similar_promo: return visit + a similar_on_promo offer --------
{
  resetSession(SID);
  const session = getSession(SID);
  const PRODUCT_TARGETS = ["product-image", "size-picker", "size-guide", "cart-add", "shipping-banner", "cart-link", "similar-products"];
  pushEvent(session, ev("page_view", "/product/khadi-field-jacket", T0, { targets: PRODUCT_TARGETS }));
  pushEvent(session, ev("dwell", "/product/khadi-field-jacket", T0 + 1000, { ms: 1000 }));
  pushEvent(session, ev("page_view", "/", T0 + 2000, { targets: [] }));
  pushEvent(session, ev("page_view", "/product/khadi-field-jacket", T0 + 3000, { targets: PRODUCT_TARGETS }));
  pushEvent(session, ev("dwell", "product-image", T0 + 4000, { ms: 3500, kind: "attention", interactions: { hover_ms: 3500 } }));

  let state = buildState(session);
  state = { ...state, offers: [{ kind: "similar_on_promo", slug: "nakshi-kantha-scarf", promo_id: "scarf15", code: null, label: "15% off the scarf", saving: 128, ends_in_min: null, urgent: false, target_hint: "similar-products" }] };

  const lastEvent = session.events.at(-1);
  const sig = computeSignals(state, session, lastEvent.ts);
  // similarPromo reuses the SAME elementAttention/returnVisit evidence rule
  // 1/2 already use, so whenever it hits, gate() also passes via one of
  // those earlier rungs of the ladder — asserting the raw signal (rather
  // than gate()'s specific reason string, which rule 1/2 legitimately wins
  // first) is the real behavior under test here.
  assert.equal(sig.similarPromo.hit, true, "expected similar_promo signal to fire on a return visit with a similar-item offer");
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass, got: ${result.reason}`);
  console.log("(ix) ok — similar_promo fires on a return visit with a similar-item offer:", sig.similarPromo, result.reason);

  resetSession(SID);
}

// ---- (x) product ping-pong: same product viewed again after another page --
{
  resetSession(SID);
  const session = getSession(SID);
  const A = "/product/khadi-field-jacket";
  const B = "/product/leather-mojari-sandals";

  pushEvent(session, ev("page_view", A, T0, { targets: [] }));
  pushEvent(session, ev("page_view", "/", T0 + 5000, { targets: [] }));
  pushEvent(session, ev("page_view", B, T0 + 6000, { targets: [] }));
  pushEvent(session, ev("page_view", "/", T0 + 10000, { targets: [] }));
  pushEvent(session, ev("page_view", A, T0 + 12000, { targets: [] })); // A revisited, / in between

  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const sig = computeSignals(state, session, lastEvent.ts);
  assert.equal(sig.pingPong.hit, true, "expected ping-pong to fire on a product revisited after another page");
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass on ping-pong, got: ${result.reason}`);
  assert.match(result.reason, /ping-pong/, `reason should name ping-pong, got: ${result.reason}`);
  console.log("(x) ok — product ping-pong fires:", result.reason);

  resetSession(SID);
}

// ---- (xi) breadth without commit: 3 distinct products, zero add-to-cart --
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/product/khadi-field-jacket", T0, { targets: [] }));
  pushEvent(session, ev("page_view", "/product/leather-mojari-sandals", T0 + 5000, { targets: [] }));
  pushEvent(session, ev("page_view", "/product/nakshi-kantha-scarf", T0 + 10000, { targets: [] }));

  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const sig = computeSignals(state, session, lastEvent.ts);
  assert.equal(sig.breadthNoCommit.hit, true, "expected breadth-without-commit to fire on 3 distinct products with no add-to-cart");
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass on breadth without commit, got: ${result.reason}`);
  assert.match(result.reason, /breadth without commit/, `reason should name breadth without commit, got: ${result.reason}`);
  console.log("(xi) ok — breadth without commit fires:", result.reason);

  resetSession(SID);

  // Same 3 products, but WITH an add-to-cart — must NOT fire.
  const session2 = getSession(SID);
  pushEvent(session2, ev("page_view", "/product/khadi-field-jacket", T0, { targets: [] }));
  pushEvent(session2, ev("cart_update", "cart-add", T0 + 1000, { total: 3450, items: [{ sku: "khadi-field-jacket", qty: 1, price: 3450 }] }));
  pushEvent(session2, ev("page_view", "/product/leather-mojari-sandals", T0 + 5000, { targets: [] }));
  pushEvent(session2, ev("page_view", "/product/nakshi-kantha-scarf", T0 + 10000, { targets: [] }));

  const lastEvent2 = session2.events.at(-1);
  const state2 = buildState(session2);
  const sig2 = computeSignals(state2, session2, lastEvent2.ts);
  assert.equal(sig2.breadthNoCommit.hit, false, "expected breadth-without-commit NOT to fire once an add-to-cart happened");
  console.log("(xi.b) ok — breadth without commit stays quiet after an add-to-cart");

  resetSession(SID);
}

// ---- (xii) cart-visit-and-leave: cart page_view then navigation away ------
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/cart", T0, { targets: [] }));
  pushEvent(session, ev("cart_view", "/cart", T0 + 500, { total: 2900, items: [{ sku: "s", qty: 1, price: 2900 }] }));
  pushEvent(session, ev("page_view", "/", T0 + 5000, { targets: [] }));

  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const sig = computeSignals(state, session, lastEvent.ts);
  assert.equal(sig.cartLeave.hit, true, "expected cart-visit-and-leave to fire on navigation away from cart without checkout");
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass on cart-visit-and-leave, got: ${result.reason}`);
  assert.match(result.reason, /cart visit and leave/, `reason should name cart visit and leave, got: ${result.reason}`);
  console.log("(xii) ok — cart-visit-and-leave fires:", result.reason);

  resetSession(SID);

  // Cart -> checkout must NOT count as "leave".
  const session2 = getSession(SID);
  pushEvent(session2, ev("page_view", "/cart", T0, { targets: [] }));
  pushEvent(session2, ev("cart_view", "/cart", T0 + 500, { total: 2900, items: [{ sku: "s", qty: 1, price: 2900 }] }));
  pushEvent(session2, ev("page_view", "/checkout", T0 + 5000, { targets: [] }));

  const lastEvent2 = session2.events.at(-1);
  const state2 = buildState(session2);
  const sig2 = computeSignals(state2, session2, lastEvent2.ts);
  assert.equal(sig2.cartLeave.hit, false, "expected cart-visit-and-leave NOT to fire when the shopper went on to checkout");
  console.log("(xii.b) ok — cart -> checkout does not count as cart-visit-and-leave");

  resetSession(SID);
}

// ---- (xiii) return-to-product-after-cart -----------------------------------
{
  resetSession(SID);
  const session = getSession(SID);
  // Product A -> cart -> home -> product A: distinct from rule 3's
  // product->cart->product bounce (which needs exactly that 3-step
  // sequence with no page in between) since a "/" page_view sits between
  // the cart visit and the return to A here.
  const A = "/product/khadi-field-jacket";
  pushEvent(session, ev("page_view", A, T0, { targets: [] }));
  pushEvent(session, ev("page_view", "/cart", T0 + 5000, { targets: [] }));
  pushEvent(session, ev("cart_view", "/cart", T0 + 5500, { total: 3450, items: [{ sku: "khadi-field-jacket", qty: 1, price: 3450 }] }));
  pushEvent(session, ev("page_view", "/", T0 + 8000, { targets: [] }));
  pushEvent(session, ev("page_view", A, T0 + 10000, { targets: [] })); // back to the same product after cart

  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const sig = computeSignals(state, session, lastEvent.ts);
  assert.equal(sig.returnAfterCart.hit, true, "expected return-to-product-after-cart to fire on a product seen before and after the cart visit");
  // This event sequence also trips rule 9 (pingPong, A seen again after
  // another page) which sits earlier in gate()'s ladder — asserting the raw
  // signal (rather than gate()'s specific reason string) is the real
  // behavior under test here, same rationale as test (ix) for similar_promo.
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass, got: ${result.reason}`);
  console.log("(xiii) ok — return-to-product-after-cart fires:", sig.returnAfterCart, result.reason);

  resetSession(SID);
}

// ---- (xiv) consult floor: active shopper, no signal, long past floor -----
// See server/NOTES.md, "model only consulted on signal edges, no floor"
// defect (live 2026-09-12, session you_2: 47 events/31 decisions/0 model
// calls). An ordinary product-page dwell that never trips any of rules 1-12
// must still get a model look once CONSULT_FLOOR_MS has passed with the
// shopper still active.
{
  resetSession(SID);
  const session = getSession(SID);
  const A = "/product/khadi-field-jacket";
  pushEvent(session, ev("page_view", A, T0, { targets: ["product-image"] }));
  // Ordinary per-element dwell well under ELEMENT_ATTENTION_MS (4000ms) —
  // no signal fires — but it's a real (non-heartbeat) event, so it counts
  // toward "shopper active".
  pushEvent(session, ev("dwell", "product-image", T0 + CONSULT_FLOOR_MS + 5000, { ms: 1500 }));

  const lastEvent = session.events.at(-1);
  const state = buildState(session);

  const floor = consultFloorCheck(state, session, lastEvent, lastEvent.ts);
  assert.equal(floor.hit, true, "expected consult floor to hit: active shopper, no model call yet, well past the floor");

  const trigger = shouldCallDecider(session, lastEvent, state);
  assert.equal(trigger, true, "expected shouldCallDecider to trigger via the consult floor");

  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass via the consult floor, got: ${result.reason}`);
  assert.match(result.reason, /^floor:/, `expected a floor reason, got: ${result.reason}`);
  console.log("(xiv) ok — consult floor fires on an active, signal-free session:", result.reason);

  resetSession(SID);
}

// ---- (xv) consult floor: shopper NOT active (no recent event) -------------
// Same long gap since the last model call, but nothing happened in the last
// 20s — the floor must NOT fire (nothing to consult the model ABOUT).
{
  resetSession(SID);
  const session = getSession(SID);
  const A = "/product/khadi-field-jacket";
  pushEvent(session, ev("page_view", A, T0, { targets: ["product-image"] }));
  // A page-level dwell heartbeat long after the floor window, but the
  // triggering event itself is the heartbeat and there's no OTHER event in
  // the preceding 20s window — shopperActive must read false.
  pushEvent(session, ev("dwell", A, T0 + CONSULT_FLOOR_MS + 5000, { ms: 500 }));

  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const floor = consultFloorCheck(state, session, lastEvent, lastEvent.ts);
  assert.equal(floor.active, false, "expected shopper NOT active: only a page-level dwell heartbeat in the last 20s");
  assert.equal(floor.hit, false, "expected consult floor NOT to fire when the shopper isn't active");
  console.log("(xv) ok — consult floor does not fire on a page-level-heartbeat-only session");

  resetSession(SID);
}

// ---- (xvi) page moment: product page_view after >=2 prior page views ------
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/", T0, { targets: [] }));
  pushEvent(session, ev("page_view", "/shop", T0 + 1000, { targets: [] }));
  pushEvent(session, ev("page_view", "/product/banana-tshirt", T0 + 2000, { targets: ["product-image"] }));

  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const pageMoment = pageMomentCheck(state, session, lastEvent, lastEvent.ts);
  assert.equal(pageMoment.hit, true, "expected page_moment to fire: product page after 2 prior page views");

  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass via page_moment, got: ${result.reason}`);
  assert.match(result.reason, /^page moment:/, `expected a page_moment reason, got: ${result.reason}`);
  console.log("(xvi) ok — page_moment fires on a product page after 2 prior page views:", result.reason);

  resetSession(SID);
}

// ---- (xvi.b) page moment: does NOT fire on the first two page views -------
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/", T0, { targets: [] }));
  pushEvent(session, ev("page_view", "/product/banana-tshirt", T0 + 1000, { targets: ["product-image"] }));

  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const pageMoment = pageMomentCheck(state, session, lastEvent, lastEvent.ts);
  assert.equal(pageMoment.hit, false, "expected page_moment NOT to fire with only 1 prior page view");
  console.log("(xvi.b) ok — page_moment requires >= 2 prior page views");

  resetSession(SID);
}

// ---- (xvii) cost cap: floor calls are hard-capped at MAX_MODEL_CALLS_PER_MIN
// per rolling 60s window, regardless of reason ------------------------------
{
  resetSession(SID);
  const session = getSession(SID);
  const A = "/product/khadi-field-jacket";
  pushEvent(session, ev("page_view", A, T0, { targets: ["product-image"] }));

  let passCount = 0;
  let sawRateCapped = false;
  // Fire the consult floor repeatedly (each iteration's own dwell event is a
  // fresh non-heartbeat "shopper active" signal, spaced far enough inside
  // the same 60s window that the floor itself would hit every time were it
  // not for the cap) and confirm gate() stops passing at MAX_MODEL_CALLS_PER_MIN.
  for (let i = 0; i < MAX_MODEL_CALLS_PER_MIN + 3; i++) {
    const ts = T0 + CONSULT_FLOOR_MS + i * 500; // well past the floor from the very first iteration
    pushEvent(session, ev("dwell", "product-image", ts, { ms: 100 + i }));
    const lastEvent = session.events.at(-1);
    const state = buildState(session);
    const result = gate(state, session, lastEvent);
    if (result.pass) passCount++;
    else if (/^rate capped:/.test(result.reason)) sawRateCapped = true;
  }

  assert.equal(passCount, MAX_MODEL_CALLS_PER_MIN, `expected exactly ${MAX_MODEL_CALLS_PER_MIN} passes before the cap trims the rest, got ${passCount}`);
  assert.equal(sawRateCapped, true, "expected at least one gate() call to be denied with a rate-capped reason");
  console.log(`(xvii) ok — cost cap trims floor calls at ${MAX_MODEL_CALLS_PER_MIN}/min: ${passCount} passed, rest rate-capped`);

  resetSession(SID);
}

// ---- (xviii) exit_intent fires -------------------------------------------
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/product/khadi-field-jacket", T0, { targets: ["add-to-cart"] }));
  pushEvent(session, ev("exit_intent", "/product/khadi-field-jacket", T0 + 2000, { kind: "mouse_leave" }));
  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass via exit_intent, got: ${result.reason}`);
  assert.match(result.reason, /^exit intent:/);
  console.log("(xviii) ok — exit_intent fires:", result.reason);
  resetSession(SID);
}

// ---- (xix) atc_hesitation fires ------------------------------------------
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/product/khadi-field-jacket", T0, { targets: ["add-to-cart"] }));
  pushEvent(session, ev("atc_hesitation", "add-to-cart", T0 + 2000, { target: "add-to-cart", hovers: 2 }));
  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass via atc_hesitation, got: ${result.reason}`);
  assert.match(result.reason, /^add-to-cart hesitation:/);
  console.log("(xix) ok — atc_hesitation fires:", result.reason);
  resetSession(SID);
}

// ---- (xx) variant_churn fires with 2+ switches and no cart-add -----------
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/product/khadi-field-jacket", T0, { targets: ["size-option-m", "size-option-l"] }));
  pushEvent(session, ev("variant_switch", "size-option-m", T0 + 1000, { kind: "size" }));
  pushEvent(session, ev("variant_switch", "size-option-l", T0 + 2000, { kind: "size" }));
  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass via variant_churn, got: ${result.reason}`);
  assert.match(result.reason, /^variant churn:/);
  console.log("(xx) ok — variant_churn fires:", result.reason);
  resetSession(SID);
}

// ---- (xx.b) variant_churn does NOT fire once cart-add happened -----------
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/product/khadi-field-jacket", T0, { targets: ["size-option-m", "size-option-l"] }));
  pushEvent(session, ev("variant_switch", "size-option-m", T0 + 1000, { kind: "size" }));
  pushEvent(session, ev("variant_switch", "size-option-l", T0 + 2000, { kind: "size" }));
  pushEvent(session, ev("cart_update", "cart-add", T0 + 3000, { total: 1200, items: [] }));
  const state = buildState(session);
  const sig = computeSignals(state, session, T0 + 3500);
  assert.equal(sig.variantChurn.hit, false, "expected variantChurn NOT to fire after a cart-add");
  console.log("(xx.b) ok — variant_churn suppressed after cart-add");
  resetSession(SID);
}

// ---- (xxi) promo_focus_empty fires ---------------------------------------
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/cart", T0, { targets: ["promo-code"] }));
  pushEvent(session, ev("promo_focus_blur", "promo-code", T0 + 1000, { empty: true }));
  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass via promo_focus_empty, got: ${result.reason}`);
  assert.match(result.reason, /^promo code focused/);
  console.log("(xxi) ok — promo_focus_empty fires:", result.reason);
  resetSession(SID);
}

// ---- (xxi.b) promo_focus_empty does NOT fire when a code was typed -------
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/cart", T0, { targets: ["promo-code"] }));
  pushEvent(session, ev("promo_focus_blur", "promo-code", T0 + 1000, { empty: false }));
  const state = buildState(session);
  const sig = computeSignals(state, session, T0 + 1500);
  assert.equal(sig.promoFocusEmpty.hit, false, "expected promoFocusEmpty NOT to fire when a code was typed");
  console.log("(xxi.b) ok — promo_focus_empty suppressed when a code was typed");
  resetSession(SID);
}

// ---- (xxii) total_dwell fires on real cart-total attention ---------------
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/cart", T0, { targets: ["cart-total"] }));
  pushEvent(session, ev("dwell", "cart-total", T0 + 1000, { ms: 4200, kind: "attention" }));
  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass via total_dwell, got: ${result.reason}`);
  assert.match(result.reason, /^total dwell:/);
  console.log("(xxii) ok — total_dwell fires:", result.reason);
  resetSession(SID);
}

// ---- (xxiii) search_refine fires on 2+ different consecutive queries -----
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/search", T0, { targets: [] }));
  pushEvent(session, ev("search", "search", T0 + 1000, { q: "kantha" }));
  pushEvent(session, ev("search", "search", T0 + 2000, { q: "kantha scarf" }));
  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass via search_refine, got: ${result.reason}`);
  assert.match(result.reason, /^search refine:/);
  console.log("(xxiii) ok — search_refine fires:", result.reason);
  resetSession(SID);
}

// ---- (xxiv) scroll_uturn fires on a product page --------------------------
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/product/khadi-field-jacket", T0, { targets: [] }));
  pushEvent(session, ev("scroll_uturn", "/product/khadi-field-jacket", T0 + 3000, { downPct: 72 }));
  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass via scroll_uturn, got: ${result.reason}`);
  assert.match(result.reason, /^scroll u-turn/);
  console.log("(xxiv) ok — scroll_uturn fires:", result.reason);
  resetSession(SID);
}

// ---- (xxv) idle fires on a quiet product page after 20s+ of no input -----
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/product/khadi-field-jacket", T0, { targets: [] }));
  const ts = T0 + 21000;
  pushEvent(session, ev("dwell", "/product/khadi-field-jacket", ts, { ms: 21000 })); // page-level heartbeat, not "real input"
  const lastEvent = session.events.at(-1);
  const state = buildState(session);
  const result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected gate to pass via idle, got: ${result.reason}`);
  assert.match(result.reason, /^idle:/);
  console.log("(xxv) ok — idle fires:", result.reason);
  resetSession(SID);
}

// ---- (xxvi) signalsForReason()/forSignalsMap() — semantic trace category fix ----
// server/NOTES.md "generic reasons in the log" defect class: server.log and
// the trace panel used to show only the generic gate/guard/llm/quiet reason,
// never WHICH behavioral signal triggered the model call. signalsForReason()
// is the machine-readable counterpart of decide.md's own reason-prefix ->
// template prose table — must stay in sync with every context-aware trigger
// rule 13-19's own reason string shape.
{
  assert.deepEqual(signalsForReason("variant churn: 2 option switches within 30s, no add-to-cart"), [
    { name: "variant_churn", template: "variant_help" },
  ]);
  assert.deepEqual(signalsForReason("add-to-cart hesitation: 3.2s ago"), [{ name: "atc_hesitation", template: "atc_nudge" }]);
  assert.deepEqual(signalsForReason("exit intent: 1.0s ago"), [{ name: "exit_intent", template: "exit_intent_help" }]);
  assert.deepEqual(signalsForReason("idle: no input for 21s on /p (>= 20s), tab visible"), [{ name: "idle", template: "idle_check_in" }]);
  // A reason with no matching context-aware trigger (rules 1-12, floor, page_moment) yields [].
  assert.deepEqual(signalsForReason("element attention: size-guide 5.0s >= 5s on current page"), []);
  assert.deepEqual(signalsForReason(null), []);
  assert.deepEqual(signalsForReason(undefined), []);

  const map = forSignalsMap();
  assert.equal(map.variant_churn, "variant_help");
  assert.equal(map.atc_hesitation, "atc_nudge");
  assert.equal(map.idle, "idle_check_in");
  console.log("(xxvi) ok — signalsForReason()/forSignalsMap() map gate reasons to their template ids:", map);
}

// ---- (page_fact) page_context arrival with a strong fact is itself a gate
// signal, once per page path per session (2026-09-12 "richer scanned site
// context" brief). ---------------------------------------------------------
{
  resetSession(SID);
  const session = getSession(SID);
  const PRODUCT = "/product/leather-mojari-sandals";
  pushEvent(session, ev("page_view", PRODUCT, T0, { targets: ["product-image", "add-to-cart"] }));
  pushEvent(session, ev("page_context", PRODUCT, T0 + 500, { page_type: "product", stock_text: "Only 2 left in stock", promo_present: false }));

  let state = buildState(session);
  let lastEvent = session.events.at(-1);
  let result = gate(state, session, lastEvent);
  assert.equal(result.pass, true, `expected page_fact (low_stock) to pass gate, got: ${result.reason}`);
  assert.match(result.reason, /^page fact: low_stock/);
  assert.equal(state.page_context.stock.lowStockN, 2);

  // A second page_context on the SAME path must NOT re-fire the page_fact
  // signal, even carrying the exact same strong fact — once per page path
  // per session.
  pushEvent(session, ev("page_context", PRODUCT, T0 + 3000, { page_type: "product", stock_text: "Only 2 left in stock", promo_present: false }));
  state = buildState(session);
  lastEvent = session.events.at(-1);
  result = gate(state, session, lastEvent);
  assert.ok(
    !result.reason.startsWith("page fact: low_stock"),
    `expected page_fact to fire once per page path, got a second hit: ${result.reason}`
  );

  console.log("(page_fact) ok — low-stock page_context fires once per page path:", result.reason);
}

// ---- (page_fact free_shipping_gap) a real, small gap to the free-
// shipping threshold is a strong fact even with no low-stock text. --------
{
  resetSession(SID);
  const session = getSession(SID);
  pushEvent(session, ev("page_view", "/cart", T0, { targets: ["cart-total", "checkout-btn"] }));
  pushEvent(session, ev("cart_view", null, T0 + 100, { total: 1900, items: [{ sku: "x", qty: 1, price: 1900 }] }));
  pushEvent(session, ev("page_context", "/cart", T0 + 500, { page_type: "cart", promo_present: false }));

  const state = buildState(session);
  const lastEvent = session.events.at(-1);
  const result = gate(state, session, lastEvent);
  // Only asserted if the default store's free-shipping threshold actually
  // puts this gap under the 20% strong-fact bar — computed from real
  // cart_economics, not hardcoded, so this stays honest if the default
  // store's threshold ever changes.
  if (state.cart_economics && state.cart_economics.gapToFreeShipping > 0 && state.cart_economics.gapToFreeShipping / state.cart_economics.subtotal < 0.2) {
    assert.equal(result.pass, true, `expected page_fact (free_shipping_gap) to pass, got: ${result.reason}`);
    assert.match(result.reason, /^page fact: free_shipping_gap/);
    console.log("(page_fact free_shipping_gap) ok —", result.reason, state.cart_economics);
  } else {
    console.log("(page_fact free_shipping_gap) skipped — default store's threshold doesn't put this cart in the strong-fact band:", state.cart_economics);
  }
}

console.log("gate.test: all assertions passed");
