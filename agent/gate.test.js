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
import { gate, computeSignals, consultFloorCheck, pageMomentCheck, CONSULT_FLOOR_MS, MAX_MODEL_CALLS_PER_MIN } from "./gate.js";
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

  // 30 identical page-level dwell heartbeats — page dwell alone is never a
  // signal, and nothing else about the situation changes.
  let allQuiet = true;
  for (let i = 1; i <= 30; i++) {
    pushEvent(session, ev("dwell", PATH, T0 + i * 1000, { ms: i * 1000 }));
    state = buildState(session);
    const should = shouldCallDecider(session, session.events.at(-1), state);
    if (should) allQuiet = false;
  }
  assert.equal(allQuiet, true, "expected 30 page-level heartbeats after a decision to all be quiet ticks");
  console.log("(vi.a) ok — 30 page-level heartbeats after a decision are all quiet ticks");

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

console.log("gate.test: all assertions passed");
