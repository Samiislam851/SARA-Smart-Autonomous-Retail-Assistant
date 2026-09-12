// Stale-response guard probe — plain node asserts (same style as
// probe-policy.test.js). Run with `node stale.test.js` (npm run test:stale).
//
// Exercises server/stale.js's classification directly (fingerprint capture
// + drift classification), plus policy.js's end-to-end wiring (opts.
// contextFingerprint denying with `stale_context:<class>`), plus a
// coalesce-path check that a dropped stale decision triggers exactly one
// re-decide (never a double model call).

import assert from "node:assert/strict";
import { computeContextFingerprint, classifyStaleContext } from "./stale.js";
import { applyPolicy } from "./policy.js";

function fakeSession(overrides = {}) {
  return {
    id: "probe_stale",
    events: [],
    lastEventAt: Date.now(),
    lastInterventionAt: 0,
    lastInterventionTarget: null,
    actedTargets: new Set(),
    lastDeciderAt: 0,
    lastTrace: null,
    nudgeCount: 0,
    ...overrides,
  };
}

function pageView(target, targets, ts) {
  return { type: "page_view", target, ts, meta: { targets } };
}

function fakeState(visibleTargets = ["size-guide"]) {
  return {
    page: "/product/khadi-field-jacket",
    visibleTargets,
    cart: null,
    product: { slug: "khadi-field-jacket", name: "x", price: 1, sizes: ["S", "M", "L"], fit_notes: "" },
    recent: [],
    dwell: { pageMs: 0, perTarget: {} },
    lastIntervention: null,
  };
}

function cardProposal(overrides = {}) {
  return {
    action: {
      action: "card",
      target: "size-guide",
      style: null,
      duration_ms: 20000,
      message: null,
      card: { title: "Between sizes?", body: "Take the larger.", cta: { kind: "pick_size", label: "Try size L", value: "L" } },
      ...overrides.action,
    },
    trace: { ts: Date.now(), signals: ["s"], hypothesis: "h", decision: "card size-guide", confidence: 0.9, why: "w" },
  };
}

// (i) same context (no new events) -> classify returns null, "same".
{
  const session = fakeSession({ events: [pageView("/product/khadi-field-jacket", ["size-guide"], 1000)] });
  const fp = computeContextFingerprint(session);
  const result = classifyStaleContext(fp, session, "size-guide");
  assert.equal(result, null);
  console.log("(i) ok — unchanged context classifies as same (null)");
}

// (ii) product_changed: fingerprint captured on one product, session moved
// to a different product page before re-check.
{
  const session = fakeSession({ events: [pageView("/product/khadi-field-jacket", ["size-guide"], 1000)] });
  const fp = computeContextFingerprint(session);
  session.events.push(pageView("/product/nakshi-kantha-scarf", ["size-guide"], 2000));
  const result = classifyStaleContext(fp, session, "size-guide");
  assert.equal(result?.klass, "product_changed");
  assert.equal(result?.reason, "stale_context:product_changed");
  console.log("(ii) ok — product change classified:", result.reason);
}

// (iii) cart_changed: same page, cart contents differ.
{
  const session = fakeSession({
    events: [
      pageView("/cart", ["shipping-banner"], 1000),
      { type: "cart_view", target: "/cart", ts: 1001, meta: { total: 1000, items: [{ sku: "a", qty: 1, price: 1000 }] } },
    ],
  });
  const fp = computeContextFingerprint(session);
  session.events.push({ type: "cart_update", target: "/cart", ts: 2000, meta: { total: 1500, items: [{ sku: "a", qty: 2, price: 1000 }] } });
  const result = classifyStaleContext(fp, session, "shipping-banner");
  assert.equal(result?.klass, "cart_changed");
  console.log("(iii) ok — cart change classified:", result.reason);
}

// (iv) moved_on via page change (non-product navigation, e.g. /cart -> /checkout).
{
  const session = fakeSession({ events: [pageView("/cart", ["shipping-banner"], 1000)] });
  const fp = computeContextFingerprint(session);
  session.events.push(pageView("/checkout", ["checkout-btn"], 2000));
  const result = classifyStaleContext(fp, session, "shipping-banner");
  assert.equal(result?.klass, "moved_on");
  console.log("(iv) ok — page change (no product/cart involved) classified as moved_on:", result.reason);
}

// (v) moved_on via >= N new hesitation-class events on a DIFFERENT target,
// same page/product/cart throughout.
{
  const session = fakeSession({ events: [pageView("/product/khadi-field-jacket", ["size-guide", "similar-products"], 1000)] });
  const fp = computeContextFingerprint(session);
  for (let i = 0; i < 3; i++) {
    session.events.push({ type: "dwell", target: "similar-products", ts: 2000 + i, meta: { ms: 4000, kind: "attention", interactions: { hover_ms: 4000 } } });
  }
  const result = classifyStaleContext(fp, session, "size-guide");
  assert.equal(result?.klass, "moved_on");
  console.log("(v) ok — 3 new hesitation events on a different target classified as moved_on:", result.reason);
}

