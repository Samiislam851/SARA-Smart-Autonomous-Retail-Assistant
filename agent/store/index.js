// Store-knowledge layer — the merchant's business, as files. See
// server/store/README.md for the merchant-facing explanation.
//
// This module is the ONLY place that reads catalog.json / promos.json /
// policies.json and the only place that turns them (+ live session state)
// into `offers` facts. It never talks to the LLM directly — server/state.js
// wires its output into buildState(), and prompts/decide.md tells the model
// how to use it. Keep this file pure/side-effect-free except for the file
// reads themselves (mtime-checked, so a merchant edit is picked up on the
// next read with no server restart).

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveSiteDir } from "./sites.js";
import { CART_GAP_PCT } from "../gate.js";

// Fixed at module load — the reference point for any promo's `ends_in_ms`
// fallback (see promos.json / README.md: "ends_in_ms counts from server
// start, not from when the promo file was written or read"). Captured once
// so re-reading the files on every request (hot reload) never shifts a
// promo's effective end time.
const SERVER_START = Date.now();

const FREE_DELIVERY_THRESHOLD_FALLBACK = 2000; // matches gate.js's own fallback, used only if policies.json is entirely missing

function freshCache() {
  return {
    catalog: null,
    promos: null,
    policies: null,
    catalogMtimeMs: null,
    promosMtimeMs: null,
    policiesMtimeMs: null,
    loadedAt: null, // ms epoch of the last successful (re)load of ANY file
    catalogLoadedAt: null, // ms epoch of the last successful (re)load of catalog.json specifically
    promosLoadedAt: null, // ditto, promos.json
    policiesLoadedAt: null, // ditto, policies.json — surfaced on /health (server/health.js)
    ok: false,
  };
}

// One cache entry per resolved site key (see server/store/sites.js) — each
// site's catalog/promos/policies.json is read/mtime-checked/hot-reloaded
// independently, so editing Acme's promos.json can never invalidate
// or race the default store's cache (or vice versa). Keyed by the
// NORMALIZED site (resolveSiteDir()'s `.site`), so an unknown site name and
// an explicit "default" share the same cache entry.
const cachesBySite = new Map();

function cacheFor(site) {
  const { dir, site: resolvedSite } = resolveSiteDir(site);
  if (!cachesBySite.has(resolvedSite)) cachesBySite.set(resolvedSite, freshCache());
  return {
    cache: cachesBySite.get(resolvedSite),
    site: resolvedSite,
    CATALOG_PATH: path.join(dir, "catalog.json"),
    PROMOS_PATH: path.join(dir, "promos.json"),
    POLICIES_PATH: path.join(dir, "policies.json"),
  };
}

function readJsonIfChanged(filePath, prevMtimeMs) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return { changed: false, missing: true, mtimeMs: null, data: null };
  }
  if (stat.mtimeMs === prevMtimeMs) {
    return { changed: false, missing: false, mtimeMs: prevMtimeMs, data: undefined };
  }
  const data = JSON.parse(readFileSync(filePath, "utf8"));
  return { changed: true, missing: false, mtimeMs: stat.mtimeMs, data };
}

/**
 * loadStore(site?) → { catalog, promos, policies, loadedAt, ok, site } | null
 * `site` (optional): merchant/store key (see server/store/sites.js) —
 * absent/""/"default" reads server/store/*.json exactly as before
 * multi-site support existed; any other name reads
 * server/store/<site>/{catalog,promos,policies}.json, hot-reloaded and
 * cached independently per site. An unrecognized site name falls back to
 * the default store (one console.warn per unknown name, not per call).
 * `ok: false` (catalog/promos/policies still whatever was last loaded, or
 * empty arrays/null on a cold start) means at least one file is missing or
 * failed to parse — logged once per failure, never thrown, so a merchant
 * typo in promos.json degrades to "no offers" instead of crashing the
 * server. Re-reads each file only when its mtime changed since the last
 * call (hot reload without a restart, cheap on the common case of "nothing
 * changed").
 */
