// server/store/index.js probe — plain node asserts (same style as
// gate.test.js/state.test.js). Run with `npm run test:store`
// (node store.test.js). Pure: builds fake `store` objects in-memory so
// these never depend on the real catalog.json/promos.json/policies.json
// contents (those can change without breaking this file's assertions).

import assert from "node:assert/strict";
import { computeOffers, businessBlock, searchCandidates, productSlugFromPage, classifyPath, getRoutes, cartEconomics, specDiff } from "./store/index.js";

const NOW = 1_700_000_000_000;

function fakeStore({ catalog = [], promos = [], policies = null } = {}) {
  return { catalog, promos, policies, loadedAt: NOW, ok: true };
}

const JACKET = {
  slug: "khadi-field-jacket",
  name: "Khadi Field Jacket",
  price: 3450,
  category: "outerwear",
  tags: ["handloom", "outerwear"],
  similar: ["nakshi-kantha-scarf"],
};
const SCARF = {
  slug: "nakshi-kantha-scarf",
  name: "Nakshi Kantha Scarf",
  price: 850,
  category: "scarf",
  tags: ["handloom", "outerwear"],
  similar: ["khadi-field-jacket"],
};

// ---- (i) missed_discount: cart has a code promo, not yet applied --------
{
  const store = fakeStore({
    catalog: [JACKET, SCARF],
    promos: [
      {
        id: "jacket10",
        code: "JACKET10",
        kind: "percent",
        value: 10,
        applies: { slugs: ["khadi-field-jacket"] },
        min_cart: null,
        starts_at: null,
        ends_at: null,
        ends_in_ms: 172800000, // 48h from server start
        label: "10% off the jacket",
        auto_apply: false,
      },
    ],
  });
  const cart = { total: 3450, items: [{ sku: "khadi-field-jacket", qty: 1, price: 3450 }] };
  const offers = computeOffers({ page: "/cart", cart, promo: null }, NOW, store);
  const missed = offers.find((o) => o.kind === "missed_discount");
  assert.ok(missed, "expected a missed_discount offer");
  assert.equal(missed.code, "JACKET10");
  assert.equal(missed.saving, 345, "10% of 3450 = 345");
  assert.equal(missed.target_hint, "promo-code");
  console.log("(i) ok — missed_discount fires with correct saving + target_hint:", missed);
}

// ---- (ii) missed_discount does NOT fire once the code is applied --------
{
  const store = fakeStore({
    catalog: [JACKET],
    promos: [
      {
        id: "jacket10",
        code: "JACKET10",
        kind: "percent",
        value: 10,
        applies: { slugs: ["khadi-field-jacket"] },
        min_cart: null,
        starts_at: null,
        ends_at: null,
        ends_in_ms: 172800000,
        label: "10% off the jacket",
        auto_apply: false,
      },
    ],
  });
  const cart = { total: 3105, items: [{ sku: "khadi-field-jacket", qty: 1, price: 3450 }] };
  const offers = computeOffers({ page: "/cart", cart, promo: { code: "JACKET10", discount: 345 } }, NOW, store);
  assert.equal(offers.filter((o) => o.kind === "missed_discount").length, 0, "already-applied code must not be reported as missed");
  console.log("(ii) ok — applied code suppresses missed_discount");
}

// ---- (iii) auto_discount_active: informational, no code to invent -------
{
  const store = fakeStore({
    catalog: [SCARF],
    promos: [
      {
        id: "scarf15",
        code: null,
        kind: "percent",
        value: 15,
        applies: { slugs: ["nakshi-kantha-scarf"] },
        min_cart: null,
        starts_at: null,
        ends_at: null,
        ends_in_ms: null,
        label: "15% off the scarf",
        auto_apply: true,
      },
    ],
  });
  const cart = { total: 850, items: [{ sku: "nakshi-kantha-scarf", qty: 1, price: 850 }] };
  const offers = computeOffers({ page: "/cart", cart, promo: null }, NOW, store);
  const auto = offers.find((o) => o.kind === "auto_discount_active");
  assert.ok(auto, "expected an auto_discount_active offer");
  assert.equal(auto.code, null, "auto-apply promos never carry a code to quote");
  assert.equal(offers.filter((o) => o.kind === "missed_discount").length, 0, "auto-apply promo is never a missed_discount");
  console.log("(iii) ok — auto_discount_active is informational, carries no code:", auto);
}

