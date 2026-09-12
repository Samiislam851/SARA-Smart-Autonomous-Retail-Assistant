// import-nextcart.test.js — pure unit test of buildStoreFiles() against a
// saved sample of real NextCart product documents
// (__fixtures__/nextcart-products.json, captured 2026-09-12 straight from
// `mongodb://localhost:27017/nextcart`'s `products` collection — six
// products picked to cover: a size+colour product, a colour-only product,
// a no-variant product, an inactive+low-stock product, and two more
// products sharing a category with the size+colour one). No network, no
// live Mongo required — see import-nextcart.mjs's own module comment for
// what the real script does end to end.
//
// Run: node --test server/scripts/import-nextcart.test.js

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildStoreFiles } from "./import-nextcart.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(__dirname, "__fixtures__", "nextcart-products.json"), "utf8")
);
const allProducts = fixture.products;
const activeProducts = allProducts.filter((p) => p.isActive);

test("every active product in the fixture becomes a catalog entry", () => {
  const { catalog } = buildStoreFiles({ products: activeProducts });
  assert.equal(catalog.length, activeProducts.length);
});

test("price is converted integer cents -> decimal dollars without float drift", () => {
  const { catalog } = buildStoreFiles({ products: activeProducts });
  const runner = catalog.find((p) => p.slug === "cascade-co-runner");
  assert.ok(runner, "cascade-co-runner present in fixture");
  const raw = activeProducts.find((p) => p.slug === "cascade-co-runner");
  assert.equal(raw.price, 6799);
  assert.equal(runner.price, 67.99);
});

test("size variants: distinct labels, colour variants excluded", () => {
  const { catalog } = buildStoreFiles({ products: activeProducts });
  const runner = catalog.find((p) => p.slug === "cascade-co-runner");
  assert.deepEqual(runner.sizes, ["US 7", "US 8", "US 9", "US 10", "US 11", "US 12"]);
});

test("colour-only product gets an empty sizes array", () => {
  const { catalog } = buildStoreFiles({ products: activeProducts });
  const earbuds = catalog.find((p) => p.slug === "wavecrest-noise-isolating-wireless-earbuds-2-0");
  assert.ok(earbuds);
  assert.deepEqual(earbuds.sizes, []);
});

test("no-variant product gets an empty sizes array too", () => {
  const { catalog } = buildStoreFiles({ products: activeProducts });
  const player = catalog.find((p) => p.slug === "sonique-hdr-streaming-media-player");
  assert.ok(player);
  assert.deepEqual(player.sizes, []);
});

test("category/tags come straight from the product's own categorySlug field", () => {
  const { catalog } = buildStoreFiles({ products: activeProducts });
  const runner = catalog.find((p) => p.slug === "cascade-co-runner");
  assert.equal(runner.category, "clothing-shoes");
  assert.deepEqual(runner.tags, ["clothing-shoes"]);
});

test("similar cross-sells stay within the same category and exclude self", () => {
  const { catalog } = buildStoreFiles({ products: activeProducts });
  const runner = catalog.find((p) => p.slug === "cascade-co-runner");
  assert.ok(!runner.similar.includes("cascade-co-runner"));
  for (const slug of runner.similar) {
    const other = catalog.find((p) => p.slug === slug);
    assert.equal(other.category, "clothing-shoes");
  }
});

test("in_stock/low_stock derive from stock + isActive", () => {
  const { catalog } = buildStoreFiles({ products: activeProducts });
  const boot = catalog.find((p) => p.slug === "summit-trail-insulated-trailblazer-boot");
  assert.equal(boot.in_stock, true);
  assert.equal(boot.low_stock, false);
});

test("an inactive product is excluded entirely (caller filters before buildStoreFiles)", () => {
  const inactiveRaw = allProducts.find((p) => p.slug === "nexbeam-slim-portable-power-bank-se");
  assert.ok(inactiveRaw, "fixture includes the inactive product");
  assert.equal(inactiveRaw.isActive, false);
  const { catalog } = buildStoreFiles({ products: activeProducts });
  assert.ok(!catalog.some((p) => p.slug === "nexbeam-slim-portable-power-bank-se"));
});

test("promos.json is an empty array — NextCart has no coupon system", () => {
  const { promos } = buildStoreFiles({ products: activeProducts });
  assert.deepEqual(promos, []);
});

test("policies.json carries the real checkout numbers, not the marketing-copy policy page's vague ones", () => {
  const { policies } = buildStoreFiles({ products: activeProducts });
  assert.equal(policies.currency, "USD");
  assert.equal(policies.delivery.free_over, 0);
  assert.equal(policies.delivery.fee, 0);
  assert.equal(policies.delivery.express_fee, 9.99);
  assert.equal(policies.returns.window_days, 30);
  assert.deepEqual(policies.payment, ["COD"]);
});

test("fit_notes is always null — NextCart's product schema has no such field", () => {
  const { catalog } = buildStoreFiles({ products: activeProducts });
  assert.ok(catalog.every((p) => p.fit_notes === null));
});