export function loadStore(site) {
  const { cache, site: resolvedSite, CATALOG_PATH, PROMOS_PATH, POLICIES_PATH } = cacheFor(site);
  let anyError = null;

  try {
    const c = readJsonIfChanged(CATALOG_PATH, cache.catalogMtimeMs);
    if (c.missing) {
      cache.catalog = [];
    } else if (c.changed) {
      cache.catalog = Array.isArray(c.data) ? c.data : [];
      cache.catalogMtimeMs = c.mtimeMs;
      cache.catalogLoadedAt = Date.now();
      cache.loadedAt = cache.catalogLoadedAt;
    }
  } catch (err) {
    anyError = err;
    console.warn(`[store] failed to load catalog.json: ${err.message}`);
  }

  try {
    const p = readJsonIfChanged(PROMOS_PATH, cache.promosMtimeMs);
    if (p.missing) {
      cache.promos = [];
    } else if (p.changed) {
      cache.promos = Array.isArray(p.data) ? p.data : [];
      cache.promosMtimeMs = p.mtimeMs;
      cache.promosLoadedAt = Date.now();
      cache.loadedAt = cache.promosLoadedAt;
    }
  } catch (err) {
    anyError = err;
    console.warn(`[store] failed to load promos.json: ${err.message}`);
  }

  try {
    const pol = readJsonIfChanged(POLICIES_PATH, cache.policiesMtimeMs);
    if (pol.missing) {
      cache.policies = null;
    } else if (pol.changed) {
      cache.policies = pol.data && typeof pol.data === "object" ? pol.data : null;
      cache.policiesMtimeMs = pol.mtimeMs;
      cache.policiesLoadedAt = Date.now();
      cache.loadedAt = cache.policiesLoadedAt;
    }
  } catch (err) {
    anyError = err;
    console.warn(`[store] failed to load policies.json: ${err.message}`);
  }

  cache.ok = !anyError;

  return {
    catalog: cache.catalog ?? [],
    promos: cache.promos ?? [],
    policies: cache.policies ?? null,
    loadedAt: cache.loadedAt,
    catalogLoadedAt: cache.catalogLoadedAt,
    promosLoadedAt: cache.promosLoadedAt,
    policiesLoadedAt: cache.policiesLoadedAt,
    ok: cache.ok,
    site: resolvedSite,
  };
}

/** storeStatus(site?) → summary for /health (server/health.js), no file re-read side effect beyond loadStore()'s own mtime check. */
export function storeStatus(site) {
  const store = loadStore(site);
  const now = Date.now();
  return {
    promos: store.promos.length,
    active: activePromos(store, now).length,
    catalog: store.catalog.length,
    policiesLoaded: Boolean(store.policies),
    loadedAt: store.loadedAt,
    policiesLoadedAt: store.policiesLoadedAt,
    ok: store.ok,
  };
}

function catalogBySlug(store) {
  const map = new Map();
  for (const p of store.catalog) map.set(p.slug, p);
  return map;
}

/**
 * effectiveWindow(promo) → { startsAt, endsAt } in epoch ms.
 * - starts_at: ISO string → that instant; absent → -Infinity (always started).
 * - ends_at: ISO string → that instant, takes priority.
 * - else ends_in_ms (number): SERVER_START + ends_in_ms (see promos.json /
 *   README.md — a static JSON file can't carry a relative "48 hours from
 *   whenever a demo happens to run", so this is the documented fallback).
 * - else (both absent): Infinity (never expires, e.g. an evergreen auto-apply promo).
 */
function effectiveWindow(promo) {
  const startsAt = promo.starts_at ? Date.parse(promo.starts_at) : -Infinity;
  let endsAt;
  if (promo.ends_at) {
    endsAt = Date.parse(promo.ends_at);
  } else if (typeof promo.ends_in_ms === "number") {
    endsAt = SERVER_START + promo.ends_in_ms;
  } else {
    endsAt = Infinity;
  }
  return { startsAt, endsAt };
}

function isActive(promo, now) {
  const { startsAt, endsAt } = effectiveWindow(promo);
  return now >= startsAt && now <= endsAt;
}

function appliesToSlug(promo, slug, catalogMap) {
  const applies = promo.applies || {};
  if (applies.slugs === "all") return true;
  if (Array.isArray(applies.slugs) && applies.slugs.includes(slug)) return true;
  if (Array.isArray(applies.categories)) {
    const product = catalogMap.get(slug);
    if (product && applies.categories.includes(product.category)) return true;
  }
  return false;
}

/** activePromos(store, now) → promos currently within their start/end window. */
export function activePromos(store, now = Date.now()) {
  return (store.promos || []).filter((p) => isActive(p, now));
}

/** promosFor(store, slug, now) → active promos that apply to `slug`. */
export function promosFor(store, slug, now = Date.now()) {
  const catalogMap = catalogBySlug(store);
  return activePromos(store, now).filter((p) => appliesToSlug(p, slug, catalogMap));
}

