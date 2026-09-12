#!/usr/bin/env node
// import-nextcart.mjs — pull NextCart's catalog straight from its MongoDB
// (no public REST API to hit — see docs/NEXTCART.md), into
// server/store/nextcart/*.json, in the exact shape server/store/index.js
// (loadStore/computeOffers) expects. Sibling to import-store.mjs (which
// pulls Acme over HTTP) rather than a `--source mongo` mode on that
// file — different transport (mongodb driver vs fetch), different product
// shape (variants mix size+colour in one array, category is a direct field
// not a per-category listing you have to reconstruct), different money
// units (USD cents vs Taka, no coupon system at all) made one shared
// `buildStoreFiles()` awkward to keep honest. Shares only the actual
// on-disk writer, `writeStoreFiles()` (see import-store.mjs).
//
// Usage:
//   node server/scripts/import-nextcart.mjs --uri mongodb://localhost:27017/nextcart --db nextcart [--out server/store/nextcart]
//
// Flags:
//   --uri  optional. Mongo connection string. Default: mongodb://localhost:27017/nextcart
//   --db   optional. Database name. Default: nextcart
//   --out  optional. Output directory. Default: server/store/nextcart/
//
// Idempotent: re-running overwrites the three JSON files with a fresh read
// — safe to run repeatedly as the seed/catalog changes.
//
// Money: NextCart stores every price as an integer count of the currency's
// minor unit (cents for USD — see personal-nextcart/src/lib/format.ts's
// minorUnitExponent(), always 2 for USD, the only currency this store's
// seed data uses). This script converts to a decimal major-unit number
// (e.g. 5399 -> 53.99) since server/store/catalog.json's `price` field is
// quoted directly to shoppers as a plain number (see the default store's
// Taka prices, which happen to have 0 decimals) — never done via float
// multiplication, only by string-slicing the integer the same way
// personal-nextcart's own lib/money.ts avoids drift.
//
// Promos: NextCart originally had NO coupon/discount system (see git
// history of this comment) — that changed with "Feature A (promo codes)",
// a `promoCodes` Mongo collection + cart-page apply/remove UI (see
// personal-nextcart/src/lib/schemas/promoCode.ts,
// src/lib/db/repositories/promoCodes.ts). This importer now reads that
// collection and maps each ACTIVE, non-expired code into this store's
// promos.json shape (server/store/promos.json's own shape, see the
// default store's file for the field list): `type: "percent"` ->
// `kind: "percent"`, `type: "fixed"` -> `kind: "flat"` (value converted
// from minor units to major units the same way toCatalogEntry() does for
// prices); NextCart's schema has no per-product/category scoping field on
// a promo code, so every imported code gets `applies: {slugs: "all"}`
// (accurate: it really does apply store-wide) and `auto_apply: false`
// (NextCart has no auto-apply concept — a shopper always types the code
// in). `minSubtotal` (minor units) -> `min_cart` (major units), 0 mapped
// to `null` (no minimum) to match this store's own convention (see
// server/store/promos.json's entries). An inactive or expired code is
// dropped entirely — quoting an offer the checkout would reject is worse
// than quoting none. If the collection is empty (fresh seed, nothing
// created via the admin UI), promos.json is `[]`, same as before this
// feature existed — server/store/index.js and server/gate.js already
// treat an empty promos list as "no active promos" correctly.
//
// Policies: shipping/returns copy comes from
// personal-nextcart/src/app/policies/[slug]/page.tsx (marketing copy, no
// hard numbers for delivery days/fees) and the ACTUAL numbers enforced at
// checkout, personal-nextcart/src/lib/checkout/delivery.ts's
// DELIVERY_OPTIONS (standard: $0/free, 5-7 business days; express: $9.99,
// 1-2 business days) — the checkout module is the source of truth for any
// number quoted to a shopper, the policy page is marketing prose only.
// Returns: 30-day window (schemas/order.ts + the policy page agree).
// Payment: paymentMethodSchema is a bare z.literal("cod") — cash on
// delivery is the only payment method this store supports, no card/wallet
// options exist anywhere in the schema or checkout UI.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { writeStoreFiles } from "./import-store.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_SERVER_DIR = path.resolve(__dirname, ".."); // server/

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

/**
 * NextCart's minor-unit exponent table (mirrors personal-nextcart's
 * src/lib/format.ts's MINOR_UNIT_EXPONENT — this store's seed data is
 * 100% USD today, but the conversion is written generically rather than
 * hardcoding /100 in case a future import ever sees a different currency).
 */
