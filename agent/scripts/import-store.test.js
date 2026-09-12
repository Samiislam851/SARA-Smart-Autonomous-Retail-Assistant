// import-store.test.js — pure unit test of buildStoreFiles() against a
// saved sample response from the live Acme API
// (__fixtures__/acme-products.json, captured 2026-09-12 via
// `GET /v1/products`, `/v1/categories`, `/v1/products?category_slug=...`).
// No network, no live API required — see server/scripts/import-store.mjs's
// own module comment for what this script does end to end.
//
// Run: node server/scripts/import-store.test.js

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStoreFiles } from "./import-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, "__fixtures__", "acme-products.json"), "utf8")
);

const products = fixture.products_page_1.data;
const categories = fixture.categories;

// Reconstruct the slug -> category-slug map the same way
// import-store.mjs's categoryMap() does (one category-filtered listing per
// category, tag every product slug found in it).
const categoryOfSlug = new Map();
for (const cat of categories) {
  const listing = fixture.products_by_category[cat.slug];
  for (const p of listing.data) categoryOfSlug.set(p.slug, cat.slug);
}

// ---- (i) product count survives the import (>= live total) ---------------
{
  const { catalog } = buildStoreFiles({
    products,
    categories: { map: categoryOfSlug },
    couponRows: null,
  });
  assert.equal(catalog.length, products.length, "every product in the page becomes a catalog entry");
  assert.ok(catalog.length >= 16, `expected >=16 products, got ${catalog.length}`);
}

// ---- (ii) price is converted poisha -> Taka -------------------------------
{
  const { catalog } = buildStoreFiles({ products, categories: { map: categoryOfSlug }, couponRows: null });
  const mug = catalog.find((p) => p.slug === "chaa-break-mug");
  assert.ok(mug, "chaa-break-mug present in fixture");
  const rawMug = products.find((p) => p.slug === "chaa-break-mug");
  assert.equal(mug.price, Math.round(rawMug.base_price / 100), "price divided by 100 (poisha -> Taka)");
}

// ---- (iii) sizes: "One Size"-only products get sizes: [] ------------------
{
  const { catalog } = buildStoreFiles({ products, categories: { map: categoryOfSlug }, couponRows: null });
  const mug = catalog.find((p) => p.slug === "chaa-break-mug");
  assert.deepEqual(mug.sizes, [], "One Size variants collapse to an empty sizes array");
}

// ---- (iv) sizes: apparel with real size variants gets deduped sizes -------
{
  const { catalog } = buildStoreFiles({ products, categories: { map: categoryOfSlug }, couponRows: null });
  const apparelWithSizes = catalog.find((p) => Array.isArray(p.sizes) && p.sizes.length > 0);
  assert.ok(apparelWithSizes, "at least one product in the fixture has real sizes");
  const uniq = new Set(apparelWithSizes.sizes);
  assert.equal(uniq.size, apparelWithSizes.sizes.length, "sizes are deduped");
}

// ---- (v) category tagged from the category-filtered listings -------------
{
  const { catalog } = buildStoreFiles({ products, categories: { map: categoryOfSlug }, couponRows: null });
  for (const p of catalog) {
    assert.ok(p.category, `${p.slug} has a category`);
    assert.ok(p.tags.includes(p.category), `${p.slug}'s tags include its own category`);
  }
}

// ---- (vi) similar: within-category cross-sell, never includes itself -----
{
  const { catalog } = buildStoreFiles({ products, categories: { map: categoryOfSlug }, couponRows: null });
  for (const p of catalog) {
    assert.ok(!p.similar.includes(p.slug), `${p.slug} is never its own "similar" entry`);
    assert.ok(p.similar.length <= 2, `${p.slug} has at most 2 similar entries`);
  }
}

// ---- (vii) coupon rows map to promos.json shape ---------------------------
{
  const couponRows = [
    { code: "TREND10", discount_type: "percentage", value: 10, max_discount: 30000, minimum_subtotal: 0 },
    { code: "FREESHIP", discount_type: "free_shipping", value: 0, max_discount: null, minimum_subtotal: 150000 },
  ];
  const { promos } = buildStoreFiles({ products, categories: { map: categoryOfSlug }, couponRows });
  assert.equal(promos.length, 2);
  const trend10 = promos.find((p) => p.code === "TREND10");
  assert.equal(trend10.kind, "percent");
  assert.equal(trend10.value, 10);
  assert.equal(trend10.max_discount_taka, 300);
  const freeship = promos.find((p) => p.code === "FREESHIP");
  assert.equal(freeship.min_cart, 1500);
  assert.equal(freeship.free_shipping, true);
}

// ---- (viii) no coupon rows (DB unreachable) -> hardcoded fallback ---------
{
  const { promos } = buildStoreFiles({ products, categories: { map: categoryOfSlug }, couponRows: null });
  const codes = promos.map((p) => p.code).sort();
  assert.deepEqual(codes, ["FREESHIP", "TREND10"]);
}

console.log("import-store.test.js: all assertions passed");