function minCartMet(promo, cart) {
  if (promo.min_cart == null) return true;
  return (cart?.total ?? 0) >= promo.min_cart;
}

function savingFor(promo, price, qty = 1) {
  const subtotal = price * qty;
  if (promo.kind === "percent") return Math.round(subtotal * (promo.value / 100));
  if (promo.kind === "flat") return Math.min(promo.value, subtotal);
  return 0;
}

function endsInMin(promo, now) {
  const { endsAt } = effectiveWindow(promo);
  if (!Number.isFinite(endsAt)) return null;
  return Math.max(0, Math.round((endsAt - now) / 60000));
}

// Per-site route prefixes — category fix (live finding, NextCart session
// final_nc_1219732343): a THIRD site's product route is `/p/<slug>` (the
// default store uses `/product/<slug>`, Acme `/products/<slug>`) —
// hardcoding two regex shapes as "the" product route pattern silently
// failed on the third, leaving `product` null, `distinctProducts`/
// `returnsToSameProduct` stuck at 0, and (via the same hardcoded-path
// defect class) `checkoutReached` false despite real `/checkout/address`
// visits (NextCart's checkout is a sub-route, not the bare `/checkout` the
// default/Acme stores use). Fixed as a per-site config instead of a
// bigger regex: a site's own `policies.json` may declare `routes: {product,
// cart, checkout, search}` (each an array of path PREFIXES — checked with
// `path.startsWith(prefix)`, so `/checkout/address` matches a `/checkout`
// prefix); any key a site omits (or an old policies.json that predates this
// field) falls back to DEFAULT_ROUTES for just that key. This is the single
// place route prefixes are defined — every path classification in this
// module and server/state.js reads through getRoutes()/classifyPath()/
// productSlugFromPage() below, never a fresh hardcoded literal. (server/
// gate.js has its OWN separate hardcoded copies of this same classification
// — out of this fix's edit boundary, see server/state.js's ownership note;
// flagged as a follow-up for gate.js's owner in server/NOTES.md.)
export const DEFAULT_ROUTES = {
  product: ["/product/", "/products/", "/p/"],
  cart: ["/cart"],
  checkout: ["/checkout"],
  search: ["/search"],
};

/**
 * getRoutes(store) -> { product, cart, checkout, search } (each string[]).
 * `store` may be omitted/partial/malformed — any key without a valid
 * non-empty array of strings in `store.policies.routes` falls back to
 * DEFAULT_ROUTES for that key alone (fail open to the union of all known
 * site shapes, never throw on a missing/old policies.json).
 */
export function getRoutes(store) {
  const custom = store?.policies?.routes;
  const routes = {};
  for (const key of Object.keys(DEFAULT_ROUTES)) {
    const arr = custom && Array.isArray(custom[key]) && custom[key].length && custom[key].every((s) => typeof s === "string" && s)
      ? custom[key]
      : DEFAULT_ROUTES[key];
    routes[key] = arr;
  }
  return routes;
}

function matchesRoute(path, prefixes) {
  return typeof path === "string" && path.length > 0 && prefixes.some((p) => path.startsWith(p));
}

/**
 * classifyPath(path, store) -> "cart" | "checkout" | "product" | "search" |
 * "other" — the single source of truth server/state.js's own buildPatterns/
 * buildJourney read through instead of a hardcoded `=== "/cart"` literal.
 * Checked in this order (cart/checkout/search first) so a product-route
 * prefix that happens to overlap a cart/checkout prefix on some future site
 * config still resolves predictably.
 */
export function classifyPath(path, store) {
  const routes = getRoutes(store);
  if (matchesRoute(path, routes.cart)) return "cart";
  if (matchesRoute(path, routes.checkout)) return "checkout";
  if (matchesRoute(path, routes.search)) return "search";
  if (matchesRoute(path, routes.product)) return "product";
  return "other";
}

// Exported: server/state.js (buildState()'s `product`) and server/policy.js
// don't have their own copy of this — one place decides what counts as "on
// a product page", so the two can't drift. `store` is optional (defaults to
// DEFAULT_ROUTES via getRoutes()) so existing call sites that predate the
// per-site routes config (server/stale.js's productSlugFromPage(page) with
// no store arg) keep working, covering the union of all known sites' shapes
// rather than losing product detection entirely.
export function productSlugFromPage(page, store) {
  if (typeof page !== "string" || !page) return null;
  const prefixes = getRoutes(store).product;
  for (const prefix of prefixes) {
    if (page.startsWith(prefix)) {
      const rest = page.slice(prefix.length);
      if (rest && !rest.includes("/")) return rest;
    }
  }
  return null;
}