const MINOR_UNIT_EXPONENT = { JPY: 0, KRW: 0, VND: 0, BHD: 3, KWD: 3, OMR: 3 };
function minorUnitExponent(currency) {
  return MINOR_UNIT_EXPONENT[String(currency || "").toUpperCase()] ?? 2;
}

/**
 * minorUnitsToMajor(amount, currency) → decimal major-unit number, built
 * from the integer's digits (never `amount / 10 ** exponent` as a plain
 * float division of an already-huge integer risks the same class of
 * drift `lib/money.ts` guards against on the NextCart side) — pads/slices
 * the digit string, then a single Number() parse of a short exact decimal
 * literal, which IEEE-754 represents exactly for every value this store's
 * prices can take (<= a few thousand dollars).
 */
function minorUnitsToMajor(amountMinorUnits, currency) {
  const exponent = minorUnitExponent(currency);
  const amount = Math.round(Number(amountMinorUnits) || 0);
  if (exponent === 0) return amount;
  const digits = String(Math.abs(amount)).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const frac = digits.slice(digits.length - exponent);
  const value = Number(`${whole}.${frac}`);
  return amount < 0 ? -value : value;
}

/**
 * uniqueSizes(variants) → string[] — distinct "size"-type variant labels
 * (e.g. "US 7", "M"), in first-seen order. Unlike Acme's synthetic
 * "One Size" placeholder, NextCart simply omits the size variant type
 * entirely for products with no size to pick (bags, mugs, electronics) —
 * so no placeholder-filtering is needed here, only type-filtering +
 * dedupe (BUILD-DECISIONS.md §3: (type, value) pairs are already unique
 * per product by schema, but label is what's shopper-facing/quotable).
 */
function uniqueSizes(variants) {
  const seen = new Set();
  const sizes = [];
  for (const v of variants || []) {
    if (v.type !== "size") continue;
    if (seen.has(v.value)) continue;
    seen.add(v.value);
    sizes.push(v.label);
  }
  return sizes;
}

/**
 * toCatalogEntry(product) → catalog.json entry, same field shape as
 * server/store/catalog.json's existing entries (see server/store/
 * README.md): slug, name, price, sizes, category, tags, similar,
 * fit_notes. Plus the same two extra informational fields import-
 * store.mjs's Acme entries carry (in_stock/low_stock) — harmless,
 * never forwarded into the compact business block (server/state.js's
 * `product` derivation only copies {slug,name,price,sizes,fit_notes}).
 */
function toCatalogEntry(product, similarBySlug) {
  const stock = Number(product.stock) || 0;
  return {
    slug: product.slug,
    name: product.title,
    price: minorUnitsToMajor(product.price, product.currency),
    sizes: uniqueSizes(product.variants),
    category: product.categorySlug ?? null,
    tags: product.categorySlug ? [product.categorySlug] : [],
    similar: similarBySlug.get(product.slug) ?? [],
    fit_notes: null, // NextCart's product schema has no fit-note field — omitted, never invented
    in_stock: Boolean(product.isActive) && stock > 0,
    low_stock: Boolean(product.isActive) && stock > 0 && stock <= 5,
    // "Undecided comparer" brief (2026-09-12): NextCart's productSchema has
    // no structured attributes/specs/features/material field (see
    // personal-nextcart src/lib/schemas/product.ts) — only these. Imported
    // so server/store/index.js's specDiff() has real fields to diff between
    // two same-category products instead of nothing at all.
    brand: product.brand ?? null,
    rating: typeof product.rating === "number" ? product.rating : null,
    review_count: Number.isFinite(product.reviewCount) ? product.reviewCount : null,
  };
}

/**
 * similarWithinCategory(products) → Map<slug, slug[]> — up to 2 OTHER
 * active products in the same category, in catalog order. Same generic
 * cross-sell default as import-store.mjs's Acme version (see that
 * file's own doc comment for why this is a starting point, not a merchant
 * styling decision) — a real merchant hand-edits catalog.json afterward.
 */
function similarWithinCategory(products) {
  const byCategory = new Map();
  for (const p of products) {
    const cat = p.categorySlug ?? null;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(p.slug);
  }
  const result = new Map();
  for (const p of products) {
    const cat = p.categorySlug ?? null;
    const siblings = (byCategory.get(cat) || []).filter((s) => s !== p.slug);
    result.set(p.slug, siblings.slice(0, 2));
  }
  return result;
}

/**
 * buildPolicies() → policies.json shape — see this file's own header
 * comment for exactly where every number below comes from
 * (personal-nextcart's src/lib/checkout/delivery.ts and
 * src/lib/schemas/order.ts, never the marketing-copy policy page).
 */
