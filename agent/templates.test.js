// server/templates.js probe — plain node asserts (same style as
// probe-policy.test.js / state.test.js). Run with `node templates.test.js`
// (npm run test:templates).

import assert from "node:assert/strict";
import { renderCard, listTemplateIds, anchorChain } from "./templates.js";

function fakeState(overrides = {}) {
  return {
    page: "/p/khadi-field-jacket",
    visibleTargets: ["size-guide"],
    cart: null,
    promo: null,
    search: null,
    facts: null,
    business: {
      delivery: { free_over: 2000, fee: 100 },
      returns: { window_days: 7 },
      payment: { methods: ["bKash", "Cash on delivery"] },
    },
    offers: [],
    product: { slug: "khadi-field-jacket", name: "Khadi Field Jacket", price: 3450, sizes: ["S", "M", "L", "XL"], fit_notes: "Runs narrow through the shoulder." },
    ...overrides,
  };
}

// (i) render: a real template + grounded slots produces the expected title/body.
{
  const state = fakeState();
  const card = {
    template: "size_help",
    slots: { fit_notes: "Runs narrow through the shoulder.", returns_window_days: "7" },
  };
  const result = renderCard(card, state);
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.equal(result.title, "Between sizes?");
  assert.equal(result.body, "Runs narrow through the shoulder. Returns are free within 7 days.");
  console.log("(i) ok — size_help renders from grounded slots:", result.body);
}

// (ii) missing slot -> denied, fail closed.
{
  const state = fakeState();
  const card = { template: "size_help", slots: { fit_notes: "Runs narrow through the shoulder." } };
  const result = renderCard(card, state);
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing slot "returns_window_days"/);
  console.log("(ii) ok — missing slot denied:", result.reason);
}

// (iii) unknown template id -> denied, fail closed.
{
  const state = fakeState();
  const card = { template: "not_a_real_template", slots: {} };
  const result = renderCard(card, state);
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown id/);
  console.log("(iii) ok — unknown template id denied:", result.reason);
}

// (iv) slot value not grounded in state (fabricated) -> denied, fail closed.
{
  const state = fakeState();
  const card = { template: "size_help", slots: { fit_notes: "Totally invented sizing advice.", returns_window_days: "7" } };
  const result = renderCard(card, state);
  assert.equal(result.ok, false);
  assert.match(result.reason, /not grounded in store facts/);
  console.log("(iv) ok — fabricated slot value denied:", result.reason);
}