/**
 * cheapestCatalogItemAtLeast(store, minPrice, now) → { slug, name, price,
 * promo: {code, label} | null } | null — the cheapest catalog product whose
 * price is >= minPrice (ties broken by catalog order), with its own best
 * active promo (if any) attached so a "add X and delivery is free" card can
 * also mention the discount already on X. Used by delivery_gap's `fill_with`
 * (server/store/README.md).
 */
function cheapestCatalogItemAtLeast(store, minPrice, now) {
  let best = null;
  for (const p of store.catalog || []) {
    if (p.price >= minPrice && (!best || p.price < best.price)) best = p;
  }
  if (!best) return null;
  const promos = promosFor(store, best.slug, now);
  const promo = promos[0] ? { code: promos[0].code ?? null, label: promos[0].label } : null;
  return { slug: best.slug, name: best.name, price: best.price, promo };
}

// ---- search_help — zero-result search candidate matching -----------------
// Category: zero-result search never yields a card (server/NOTES.md). The
// model has no candidate corrected query to act on, so it can only ever
// noop. This computes up to N real catalog matches (fuzzy: normalized token
// overlap + edit-distance similarity against product name/category/tags) so
// the prompt can offer a one-tap `cta.kind:"search"` correction instead of
// inventing one. Pure string matching — no side effects, safe to unit test.

function normalizeSearchText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(s) {
  const norm = normalizeSearchText(s);
  return norm ? norm.split(" ") : [];
}

// Standard Levenshtein edit distance, iterative DP — inputs are short
// (product names/tags/query tokens), so an O(n*m) table is plenty cheap.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

// tokenSimilarity(a, b) → 0..1. Exact match = 1; a short substring
// relationship (both >=3 chars) = 0.85 (catches plural/typo-prefix cases
// like "sari"/"saree" partially, "scarf"/"scarves"); otherwise a normalized
// edit-distance ratio.
function tokenSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a))) return 0.85;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length) || 1;
  return Math.max(0, 1 - dist / maxLen);
}

// queryMatchScore(queryTokens, targetTokens) → 0..1, the average of each
// query token's BEST similarity against any target token. A query with a
// token that matches nothing in the target drags the average down, so
// irrelevant extra words in the query don't inflate a weak match.
function queryMatchScore(queryTokens, targetTokens) {
  if (queryTokens.length === 0 || targetTokens.length === 0) return 0;
  let total = 0;
  for (const qt of queryTokens) {
    let best = 0;
    for (const tt of targetTokens) {
      const sim = tokenSimilarity(qt, tt);
      if (sim > best) best = sim;
    }
    total += best;
  }
  return total / queryTokens.length;
}

// Minimum average token score to surface a candidate — high enough that
// unrelated queries (no real match in the catalog, e.g. a product the
// merchant genuinely doesn't carry) correctly return zero candidates rather
// than a weak/misleading guess. See prompt rule: no candidate -> noop, never
// a fabricated card.
const SEARCH_MATCH_THRESHOLD = 0.55;

/**
 * searchCandidates(query, store, max = 3) → [{slug, name}] — up to `max`
 * catalog products whose name/category/tags fuzzy-match `query`, sorted by
 * score descending. Empty array when nothing clears SEARCH_MATCH_THRESHOLD
 * (including when the catalog genuinely has nothing like it — e.g. a
 * product family the merchant doesn't carry at all). Exported for
 * server/store.test.js and reused by computeOffers()'s `search_help` offer.
 */