// ---- (iv) similar_on_promo: current product not on promo, similar is ----
{
  const store = fakeStore({
    catalog: [JACKET, SCARF],
    promos: [
      {
        id: "scarf15",
        code: null,
        kind: "percent",
        value: 15,
        applies: { slugs: ["nakshi-kantha-scarf"] },
        min_cart: null,
        starts_at: null,
        ends_at: null,
        ends_in_ms: null,
        label: "15% off the scarf",
        auto_apply: true,
      },
    ],
  });
  const offers = computeOffers({ page: "/product/khadi-field-jacket", cart: null, promo: null }, NOW, store);
  const sim = offers.find((o) => o.kind === "similar_on_promo");
  assert.ok(sim, "expected a similar_on_promo offer");
  assert.equal(sim.slug, "nakshi-kantha-scarf");
  assert.equal(sim.target_hint, "similar-products");
  assert.equal(sim.saving, Math.round(850 * 0.15), "saving computed off the similar product's own catalog price");
  console.log("(iv) ok — similar_on_promo fires for a non-promo product with a promo'd similar item:", sim);
}

// ---- (v) similar_on_promo does NOT fire when the current product itself is on promo ----
{
  const store = fakeStore({
    catalog: [JACKET, SCARF],
    promos: [
      {
        id: "jacket10",
        code: "JACKET10",
        kind: "percent",
        value: 10,
        applies: { slugs: ["khadi-field-jacket"] },
        min_cart: null,
        starts_at: null,
        ends_at: null,
        ends_in_ms: 172800000,
        label: "10% off the jacket",
        auto_apply: false,
      },
      {
        id: "scarf15",
        code: null,
        kind: "percent",
        value: 15,
        applies: { slugs: ["nakshi-kantha-scarf"] },
        min_cart: null,
        starts_at: null,
        ends_at: null,
        ends_in_ms: null,
        label: "15% off the scarf",
        auto_apply: true,
      },
    ],
  });
  const offers = computeOffers({ page: "/product/khadi-field-jacket", cart: null, promo: null }, NOW, store);
  assert.equal(offers.filter((o) => o.kind === "similar_on_promo").length, 0, "current product already on promo — no similar-item pitch needed");
  console.log("(v) ok — similar_on_promo suppressed when current product already has its own promo");
}

// ---- (vi) delivery_gap: within 10% under free_over, reuses gate.js's own CART_GAP_PCT ----
{
  const store = fakeStore({ policies: { delivery: { free_over: 2000 } } });
  const cart = { total: 1950, items: [] };
  const offers = computeOffers({ page: "/cart", cart, promo: null }, NOW, store);
  const gap = offers.find((o) => o.kind === "delivery_gap");
  assert.ok(gap, "expected a delivery_gap offer for a ৳50 gap (2.5% of ৳2000)");
  assert.equal(gap.gap, 50);
  assert.equal(gap.target_hint, "shipping-banner");
  console.log("(vi) ok — delivery_gap fires within the 10% band:", gap);
}

// ---- (vii) delivery_gap does NOT fire outside the 10% band --------------
{
  const store = fakeStore({ policies: { delivery: { free_over: 2000 } } });
  const cart = { total: 1000, items: [] }; // ৳1000 gap, 50% of threshold — well outside 10%
  const offers = computeOffers({ page: "/cart", cart, promo: null }, NOW, store);
  assert.equal(offers.filter((o) => o.kind === "delivery_gap").length, 0, "gap far outside the 10% band must not fire");
  console.log("(vii) ok — delivery_gap suppressed outside the 10% band");
}

// ---- (viii) ends_in_ms fallback + expiring_soon urgency ------------------
{
  const store = fakeStore({
    catalog: [JACKET],
    promos: [
      {
        id: "jacket10",
        code: "JACKET10",
        kind: "percent",
        value: 10,
        applies: { slugs: ["khadi-field-jacket"] },
        min_cart: null,
        starts_at: null,
        ends_at: null,
        ends_in_ms: 60 * 60 * 1000, // 1h from SERVER_START (module load time, not NOW)
        label: "10% off the jacket",
        auto_apply: false,
      },
    ],
  });
  const cart = { total: 3450, items: [{ sku: "khadi-field-jacket", qty: 1, price: 3450 }] };
  // NOW here is used only for gap math elsewhere; ends_in_ms is anchored to
  // real Date.now() at module load (SERVER_START), which for a test running
  // "now" means this promo is either active-and-soon-expiring or already
  // expired depending on how long the process has been up — assert on the
  // shape (ends_in_min is either null or a small non-negative number, and
  // when present and <= 180 the offer is marked urgent), not a fixed value.
  const offers = computeOffers({ page: "/cart", cart, promo: null }, Date.now(), store);
  const missed = offers.find((o) => o.kind === "missed_discount");
  if (missed) {
    assert.ok(missed.ends_in_min == null || missed.ends_in_min >= 0, "ends_in_min is null or non-negative");
    if (missed.ends_in_min != null && missed.ends_in_min <= 180) {
      assert.equal(missed.urgent, true, "expiring_soon: ends_in_min <= 180 must set urgent");
    }
  }
  console.log("(viii) ok — ends_in_ms fallback resolves to a sane ends_in_min:", missed);
}