// (v) slot value exceeding its template max_len -> denied, fail closed.
{
  const state = fakeState();
  const longCode = "A".repeat(30);
  const offers = [{ kind: "missed_discount", code: longCode, saving: 345 }];
  const card = { template: "missed_discount", slots: { code: longCode, saving: "345" } };
  const result = renderCard(card, fakeState({ offers }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /exceeds 20 chars/);
  console.log("(v) ok — oversized slot value denied:", result.reason);
}

// (vi) rendered title/body stays comfortably within the contract ceiling
// (60/200) even at every slot's own max_len — by design (each template's
// per-slot max_len is chosen so the filled skeleton can never overflow),
// but renderCard() still enforces the ceiling itself as defense in depth:
// a maximally-long, still-grounded label renders without being denied.
{
  const longLabel = "B".repeat(60); // similar_on_promo's label max_len
  const state = fakeState({
    offers: [{ kind: "similar_on_promo", label: longLabel, saving: 128 }],
  });
  const card = { template: "similar_on_promo", slots: { label: longLabel, saving: "128" } };
  const result = renderCard(card, state);
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.ok(result.body.length <= 200, "rendered body respects the 200-char contract ceiling");
  console.log("(vi) ok — max-length grounded slots still render within the contract ceiling:", result.body.length, "chars");
}

// (vii) back-compat: a free title/body card (no template) is not this
// module's concern at all — renderCard() is only ever called by
// server/policy.js when card.template is truthy; calling it directly with
// no template returns a clean "missing" denial rather than throwing.
{
  const result = renderCard({ template: null, slots: null, title: "Hi", body: "There" }, fakeState());
  assert.equal(result.ok, false);
  assert.match(result.reason, /template id missing/);
  console.log("(vii) ok — no-template call denied cleanly (policy.js never calls renderCard for a free-text card)");
}

// (viii) every template referenced in server/prompts/decide.md's "Card
// recipes" section actually exists in templates.json (id list sanity).
{
  const ids = listTemplateIds().sort();
  const expected = [
    "atc_nudge",
    "auto_discount_active",
    "cart_under_threshold",
    "checkout_bounce",
    "compare_back",
    "delivery_gap",
    "delivery_reassure",
    "exit_intent_help",
    "free_shipping_gap",
    "idle_check_in",
    "low_stock",
    "low_stock_nudge",
    "missed_discount",
    "promo_hint",
    "review_confidence",
    "search_help",
    "search_refine_help",
    "similar_on_promo",
    "size_availability",
    "size_help",
    "spec_diff_hint",
    "stuck_checkout",
    "total_reassure",
    "variant_help",
  ];
  assert.deepEqual(ids, expected);
  console.log("(viii) ok — templates.json has the expected", expected.length, "template ids:", ids.join(", "));
}

// (ix) an array's own length is a groundable fact (search_help's `count`
// slot, derived from offers[].candidates.length, not a literal field).
{
  const state = fakeState({
    search: { q: "nakshi kanta scarf", results: 0 },
    offers: [
      {
        kind: "search_help",
        query: "nakshi kanta scarf",
        results: 0,
        candidates: [{ slug: "nakshi-kantha-scarf", name: "Nakshi Kantha Scarf" }],
      },
    ],
  });
  const card = { template: "search_help", slots: { count: "1", name: "Nakshi Kantha Scarf" } };
  const result = renderCard(card, state);
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.equal(result.body, "Found 1 match for Nakshi Kantha Scarf.");
  console.log("(ix) ok — candidate array length grounds the count slot:", result.body);
}

// (x) {name|singular|plural} pluralization — grammar-fix category (live
// finding, NextCart session final_nc_1219732343: "Found 3 match" instead of
// "3 matches"). count=1 stays singular (covered by (ix) above), count>1
// switches to the plural word.
{
  const state = fakeState({
    search: { q: "bluetoth headphnes", results: 0 },
    offers: [
      {
        kind: "search_help",
        query: "bluetoth headphnes",
        results: 0,
        candidates: [
          { slug: "pulsegear-noise-cancelling-headphones-pro", name: "Pulsegear Noise-Cancelling Headphones Pro" },
          { slug: "voltara-studio-noise-cancelling-headphones-2-0", name: "Voltara Studio Noise-Cancelling Headphones 2.0" },
          { slug: "sonique-studio-noise-cancelling-headphones", name: "Sonique Studio Noise-Cancelling Headphones" },
        ],
      },
    ],
  });
  const card = { template: "search_help", slots: { count: "3", name: "Pulsegear Noise-Cancelling Headphones Pro" } };
  const result = renderCard(card, state);
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  assert.equal(result.body, "Found 3 matches for Pulsegear Noise-Cancelling Headphones Pro.");
  console.log("(x) ok — count > 1 pluralizes match -> matches:", result.body);
}

// (xi) anchorChain() — category (b) fix (live finding session
// final_tm_242431): every template with a real offers[]-grounded target has
// an ordered fallback chain EXCEPT size_help, which must have none (never
// fall back for pick_size — it needs the shopper to actually be on the size
// picker).
{
  assert.equal(anchorChain("size_help"), null, "size_help must declare no anchor fallback chain");
  const missedDiscountChain = anchorChain("missed_discount");
  assert.ok(Array.isArray(missedDiscountChain) && missedDiscountChain.length > 1);
  assert.equal(missedDiscountChain[0], "promo-code", "chain's first entry is the template's own natural target_hint");
  assert.equal(anchorChain("not_a_real_template"), null, "unknown template id returns null, not a throw");
  console.log("(xi) ok — anchorChain(): size_help has none, missed_discount has a real ordered chain:", missedDiscountChain.join(" -> "));
}

// (xii) page-scanned-context templates (2026-09-12 brief) render from
// page_context/comparison/cart_economics/spec_diff grounding, and reject a
// slot value not present in any of them.
{
  const state = fakeState({
    page_context: {
      type: "product",
      product: { title: "Khadi Field Jacket", price: 3450, compareAt: null, currency: "৳" },
      variants: { options: [], availableJoined: "L, XL", unavailableJoined: "M" },
      stock: { text: "Only 2 left in stock", lowStockN: 2 },
      delivery: { text: "Arrives in 2-4 days" },
      rating: { value: 4.5, count: 812 },
      badges: [],
      category: null,
      search: null,
      cartSummary: null,
      promoPresent: false,
    },
    comparison: [{ path: "/p/other-jacket", slug: "other-jacket", title: "Cascade Runner Jacket", price: 2900, delta: 550 }],
    cart_economics: { subtotal: 1800, itemCount: 2, freeShippingThreshold: 2000, gapToFreeShipping: 200, bestPromo: null, deliveryEstimateDays: "2-4", currency: { code: "BDT", symbol: "৳", position: "prefix" } },
    spec_diff: { other_title: "Cascade Runner Jacket", other_slug: "cascade-runner-jacket", other_path: "/p/cascade-runner-jacket", feature: "is rated 4.8" },
  });

  const lowStock = renderCard({ template: "low_stock_nudge", slots: { n: "2", variant: "M" } }, state);
  assert.equal(lowStock.ok, true, JSON.stringify(lowStock));
  assert.equal(lowStock.body, "Only 2 left in M");

  const freeShip = renderCard({ template: "free_shipping_gap", slots: { gap: "200" } }, state);
  assert.equal(freeShip.ok, true, JSON.stringify(freeShip));
  assert.equal(freeShip.body, "Add ৳200 more for free shipping");

  const deliveryReassure = renderCard({ template: "delivery_reassure", slots: { delivery: "Arrives in 2-4 days" } }, state);
  assert.equal(deliveryReassure.ok, true, JSON.stringify(deliveryReassure));

  const compareBack = renderCard({ template: "compare_back", slots: { other_title: "Cascade Runner Jacket", delta: "550" } }, state);
  assert.equal(compareBack.ok, true, JSON.stringify(compareBack));
  assert.equal(compareBack.body, "Cascade Runner Jacket you looked at is ৳550 cheaper");

  const sizeAvail = renderCard({ template: "size_availability", slots: { unavailable: "M", available: "L, XL" } }, state);
  assert.equal(sizeAvail.ok, true, JSON.stringify(sizeAvail));
  assert.equal(sizeAvail.body, "M is sold out here, L, XL are in stock");

  const review = renderCard({ template: "review_confidence", slots: { rating: "4.5", count: "812" } }, state);
  assert.equal(review.ok, true, JSON.stringify(review));
  assert.equal(review.body, "Rated 4.5 by 812 shoppers");

  const specDiffHint = renderCard({ template: "spec_diff_hint", slots: { other_title: "Cascade Runner Jacket", feature: "is rated 4.8" } }, state);
  assert.equal(specDiffHint.ok, true, JSON.stringify(specDiffHint));

  // Reject: a value that never appears in page_context/comparison/
  // cart_economics/spec_diff (or any other grounded block) — same
  // fail-closed contract as (iv) above, extended to the new blocks.
  const fabricated = renderCard({ template: "low_stock_nudge", slots: { n: "999", variant: "M" } }, state);
  assert.equal(fabricated.ok, false);
  assert.match(fabricated.reason, /not grounded/);

  console.log("(xii) ok — page-scanned-context templates render from grounded page_context/comparison/cart_economics/spec_diff, reject a fabricated slot value");
}

// (xiii) fact-slot fuzzy grounding + autofill (2026-09-12 live-run fix —
// see server/NOTES.md/POLICY.md: 0 cards shown in a 14-minute live run
// because the model paraphrases free-text facts and strict exact-match
// grounding denied every one of them).
{
  const state = fakeState({
    business: {
      delivery: { free_over: 2000, fee: 0 },
      returns: { window_days: 7 },
      payment: { methods: ["bKash", "Cash on delivery"] },
      currency: { code: "BDT", symbol: "৳", position: "before" },
    },
    offers: [{ kind: "delivery_gap", label: "৳50 away from free delivery", gap: 50 }],
  });

  // (a) exact match still works (unchanged fast path).
  const exact = renderCard({ template: "total_reassure", slots: { breakdown_fact: "৳50 away from free delivery" } }, state);
  assert.equal(exact.ok, true, JSON.stringify(exact));
  assert.deepEqual(exact.autofilled, []);

  // (b) paraphrase of a real fact (shares the number 50 with offers[0].label)
  // passes via fuzzy match, not autofill.
  const paraphrase = renderCard(
    { template: "total_reassure", slots: { breakdown_fact: "You're only ৳50 short of free shipping" } },
    state
  );
  assert.equal(paraphrase.ok, true, JSON.stringify(paraphrase));
  assert.deepEqual(paraphrase.autofilled, [], "fuzzy match, not autofill — the model's own text is kept");

  // (c) a fact slot with NO relation to any grounded fact (no shared number
  // or keyword) falls back to autofill from the template's declared source
  // (business.delivery) rather than being denied outright.
  const noRelation = renderCard({ template: "idle_check_in", slots: { fact: "hope you are having a wonderful day" } }, state);
  assert.equal(noRelation.ok, true, JSON.stringify(noRelation));
  assert.deepEqual(noRelation.autofilled, ["fact"]);
  assert.match(noRelation.body, /Free delivery over ৳2000/);

  // (d) deny-when-no-source: same unrelated text, but business.delivery is
  // absent this time — autofill has nothing to resolve, so it fails closed
  // exactly like the old strict contract, not silently through.
  const noSourceState = fakeState({ business: null, offers: [] });
  const denied = renderCard({ template: "idle_check_in", slots: { fact: "hope you are having a wonderful day" } }, noSourceState);
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /not grounded|no fact source/);

  // (e) exact/code/price slots (kind !== "fact") are UNCHANGED: a
  // fabricated code is still denied outright, never fuzzy-matched or
  // autofilled, even though "10" appears as a substring-ish number
  // elsewhere.
  const fabricatedCode = renderCard({ template: "missed_discount", slots: { code: "MADEUP10", saving: "10" } }, fakeState({ offers: [{ kind: "missed_discount", code: "REAL10", saving: 10 }] }));
  assert.equal(fabricatedCode.ok, false);
  assert.match(fabricatedCode.reason, /not grounded in store facts/);

  console.log("(xiii) ok — fact slots: exact -> fuzzy -> autofill -> deny; exact/code slots unchanged");
}

console.log("\ntemplates.test: all assertions passed");