export function searchCandidates(query, store, max = 3) {
  const queryTokens = tokenizeSearchText(query);
  if (queryTokens.length === 0) return [];
  const scored = [];
  for (const p of store.catalog || []) {
    const targetText = [p.name, p.category, ...(p.tags || [])].join(" ");
    const targetTokens = tokenizeSearchText(targetText);
    const score = queryMatchScore(queryTokens, targetTokens);
    if (score >= SEARCH_MATCH_THRESHOLD) scored.push({ slug: p.slug, name: p.name, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map(({ slug, name }) => ({ slug, name }));
}

function applyUrgency(offer) {
  if (offer.ends_in_min != null && offer.ends_in_min <= 180) offer.urgent = true;
  else offer.urgent = false;
  return offer;
}

/**
 * computeOffers({ page, cart, promo }, now, store = loadStore()) → offer[]
 * `page`/`cart`/`promo` mirror buildState()'s own fields (promo = the latest
 * cart_view/cart_update meta.promo, `{code, discount} | null`). Pure given
 * `store` and `now` — safe to unit test without touching the filesystem by
 * passing a fake store.
 *
 * Offer kinds (see server/store/README.md for the full contract):
 *  - missed_discount   — a cart item has an active CODE promo not yet applied
 *  - auto_discount_active — a cart item has an active AUTO promo (already applied, informational)
 *  - similar_on_promo  — current product page's product isn't on promo, a `similar` one is
 *  - delivery_gap      — cart is within CART_GAP_PCT of policies.delivery.free_over.
 *    Carries `fill_with`: the cheapest catalog item whose price closes the
 *    gap (`{slug, name, price, promo}` | null), so a `card` can say "add
 *    this and delivery is free" instead of just naming the ৳ shortfall.
 *  - size_help         — current page is a product with `sizes` (a size can
 *    be picked). Carries `slug`, `sizes`, `fit_notes` (catalog.json), and
 *    `returns_window_days` (policies.json) — enough for a `pick_size` card.
 *    Deliberately carries NO suggested size: guessing which size the
 *    shopper needs is not this layer's job (see server/store/README.md) —
 *    the decider picks from `sizes` using its own evidence.
 *  - search_help       — the shopper's most recent search (`search` param:
 *    `{q, results}`, mirrors buildState()'s own `search` field) returned
 *    zero results AND searchCandidates() found at least one real fuzzy
 *    match in the catalog. Carries `query` (verbatim), `results: 0`, and
 *    `candidates` ([{slug, name}], up to 3, sorted best-first) — the ONLY
 *    source of a `cta.kind:"search"` card's corrected value (see
 *    prompts/decide.md "Failed search"). No candidates -> no offer, so the
 *    prompt has nothing to build a card on and must noop rather than invent
 *    a query.
 * Any offer whose `ends_in_min` is within 180 gets `urgent: true` (the
 * "expiring_soon" rule — a modifier, not a separate kind).
 */
export function computeOffers({ page, cart, promo, search } = {}, now = Date.now(), store = loadStore()) {
  const offers = [];
  const catalogMap = catalogBySlug(store);

  // missed_discount / auto_discount_active — one entry per (cart item, applicable promo).
  for (const item of cart?.items || []) {
    const slug = item.sku;
    for (const p of promosFor(store, slug, now)) {
      if (!minCartMet(p, cart)) continue;
      const saving = savingFor(p, item.price, item.qty ?? 1);
      const base = {
        slug,
        promo_id: p.id,
        code: p.code ?? null,
        label: p.label,
        saving,
        ends_in_min: endsInMin(p, now),
      };
      if (p.code && !p.auto_apply) {
        const appliedCode = promo?.code ?? null;
        if (appliedCode !== p.code) {
          offers.push(applyUrgency({ kind: "missed_discount", target_hint: "promo-code", ...base }));
        }
      } else if (p.auto_apply) {
        offers.push(applyUrgency({ kind: "auto_discount_active", target_hint: null, ...base }));
      }
    }
  }

  // similar_on_promo — current product page, product itself not on promo,
  // one of its `similar` slugs is. size_help — current product page has
  // sizes to pick from. Both keyed off the same current-page product lookup.
  const currentSlug = productSlugFromPage(page, store);
  const currentProduct = currentSlug ? catalogMap.get(currentSlug) : null;

  if (currentProduct && Array.isArray(currentProduct.sizes) && currentProduct.sizes.length > 0) {
    offers.push({
      kind: "size_help",
      target_hint: "size-guide",
      slug: currentProduct.slug,
      sizes: currentProduct.sizes.slice(),
      fit_notes: currentProduct.fit_notes ?? null,
      returns_window_days: store.policies?.returns?.window_days ?? null,
      urgent: false,
      ends_in_min: null,
    });
  }

  if (currentSlug) {
    const currentOnPromo = promosFor(store, currentSlug, now).length > 0;
    if (currentProduct && !currentOnPromo) {
      // Capped at 3 — a compact business block per decision (see
      // server/sites.test.js's business-block byte-size check): a merchant
      // catalog (e.g. an imported one, server/scripts/import-store.mjs)
      // could list many `similar` slugs, but the decider only ever needs a
      // handful of candidates, never the whole list.
      for (const simSlug of (currentProduct.similar || []).slice(0, 3)) {
        const simPromos = promosFor(store, simSlug, now);
        if (simPromos.length === 0) continue;
        const simProduct = catalogMap.get(simSlug);
        const p = simPromos[0]; // best-effort: first active promo on the similar product
        const saving = simProduct ? savingFor(p, simProduct.price, 1) : 0;
        offers.push(
          applyUrgency({
            kind: "similar_on_promo",
            target_hint: "similar-products",
            slug: simSlug,
            promo_id: p.id,
            code: p.code ?? null,
            label: p.label,
            saving,
            ends_in_min: endsInMin(p, now),
          })
        );
      }
    }
  }

  // delivery_gap — reuses gate.js's own CART_GAP_PCT so the offer fact and
  // the gate signal that fires the tick on it can never disagree about what
  // "close to free delivery" means. Deliberately narrow (within 10% of the
  // threshold): this is the "Almost free delivery" recipe, paired with a
  // real hesitation signal on cart/checkout (see prompts/decide.md). See
  // server/store.test.js (vi)/(vii) for the exact band this must keep.
  const freeOver = store.policies?.delivery?.free_over ?? FREE_DELIVERY_THRESHOLD_FALLBACK;
  if (cart) {
    const gap = freeOver - (cart.total ?? 0);
    if (gap > 0 && gap <= freeOver * CART_GAP_PCT) {
      offers.push(
        applyUrgency({
          kind: "delivery_gap",
          target_hint: "shipping-banner",
          slug: null,
          promo_id: null,
          code: null,
          label: `৳${gap} away from free delivery`,
          saving: null,
          gap,
          fill_with: cheapestCatalogItemAtLeast(store, gap, now),
          ends_in_min: null,
        })
      );
    }
    // cart_under_threshold — a SEPARATE, broader offer from delivery_gap
    // above: any open cart under the free-delivery threshold, not just a
    // near-miss. Category (b)/(c) fix (server/NOTES.md "moments" entry,
    // live finding session final_tm_242431): a shopper with ৳650 in cart
    // against a ৳1,500 threshold (56% away — well outside delivery_gap's
    // 10% band) browsing /shop had NOTHING computed to ground a card on,
    // even though "you're ৳X from free delivery" while actively browsing
    // with an open cart is a real, always-true fact worth surfacing once
    // (see prompts/decide.md's `cart_under_threshold` recipe, gated there
    // to browsing pages only — delivery_gap's own recipe already owns the
    // cart/checkout-page + hesitation case). Computed whenever cart.total >
    // 0 and under freeOver, independent of current page (cart is tracked
    // session-wide from the last cart_view/cart_update, same as above) —
    // never gated by CART_GAP_PCT, so it does NOT affect store.test.js
    // (vi)/(vii)'s delivery_gap-only assertions.
    if (gap > 0) {
      offers.push({
        kind: "cart_under_threshold",
        target_hint: "shipping-banner",
        slug: null,
        promo_id: null,
        code: null,
        label: `৳${gap} from free delivery`,
        saving: null,
        gap,
        fill_with: cheapestCatalogItemAtLeast(store, gap, now),
        urgent: false,
        ends_in_min: null,
      });
    }
  }

  // search_help — zero-result search with at least one real fuzzy candidate.
  // `search.results` must be EXACTLY 0 (not just falsy/undefined) — an
  // absent/unknown result count is not the same claim as "the store
  // searched and found nothing" and must never manufacture an offer.
  if (search && search.results === 0 && typeof search.q === "string" && search.q.trim()) {
    const candidates = searchCandidates(search.q, store, 3);
    if (candidates.length > 0) {
      offers.push({
        kind: "search_help",
        target_hint: "search",
        slug: null,
        promo_id: null,
        code: null,
        label: `${candidates.length} match${candidates.length === 1 ? "" : "es"} for "${search.q}"`,
        saving: null,
        query: search.q,
        results: 0,
        candidates,
        urgent: false,
        ends_in_min: null,
      });
    }
  }

  return offers;
}

/** businessBlock(store = loadStore()) → compact `{ delivery, returns, payment }` for buildState(). */
export function businessBlock(store = loadStore()) {
  const policies = store.policies;
  if (!policies) return null;
  return {
    delivery: policies.delivery ?? null,
    returns: policies.returns ?? null,
    payment: policies.payment ?? null,
  };
}