// ---- (ix) businessBlock() shape -------------------------------------------
{
  const store = fakeStore({
    policies: {
      currency: "BDT",
      delivery: { free_over: 2000, city: "Dhaka", days: "1-2", fee: 80 },
      returns: { window_days: 7, note: "x" },
      payment: ["bKash", "COD", "card"],
      support: { hours: "x", contact: "y" },
    },
  });
  const block = businessBlock(store);
  assert.deepEqual(
    Object.keys(block).sort(),
    ["currency", "delivery", "payment", "returns"],
    "businessBlock is the compact {delivery, returns, payment, currency} subset"
  );
  assert.equal(block.delivery.free_over, 2000);
  console.log("(ix) ok — businessBlock returns the compact subset:", block);
}

// ---- (ix.b) businessBlock() currency — store-derived, never hardcoded ৳ ---
{
  const bdtStore = fakeStore({ policies: { currency: "BDT" } });
  const bdtBlock = businessBlock(bdtStore);
  assert.deepEqual(bdtBlock.currency, { code: "BDT", symbol: "৳", position: "before" });

  const usdStore = fakeStore({ policies: { currency: "USD" } });
  const usdBlock = businessBlock(usdStore);
  assert.deepEqual(usdBlock.currency, { code: "USD", symbol: "$", position: "before" });
  console.log("(ix.b) ok — businessBlock().currency reflects the site's own policies.currency:", bdtBlock.currency, usdBlock.currency);
}

// ---- (ix.c) computeOffers() delivery_gap/cart_under_threshold labels use the site's own currency symbol ----
{
  const usdStore = fakeStore({
    policies: { currency: "USD", delivery: { free_over: 100 } },
  });
  const cart = { total: 95, items: [] }; // gap 5, within 10% of a $100 threshold
  const offers = computeOffers({ page: "/cart", cart }, NOW, usdStore);
  const gapOffer = offers.find((o) => o.kind === "delivery_gap");
  assert.ok(gapOffer, "expected a delivery_gap offer");
  assert.equal(gapOffer.label, "$5 away from free delivery");
  console.log("(ix.c) ok — delivery_gap label uses USD $, not hardcoded ৳:", gapOffer.label);
}

// ---- (ix.d) cart item field-name mismatch (NextCart's {quantity} not {qty}, no {sku}) is normalized ----
{
  const store = fakeStore({
    catalog: [{ slug: "chino-pants", name: "Summit Trail Chino Pants High", price: 37.99 }],
    promos: [
      {
        id: "next10",
        code: "NEXT10",
        kind: "percent",
        value: 10,
        applies: { slugs: "all" },
        auto_apply: false,
      },
    ],
    policies: { currency: "USD" },
  });
  // NextCart's own cart payload shape (personal-nextcart Header.tsx's
  // buildAgentCartPayload): {name, variant, quantity, price} — no `sku`,
  // `quantity` not `qty`. Category fix: this must NOT silently treat qty
  // as 1 (server/store/index.js's normalizeCartItem()).
  const cart = {
    total: 75.98,
    items: [{ name: "Summit Trail Chino Pants High", quantity: 2, price: 37.99 }],
  };
  const offers = computeOffers({ page: "/cart", cart }, NOW, store);
  const missed = offers.find((o) => o.kind === "missed_discount");
  assert.ok(missed, "expected a missed_discount offer even with no item.sku (NEXT10 applies to all slugs)");
  assert.equal(missed.saving, 8, `10% of $75.98 (2 x $37.99) rounds to $8, got ${missed.saving}`);
  console.log("(ix.d) ok — NextCart's quantity/no-sku cart shape is normalized, saving computed off the real subtotal:", missed.saving);
}

