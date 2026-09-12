#!/usr/bin/env node
// import-store.mjs — pull a real merchant's catalog/promos/policies from
// their public storefront API into server/store/<site>/*.json, in the
// exact shape server/store/index.js (loadStore/computeOffers) expects. See
// server/store/README.md "Multiple stores" and docs/ACME.md "Store
// import".
//
// Usage:
//   node server/scripts/import-store.mjs --site acme --api http://localhost:8081 [--out server/store/acme]
//
// Flags:
//   --site   required. Site key — also the default --out subdirectory name.
//   --api    required. Base URL of the storefront's public REST API
//            (GET /v1/products, /v1/products/:slug, /v1/categories).
//   --out    optional. Output directory for catalog.json/promos.json/
//            policies.json. Default: server/store/<site>/.
//
// Idempotent: re-running overwrites the three JSON files with a fresh pull
// — safe to run repeatedly (e.g. on a cron) as the merchant's catalog
// changes. Prints product/category/promo counts on success.
//
// Money: the API returns prices in integer poisha (1 Taka = 100 poisha,
// see server/store/README.md's own `price` field, always whole Taka to
// match the default store's catalog.json). This script divides by 100 and
// rounds — sub-poisha precision never exists on this API, so rounding is a
// no-op in practice, just defensive.
//
// Promo codes: this API exposes no PUBLIC coupon-listing endpoint, so
// active coupons are read directly from the merchant's own Postgres
// `coupons` table via `psql` (best-effort — see fetchPromosFromDb below).
// If that fails for any reason (psql missing, DB unreachable, wrong
// credentials, table empty), the two coupons this store is known to run
// (TREND10, FREESHIP) are hardcoded as a fallback, and a warning is
// printed saying so — see README's "Known gaps" note on why FREESHIP
// (a free_shipping-type coupon) can't be perfectly represented in
// promos.json's percent/flat schema.

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res.json();
}

/** fetchAllProducts(apiBase) → full product list (paginated {total,page,limit,data}). */
async function fetchAllProducts(apiBase) {
  const limit = 100;
  let page = 1;
  const all = [];
  for (;;) {
    const url = `${apiBase}/v1/products?limit=${limit}&page=${page}`;
    const body = await fetchJson(url);
    all.push(...(body.data || []));
    const total = body.total ?? all.length;
    if (all.length >= total || (body.data || []).length === 0) break;
    page++;
  }
  return all;
}

async function fetchCategories(apiBase) {
  return fetchJson(`${apiBase}/v1/categories`);
}

/**
 * categoryMap(apiBase, categories) → Map<productSlug, categorySlug>. The
 * product list/detail endpoints don't carry a category field directly —
 * only `GET /v1/products?category_slug=X` filters BY category — so the
 * only way to learn each product's category is to fetch each category's
 * own product list and tag its members. One request per category (small,
 * fixed-size list on this API), not per product.
 */
async function categoryMap(apiBase, categories) {
  const map = new Map();
  for (const cat of categories) {
    const body = await fetchJson(`${apiBase}/v1/products?category_slug=${encodeURIComponent(cat.slug)}&limit=200`);
    for (const p of body.data || []) map.set(p.slug, cat.slug);
  }
  return map;
}

function poishaToTaka(poisha) {
  return Math.round((poisha ?? 0) / 100);
}

/**
 * uniqueSizes(variants) → string[] — distinct variant.size values, in
 * first-seen order, EXCLUDING the placeholder "One Size" (a product with
 * only "One Size" variants has nothing for a shopper to pick — same as the
 * default catalog's sizeless products (sizes: []), so size_help never
 * fires a pointless "pick a size" offer for a mug/cap that only ever has
 * one size).
 */
function uniqueSizes(variants) {
  const seen = new Set();
  const sizes = [];
  for (const v of variants || []) {
    const s = v.size;
    if (!s || s === "One Size" || seen.has(s)) continue;
    seen.add(s);
    sizes.push(s);
  }
  return sizes;
}