function buildPolicies() {
  return {
    currency: "USD",
    delivery: {
      // Standard shipping is $0 on every order, no cart-total threshold —
      // "free_over: 0" accurately says "free starting at $0", i.e. always
      // free, rather than inventing a spend threshold this store doesn't
      // have. Express is a flat $9.99 upgrade, also with no threshold.
      free_over: 0,
      days: "5-7",
      fee: 0,
      express_fee: 9.99,
      express_days: "1-2",
    },
    returns: {
      window_days: 30,
      note: "Unused items, in original packaging, within 30 days of delivery.",
    },
    payment: ["COD"], // paymentMethodSchema is a bare z.literal("cod") — the only method this store supports
    support: null, // no support hours/contact email exist anywhere in this codebase — never invented
  };
}

/**
 * isPromoActive(promo, now) → whether this code should be quoted to a
 * shopper right now: `isActive` must be true AND (no `expiresAt`, or
 * `expiresAt` is still in the future). Does NOT check `maxUses`/
 * `usedCount` — that's a per-cart-attempt check the checkout makes, not
 * something this store-context file should try to second-guess.
 */
function isPromoActive(promo, now) {
  if (!promo.isActive) return false;
  if (!promo.expiresAt) return true;
  const expires = new Date(promo.expiresAt).getTime();
  return Number.isNaN(expires) || expires > now;
}

/**
 * toPromoEntry(promo) → server/store/promos.json shape (see this file's
 * own header comment "Promos:" section for the field-mapping rationale).
 */
function toPromoEntry(promo) {
  const isFixed = promo.type === "fixed";
  return {
    id: String(promo._id),
    code: promo.code,
    kind: isFixed ? "flat" : "percent",
    value: isFixed ? minorUnitsToMajor(promo.value, "USD") : promo.value,
    applies: { slugs: "all" },
    min_cart: promo.minSubtotal ? minorUnitsToMajor(promo.minSubtotal, "USD") : null,
    starts_at: null,
    ends_at: promo.expiresAt ?? null,
    ends_in_ms: null,
    label: isFixed
      ? `$${minorUnitsToMajor(promo.value, "USD")} off with code ${promo.code}`
      : `${promo.value}% off with code ${promo.code}`,
    auto_apply: false,
  };
}

/**
 * buildStoreFiles({products, promoCodes}) → {catalog, promos, policies} —
 * pure, unit-testable (see import-nextcart.test.js). `promoCodes` is
 * optional (defaults to `[]`, same as before "Feature A (promo codes)"
 * existed) — raw documents from the `promoCodes` Mongo collection, active
 * ones mapped to this store's promo shape via toPromoEntry(), inactive/
 * expired ones dropped.
 */
export function buildStoreFiles({ products, promoCodes = [] }) {
  const similarBySlug = similarWithinCategory(products);
  const catalog = products.map((p) => toCatalogEntry(p, similarBySlug));
  const now = Date.now();
  const promos = promoCodes.filter((p) => isPromoActive(p, now)).map(toPromoEntry);
  return { catalog, promos, policies: buildPolicies() };
}

async function fetchAllProducts(uri, dbName) {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    return await db.collection("products").find({}).toArray();
  } finally {
    await client.close();
  }
}

async function fetchAllPromoCodes(uri, dbName) {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db(dbName);
    return await db.collection("promoCodes").find({}).toArray();
  } finally {
    await client.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const uri = args.uri ? String(args.uri) : "mongodb://localhost:27017/nextcart";
  const dbName = args.db ? String(args.db) : "nextcart";
  const outDir = args.out ? path.resolve(args.out) : path.join(REPO_SERVER_DIR, "store", "nextcart");

  console.log(`[import-nextcart] uri=${uri} db=${dbName} out=${outDir}`);

  const [products, promoCodes] = await Promise.all([
    fetchAllProducts(uri, dbName),
    fetchAllPromoCodes(uri, dbName),
  ]);
  const activeProducts = products.filter((p) => p.isActive);
  const inactiveCount = products.length - activeProducts.length;

  const { catalog, promos, policies } = buildStoreFiles({ products: activeProducts, promoCodes });

  writeStoreFiles(outDir, { catalog, promos, policies });

  console.log(
    `[import-nextcart] wrote ${catalog.length} products (${inactiveCount} inactive products skipped), ` +
      `${promos.length} promos (of ${promoCodes.length} promoCodes documents; inactive/expired dropped) to ${outDir}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[import-nextcart] failed: ${err.message}`);
    process.exit(1);
  });
}