// ---- (x) missing store degrades to no offers, no throw -------------------
{
  const offers = computeOffers({ page: "/cart", cart: { total: 1950, items: [] }, promo: null }, NOW, fakeStore({}));
  assert.ok(Array.isArray(offers), "computeOffers always returns an array");
  console.log("(x) ok — empty store yields an empty-safe offers array:", offers);
}

// ---- (xi) size_help: product page with sizes carries fit_notes/sizes/returns, no guessed value ----
{
  const JACKET_WITH_SIZES = {
    ...JACKET,
    sizes: ["S", "M", "L", "XL"],
    fit_notes: "Runs narrow through the shoulder — take the larger.",
  };
  const store = fakeStore({
    catalog: [JACKET_WITH_SIZES],
    policies: { returns: { window_days: 7, note: "x" } },
  });
  const offers = computeOffers({ page: "/product/khadi-field-jacket", cart: null, promo: null }, NOW, store);
  const help = offers.find((o) => o.kind === "size_help");
  assert.ok(help, "expected a size_help offer on a product page with sizes");
  assert.deepEqual(help.sizes, ["S", "M", "L", "XL"]);
  assert.equal(help.fit_notes, JACKET_WITH_SIZES.fit_notes);
  assert.equal(help.returns_window_days, 7);
  assert.equal(help.target_hint, "size-guide");
  assert.equal("value" in help, false, "size_help must never guess a specific size cta.value");
  console.log("(xi) ok — size_help carries fit_notes/sizes/returns, no guessed size:", help);
}

// ---- (xii) size_help does NOT fire for a product with no sizes -----------
{
  const store = fakeStore({ catalog: [{ ...SCARF, sizes: [] }] });
  const offers = computeOffers({ page: "/product/nakshi-kantha-scarf", cart: null, promo: null }, NOW, store);
  assert.equal(offers.filter((o) => o.kind === "size_help").length, 0, "no sizes on the product — no size_help offer");
  console.log("(xii) ok — size_help suppressed for a sizeless product");
}

// ---- (xiii) delivery_gap.fill_with: cheapest catalog item that closes the gap ----
{
  const CHEAP = { slug: "nakshi-kantha-scarf", name: "Nakshi Kantha Scarf", price: 850, category: "scarf", tags: [], similar: [] };
  const MID = { slug: "leather-mojari-sandals", name: "Leather Mojari Sandals", price: 1450, category: "footwear", tags: [], similar: [] };
  const store = fakeStore({
    catalog: [CHEAP, MID, JACKET],
    policies: { delivery: { free_over: 2000 } },
  });
  const cart = { total: 1950, items: [] }; // gap = 50
  const offers = computeOffers({ page: "/cart", cart, promo: null }, NOW, store);
  const gap = offers.find((o) => o.kind === "delivery_gap");
  assert.ok(gap, "expected a delivery_gap offer");
  assert.ok(gap.fill_with, "expected a fill_with suggestion");
  assert.equal(gap.fill_with.slug, "nakshi-kantha-scarf", "cheapest item whose price >= the gap wins, not just any item over threshold");
  assert.equal(gap.fill_with.price, 850);
  console.log("(xiii) ok — delivery_gap.fill_with picks the cheapest item that closes the gap:", gap.fill_with);
}

// ---- (xiv) delivery_gap.fill_with is null when nothing in the catalog closes the gap ----
{
  const store = fakeStore({
    catalog: [{ slug: "cheap-thing", name: "Cheap Thing", price: 10, category: "x", tags: [], similar: [] }],
    policies: { delivery: { free_over: 2000 } },
  });
  const cart = { total: 1950, items: [] }; // gap = 50, nothing in catalog costs >= 50
  const offers = computeOffers({ page: "/cart", cart, promo: null }, NOW, store);
  const gap = offers.find((o) => o.kind === "delivery_gap");
  assert.ok(gap, "expected a delivery_gap offer");
  assert.equal(gap.fill_with, null, "no catalog item can close the gap — fill_with must be null, not a guess");
  console.log("(xiv) ok — delivery_gap.fill_with is null when no catalog item qualifies:", gap.fill_with);
}

// ---- (xv) searchCandidates: fuzzy typo match against catalog name -------
{
  const store = fakeStore({ catalog: [SCARF, JACKET] });
  const candidates = searchCandidates("nakshi kanta scarf", store); // "kanta" typo of "kantha"
  assert.ok(candidates.length >= 1, "expected at least one candidate");
  assert.equal(candidates[0].slug, "nakshi-kantha-scarf");
  console.log("(xv) ok — searchCandidates fuzzy-matches a typo'd query:", candidates);
}