/**
 * toCatalogEntry(product, categorySlug, allSlugsByCategory) → catalog.json
 * entry, same field shape as server/store/catalog.json's existing entries
 * (see server/store/README.md): slug, name, price (Taka), sizes, category,
 * tags, similar, fit_notes. Plus two EXTRA informational fields
 * (in_stock/low_stock) that server/store/index.js doesn't currently read —
 * harmless, forward-looking, never forwarded into the compact business
 * block (server/state.js's `product` derivation only copies
 * {slug,name,price,sizes,fit_notes}), so they can't inflate per-decision
 * payload size (see server/sites.test.js size-budget note).
 */
function toCatalogEntry(product, categorySlug, similarBySlug) {
  const availability = product.availability || {};
  const stockTotal = availability.available_stock_total ?? 0;
  return {
    slug: product.slug,
    name: product.name,
    price: poishaToTaka(product.base_price),
    sizes: uniqueSizes(product.variants),
    category: categorySlug ?? null,
    tags: categorySlug ? [categorySlug] : [],
    similar: similarBySlug.get(product.slug) ?? [],
    fit_notes: null, // API has no fit-note field — omitted, never invented
    in_stock: Boolean(availability.available),
    low_stock: Boolean(availability.available) && stockTotal > 0 && stockTotal <= 5,
  };
}

/**
 * similarWithinCategory(productsBySlug, categoryOf) → Map<slug, slug[]> —
 * up to 2 OTHER products in the same category, in catalog order. This is a
 * generic within-category cross-sell default, not a merchant styling
 * decision (see catalog.json's own `similar` field doc — "a merchant
 * decision ... not a computed heuristic"). A real merchant can hand-edit
 * catalog.json after import to curate real style pairings; this is just a
 * reasonable non-empty starting point so similar_on_promo has candidates
 * to work with at all.
 */
function similarWithinCategory(products, categoryOf) {
  const bySlugCategory = new Map();
  for (const p of products) {
    const cat = categoryOf.get(p.slug) ?? null;
    if (!bySlugCategory.has(cat)) bySlugCategory.set(cat, []);
    bySlugCategory.get(cat).push(p.slug);
  }
  const result = new Map();
  for (const p of products) {
    const cat = categoryOf.get(p.slug) ?? null;
    const siblings = (bySlugCategory.get(cat) || []).filter((s) => s !== p.slug);
    result.set(p.slug, siblings.slice(0, 2));
  }
  return result;
}

/**
 * fetchPromosFromDb() → coupon rows from the merchant's own Postgres
 * `coupons` table, via `psql` — best-effort. Connection params match the
 * ones this store's operator gave us (localhost:5433, db/user
 * "acme"); the password comes from ACME_DB_PASSWORD (env) so
 * this script never hardcodes a credential. Returns [] (never throws) on
 * ANY failure — missing psql binary, unreachable DB, wrong password, empty
 * table — the caller falls back to hardcoded promos and prints why.
 */
function fetchPromosFromDb({ host = "localhost", port = "5433", user = "acme", db = "acme" } = {}) {
  const password = process.env.ACME_DB_PASSWORD;
  if (!password) return { rows: null, reason: "ACME_DB_PASSWORD not set" };
  const query =
    "select code, discount_type, value, max_discount, minimum_subtotal from coupons where active order by code;";
  const result = spawnSync(
    "psql",
    ["-h", host, "-p", String(port), "-U", user, "-d", db, "-t", "-A", "-F", "\t", "-c", query],
    { env: { ...process.env, PGPASSWORD: password }, encoding: "utf8", timeout: 5000 }
  );
  if (result.error || result.status !== 0) {
    return { rows: null, reason: result.error ? result.error.message : (result.stderr || "psql exited non-zero") };
  }
  const lines = result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { rows: null, reason: "coupons table returned no active rows" };
  const rows = lines.map((line) => {
    const [code, discount_type, value, max_discount, minimum_subtotal] = line.split("\t");
    return {
      code,
      discount_type,
      value: Number(value),
      max_discount: max_discount ? Number(max_discount) : null,
      minimum_subtotal: minimum_subtotal ? Number(minimum_subtotal) : 0,
    };
  });
  return { rows, reason: null };
}