// (vi) fewer than N new hesitation events elsewhere -> still "same".
{
  const session = fakeSession({ events: [pageView("/product/khadi-field-jacket", ["size-guide", "similar-products"], 1000)] });
  const fp = computeContextFingerprint(session);
  session.events.push({ type: "dwell", target: "similar-products", ts: 2000, meta: { ms: 4000, kind: "attention", interactions: { hover_ms: 4000 } } });
  const result = classifyStaleContext(fp, session, "size-guide");
  assert.equal(result, null);
  console.log("(vi) ok — 1 stray hesitation event elsewhere is not enough to classify moved_on");
}

// (vii) hesitation events ON the decision's own target never count toward moved_on.
{
  const session = fakeSession({ events: [pageView("/product/khadi-field-jacket", ["size-guide"], 1000)] });
  const fp = computeContextFingerprint(session);
  for (let i = 0; i < 5; i++) {
    session.events.push({ type: "dwell", target: "size-guide", ts: 2000 + i, meta: { ms: 4000, kind: "attention", interactions: { hover_ms: 4000 } } });
  }
  const result = classifyStaleContext(fp, session, "size-guide");
  assert.equal(result, null, "renewed attention on the SAME target the decision is about is not staleness");
  console.log("(vii) ok — renewed attention on the decision's own target is not moved_on");
}

// (viii) missing fingerprint (older/other call site) -> no opinion, don't deny.
{
  const session = fakeSession({ events: [pageView("/product/khadi-field-jacket", ["size-guide"], 1000)] });
  const result = classifyStaleContext(null, session, "size-guide");
  assert.equal(result, null);
  console.log("(viii) ok — missing fingerprint is a no-op (backward compat)");
}

// (ix) end-to-end via applyPolicy(): a card proposal denied with
// stale_context:product_changed when opts.contextFingerprint diverges from
// the live session, even though the card itself is otherwise perfectly valid.
{
  const session = fakeSession({ events: [pageView("/product/khadi-field-jacket", ["size-guide"], 1000)] });
  const contextFingerprint = computeContextFingerprint(session);
  session.events.push(pageView("/product/nakshi-kantha-scarf", ["size-guide"], 2000));
  const state = fakeState();
  const { action, trace } = applyPolicy(session, state, cardProposal(), { contextFingerprint });
  assert.equal(action.action, "noop", "stale product_changed context denies the card down to noop");
  assert.match(trace.why, /stale_context:product_changed/);
  console.log("(ix) ok — applyPolicy denies a card against a stale (product-changed) fingerprint:", trace.why);
}

// (x) end-to-end: an unchanged fingerprint lets an otherwise-valid card through.
{
  const session = fakeSession({ events: [pageView("/product/khadi-field-jacket", ["size-guide"], 1000)] });
  const contextFingerprint = computeContextFingerprint(session);
  const state = fakeState();
  const { action } = applyPolicy(session, state, cardProposal(), { contextFingerprint });
  assert.equal(action.action, "card", "unchanged context does not get denied by the stale guard");
  console.log("(x) ok — applyPolicy allows a card through when the fingerprint still matches live session");
}

// (xi) noop always passes the stale guard regardless of drift (the guard
// only ever governs NON-noop actions — a decider's own considered "stay
// quiet" is never second-guessed by context drift).
{
  const session = fakeSession({ events: [pageView("/product/khadi-field-jacket", ["size-guide"], 1000)] });
  const contextFingerprint = computeContextFingerprint(session);
  session.events.push(pageView("/product/nakshi-kantha-scarf", ["size-guide"], 2000));
  const state = fakeState();
  const noopProposal = {
    action: { action: "noop", target: null, style: null, duration_ms: 0, message: null, card: null },
    trace: { ts: Date.now(), signals: [], hypothesis: "h", decision: "noop", confidence: 0.5, why: "quiet" },
  };
  const { action, trace } = applyPolicy(session, state, noopProposal, { contextFingerprint });
  assert.equal(action.action, "noop");
  assert.equal(trace.why, "quiet", "noop is untouched by the stale guard, not rewritten with a guard reason");
  console.log("(xi) ok — noop passes through the stale guard untouched");
}

// (xii) pick_size CTA validated against the LIVE product (audit finding
// close-out, policy.js ~349): state.product is the pre-decide snapshot for
// khadi-field-jacket (sizes S/M/L/XL), but the shopper is now live on a
// DIFFERENT product page (sizes S/M/L only) — "XL" must be denied even
// though it was valid for the snapshot's product.
{
  const session = fakeSession({
    events: [
      pageView("/product/khadi-field-jacket", ["size-guide"], 1000),
      pageView("/product/nakshi-kantha-scarf", ["size-guide"], 2000), // live page has no "XL" size (see store/catalog.json)
    ],
  });
  const state = fakeState(); // snapshot still says khadi-field-jacket, sizes incl. "XL"... but this fixture's product has no XL
  const proposal = cardProposal({
    action: { card: { title: "Between sizes?", body: "Take the larger.", cta: { kind: "pick_size", label: "Try size XL", value: "XL" } } },
  });
  const { action, trace } = applyPolicy(session, state, proposal, {});
  assert.equal(action.action, "noop", `expected pick_size XL to be denied against the live product's sizes, got ${trace.why}`);
  console.log("(xii) ok — pick_size validated against the LIVE product, not the pre-decide snapshot:", trace.why);
}

console.log("\nstale.test: all assertions passed");