// ---- (xvi) searchCandidates: no match in catalog -> empty array ---------
{
  const store = fakeStore({ catalog: [SCARF, JACKET] });
  const candidates = searchCandidates("cotton punjabi", store);
  assert.deepEqual(candidates, [], "no real match in the catalog — must not guess");
  console.log("(xvi) ok — searchCandidates returns nothing for a genuinely unstocked query");
}

// ---- (xvii) search_help offer: zero-result search + a real candidate ----
{
  const store = fakeStore({ catalog: [SCARF, JACKET] });
  const offers = computeOffers(
    { page: "/", cart: null, promo: null, search: { q: "nakshi kanta scarf", results: 0 } },
    NOW,
    store
  );
  const help = offers.find((o) => o.kind === "search_help");
  assert.ok(help, "expected a search_help offer");
  assert.equal(help.query, "nakshi kanta scarf");
  assert.equal(help.results, 0);
  assert.ok(help.candidates.some((c) => c.slug === "nakshi-kantha-scarf"));
  console.log("(xvii) ok — search_help offer carries query + real candidates:", help);
}

// ---- (xviii) search_help does NOT fire when results is absent (unknown, not 0) ----
{
  const store = fakeStore({ catalog: [SCARF, JACKET] });
  const offers = computeOffers(
    { page: "/", cart: null, promo: null, search: { q: "nakshi kanta scarf" } }, // no results field
    NOW,
    store
  );
  assert.equal(offers.filter((o) => o.kind === "search_help").length, 0, "unknown result count must not be treated as zero");
  console.log("(xviii) ok — search_help suppressed when results is unknown, not 0");
}

// ---- (xix) search_help does NOT fire when zero-result but no real candidate ----
{
  const store = fakeStore({ catalog: [SCARF, JACKET] });
  const offers = computeOffers(
    { page: "/", cart: null, promo: null, search: { q: "cotton punjabi", results: 0 } },
    NOW,
    store
  );
  assert.equal(offers.filter((o) => o.kind === "search_help").length, 0, "zero-result search with no fuzzy candidate must not fabricate an offer");
  console.log("(xix) ok — search_help suppressed with no real candidate");
}

// ---- (xx) per-site route classification — category (a)/(c) fix (live
// finding, NextCart session final_nc_1219732343): a THIRD site's product
// route is /p/<slug>, not /product/<slug> or /products/<slug> — hardcoding
// two shapes silently failed on the third, leaving `product`/
// distinctProducts/checkoutReached wrong. Default (no store passed, or a
// store with no policies.routes) covers the union of all three known
// sites; a site's own policies.routes overrides per-key. ----
{
  assert.equal(productSlugFromPage("/p/summit-trail-chino-pants-high", { policies: { routes: { product: ["/p/"] } } }), "summit-trail-chino-pants-high", "NextCart's own /p/ route resolves a slug when declared");
  assert.equal(productSlugFromPage("/p/summit-trail-chino-pants-high"), "summit-trail-chino-pants-high", "DEFAULT_ROUTES (no store arg) covers /p/ too, for callers that predate per-site routes");
  assert.equal(productSlugFromPage("/product/khadi-field-jacket"), "khadi-field-jacket", "default store's /product/ route still resolves with no store arg");
  assert.equal(productSlugFromPage("/products/rickshaw-art-tee"), "rickshaw-art-tee", "Acme's /products/ route still resolves with no store arg");
  assert.equal(productSlugFromPage("/p/a/b"), null, "a path with an extra segment after the slug is not a product page");
  assert.equal(productSlugFromPage(null), null, "non-string page is null, never throws");

  // classifyPath: /checkout/address must classify as "checkout" (prefix
  // match, not exact-match) — the exact defect that left checkoutReached
  // false on NextCart despite real checkout visits.
  assert.equal(classifyPath("/checkout/address"), "checkout", "a checkout SUB-route still classifies as checkout (prefix match)");
  assert.equal(classifyPath("/cart"), "cart");
  assert.equal(classifyPath("/p/some-product"), "product");
  assert.equal(classifyPath("/search"), "search");
  assert.equal(classifyPath("/c/electronics"), "other", "a category route with no declared prefix classifies as other, not a throw");

  // getRoutes: an empty/malformed per-site override for one key falls back
  // to DEFAULT_ROUTES for just that key, never throws on a partial/old
  // policies.json.
  const partial = getRoutes({ policies: { routes: { cart: [] } } });
  assert.deepEqual(partial.cart, ["/cart"], "an empty override array falls back to the default for that key");
  assert.deepEqual(getRoutes(undefined).product, ["/product/", "/products/", "/p/"], "getRoutes(undefined) never throws, returns full defaults");

  console.log("(xx) ok — per-site product/cart/checkout/search route classification");
}

