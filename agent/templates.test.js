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
    "auto_discount_active",
    "cart_under_threshold",
    "checkout_bounce",
    "delivery_gap",
    "low_stock",
    "missed_discount",
    "search_help",
    "similar_on_promo",
    "size_help",
    "stuck_checkout",
  ];
  assert.deepEqual(ids, expected);
  console.log("(viii) ok — templates.json has the expected 10 template ids:", ids.join(", "));
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

console.log("\ntemplates.test: all assertions passed");