/**
 * couponRowToPromo(row) → promos.json entry | null (null = a discount_type
 * this schema can't represent at all, dropped rather than guessed).
 *
 * Known gap: `free_shipping`-type coupons (e.g. FREESHIP) discount the
 * DELIVERY fee, not an item's price — promos.json's `kind` enum
 * ("percent"|"flat") only ever discounts item price (see
 * server/store/index.js's savingFor()). There is no shipping-fee-discount
 * kind today. Represented here as a `flat` promo with `value: 0` (i.e. an
 * inert placeholder that still carries the code/label/min_cart so the
 * card guard (server/policy.js) accepts an `apply_code` cta for it and the
 * shopper-facing label is accurate) — it will never appear in a
 * `missed_discount` offer's `saving` figure. See docs/ACME.md /
 * server/store/README.md for the same note.
 *
 * Also known gap: `percentage` coupons with a `max_discount` cap (e.g.
 * TREND10's ৳300 cap) — savingFor() computes an uncapped percentage; the
 * cap is carried through as an informational `max_discount_taka` field but
 * NOT enforced by computeOffers() today.
 */
function couponRowToPromo(row) {
  const minCartTaka = poishaToTaka(row.minimum_subtotal);
  if (row.discount_type === "percentage") {
    return {
      id: row.code.toLowerCase(),
      code: row.code,
      kind: "percent",
      value: row.value,
      applies: { slugs: "all" },
      min_cart: minCartTaka || null,
      starts_at: null,
      ends_at: null,
      ends_in_ms: null,
      label: `${row.value}% off with code ${row.code}${row.max_discount ? ` (up to ৳${poishaToTaka(row.max_discount)})` : ""}`,
      auto_apply: false,
      max_discount_taka: row.max_discount ? poishaToTaka(row.max_discount) : null,
    };
  }
  if (row.discount_type === "fixed") {
    return {
      id: row.code.toLowerCase(),
      code: row.code,
      kind: "flat",
      value: poishaToTaka(row.value),
      applies: { slugs: "all" },
      min_cart: minCartTaka || null,
      starts_at: null,
      ends_at: null,
      ends_in_ms: null,
      label: `৳${poishaToTaka(row.value)} off with code ${row.code}`,
      auto_apply: false,
    };
  }
  if (row.discount_type === "free_shipping") {
    return {
      id: row.code.toLowerCase(),
      code: row.code,
      kind: "flat",
      value: 0, // schema gap — see couponRowToPromo() doc above
      applies: { slugs: "all" },
      min_cart: minCartTaka || null,
      starts_at: null,
      ends_at: null,
      ends_in_ms: null,
      label: `Free delivery over ৳${minCartTaka} with code ${row.code}`,
      auto_apply: false,
      free_shipping: true, // informational; no code path reads this yet
    };
  }
  return null;
}

const FALLBACK_PROMOS = [
  {
    id: "trend10",
    code: "TREND10",
    kind: "percent",
    value: 10,
    applies: { slugs: "all" },
    min_cart: null,
    starts_at: null,
    ends_at: null,
    ends_in_ms: null,
    label: "10% off with code TREND10 (up to ৳300)",
    auto_apply: false,
    max_discount_taka: 300,
  },
  {
    id: "freeship",
    code: "FREESHIP",
    kind: "flat",
    value: 0,
    applies: { slugs: "all" },
    min_cart: 1500,
    starts_at: null,
    ends_at: null,
    ends_in_ms: null,
    label: "Free delivery over ৳1,500 with code FREESHIP",
    auto_apply: false,
    free_shipping: true,
  },
];