// ---- (xxi) cartEconomics() — 2026-09-12 "richer scanned site context"
// brief. NextCart-shaped cart (money in decimal major units, like
// import-nextcart.mjs's toCatalogEntry() output) with a free-shipping
// threshold (a non-NextCart-shaped store here — NextCart's OWN
// policies.json has free_over: 0, i.e. always-free standard shipping, see
// server/store/nextcart/policies.json — so this test uses a store WITH a
// real threshold, same shape as server/store/policies.json's default).
{
  const store = fakeStore({
    catalog: [JACKET, SCARF],
    promos: [
      {
        id: "jacket10",
        code: "JACKET10",
        kind: "percent",
        value: 10,
        applies: { slugs: ["khadi-field-jacket"] },
        min_cart: null,
        starts_at: null,
        ends_at: null,
        ends_in_ms: null,
        label: "10% off the jacket",
        auto_apply: false,
      },
    ],
    policies: { currency: "BDT", delivery: { free_over: 2000, days: "1-2", fee: 80 } },
  });
  const cart = { total: 1800, items: [{ sku: "khadi-field-jacket", qty: 1, price: 3450 }] };
  const offers = computeOffers({ page: "/cart", cart, promo: null }, NOW, store);
  const econ = cartEconomics({ cart, offers, store });
  assert.equal(econ.subtotal, 1800);
  assert.equal(econ.itemCount, 1);
  assert.equal(econ.freeShippingThreshold, 2000);
  assert.equal(econ.gapToFreeShipping, 200, "gap = 2000 - 1800");
  assert.ok(econ.bestPromo && econ.bestPromo.code === "JACKET10", "missed_discount offer surfaces as bestPromo");
  assert.equal(econ.deliveryEstimateDays, "1-2");
  assert.equal(econ.currency.code, "BDT");
  assert.equal(cartEconomics({ cart: null, offers: [], store }), null, "no cart -> null, not a throw");
  console.log("(xxi) ok — cartEconomics():", econ);
}

// ---- (xxii) specDiff() — NextCart's own product schema has no structured
// attributes/specs/features/material field (personal-nextcart's
// src/lib/schemas/product.ts: only brand/rating/reviewCount/price/
// variants/description) — so this diffs brand/rating/review_count/price/
// sizes, same fields import-nextcart.mjs's toCatalogEntry() now populates.
// Priority order: brand first, so two products differing in brand AND
// rating reports the brand difference, not the rating one.
{
  const earbudsA = {
    slug: "wavecrest-earbuds",
    name: "Wavecrest Noise-Isolating Wireless Earbuds",
    price: 53.99,
    category: "electronics",
    sizes: [],
    brand: "Wavecrest",
    rating: 4.3,
    review_count: 2306,
  };
  const earbudsB = {
    slug: "nexbeam-earbuds",
    name: "Nexbeam Earbuds",
    price: 49.99,
    category: "electronics",
    sizes: [],
    brand: "Nexbeam",
    rating: 4.6,
    review_count: 900,
  };
  const store = fakeStore({ catalog: [earbudsA, earbudsB] });

  const diff = specDiff("wavecrest-earbuds", "nexbeam-earbuds", store);
  assert.ok(diff, "a real diff is found between two different-brand products");
  assert.equal(diff.field, "brand", "brand is checked first — the most-distinguishing real field");
  assert.match(diff.feature, /Nexbeam/);

  // Identical catalog entries (same brand/rating/review_count/price/sizes)
  // -> no diff, not a fabricated one.
  const twin = { ...earbudsA, slug: "wavecrest-earbuds-2" };
  const storeTwins = fakeStore({ catalog: [earbudsA, twin] });
  assert.equal(specDiff("wavecrest-earbuds", "wavecrest-earbuds-2", storeTwins), null, "identical entries -> null, never invented");

  // Unknown slug -> null, never throws.
  assert.equal(specDiff("wavecrest-earbuds", "not-a-real-slug", store), null);
  assert.equal(specDiff(null, "nexbeam-earbuds", store), null);

  console.log("(xxii) ok — specDiff():", diff);
}

console.log("store.test: all assertions passed");