function buildPolicies() {
  return {
    currency: "BDT",
    delivery: {
      free_over: 1500, // matches FREESHIP's coupon threshold (see README "Known gaps")
      city: "Dhaka",
      days: "2-4",
      fee: 80, // inside Dhaka
      fee_outside_dhaka: 130,
    },
    returns: {
      window_days: 7,
      note: "Unworn items, tags attached, within 7 days of delivery.",
    },
    payment: ["bKash", "COD", "card"],
    support: { hours: "10am-7pm, Sat-Thu", contact: "support@acme.example" },
    size_guide: {
      note: "No size-chart data available from the API — point the shopper to the merchant's size-guide modal instead of quoting numeric measurements.",
    },
  };
}

/**
 * writeStoreFiles(outDir, {catalog, promos, policies}) → writes the three
 * JSON files server/store/index.js's loadStore() expects, in the exact
 * shape server/store/README.md documents. Shared by every import script
 * (this file's `--api` mode and import-nextcart.mjs's Mongo mode) so the
 * on-disk shape/formatting (2-space indent, trailing newline, filenames)
 * can never drift between sources.
 */
export function writeStoreFiles(outDir, { catalog, promos, policies }) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  writeFileSync(path.join(outDir, "promos.json"), JSON.stringify(promos, null, 2) + "\n");
  writeFileSync(path.join(outDir, "policies.json"), JSON.stringify(policies, null, 2) + "\n");
}

/** buildStoreFiles({products, categories}) → {catalog, promos, policies} — pure, unit-testable (see import-store.test.js). */
export function buildStoreFiles({ products, categories, couponRows }) {
  const catMap = new Map(); // slug -> category slug, from category-filtered listings
  for (const cat of categories.map) catMap.set(cat.slug, cat.category);

  const categoryOf = categories.map; // Map<productSlug, categorySlug> — see categoryMap()
  const similarBySlug = similarWithinCategory(products, categoryOf);

  const catalog = products.map((p) => toCatalogEntry(p, categoryOf.get(p.slug) ?? null, similarBySlug));

  let promos;
  if (Array.isArray(couponRows) && couponRows.length > 0) {
    promos = couponRows.map(couponRowToPromo).filter(Boolean);
  } else {
    promos = FALLBACK_PROMOS;
  }

  const policies = buildPolicies();
  return { catalog, promos, policies };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const site = args.site;
  const apiBase = args.api ? String(args.api).replace(/\/+$/, "") : null;
  if (!site || !apiBase) {
    console.error("Usage: node server/scripts/import-store.mjs --site <name> --api <http://host:port> [--out <dir>]");
    process.exit(1);
  }
  const outDir = args.out ? path.resolve(args.out) : path.join(REPO_SERVER_DIR, "store", site);

  console.log(`[import-store] site=${site} api=${apiBase} out=${outDir}`);

  const [products, categories] = await Promise.all([fetchAllProducts(apiBase), fetchCategories(apiBase)]);
  const catSlugMap = await categoryMap(apiBase, categories);

  let couponRows = null;
  const db = fetchPromosFromDb();
  if (db.rows) {
    couponRows = db.rows;
  } else {
    console.warn(`[import-store] could not read coupons from DB (${db.reason}) — falling back to hardcoded TREND10/FREESHIP promos`);
  }

  const { catalog, promos, policies } = buildStoreFiles({
    products,
    categories: { map: catSlugMap },
    couponRows,
  });

  writeStoreFiles(outDir, { catalog, promos, policies });

  console.log(
    `[import-store] wrote ${catalog.length} products, ${categories.length} categories, ${promos.length} promos to ${outDir}`
  );
}

// Only run main() when executed directly (not when imported by
// import-store.test.js for buildStoreFiles()'s pure unit test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[import-store] failed: ${err.message}`);
    process.exit(1);
  });
}
