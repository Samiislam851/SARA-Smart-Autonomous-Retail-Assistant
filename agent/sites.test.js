// sites.test.js — per-site store loading (server/store/sites.js,
// server/store/index.js's loadStore(site)) + session->site plumbing
// (server/state.js) + business-block byte-size sanity for the Acme
// import vs the default store. Plain node asserts, same style as
// server/store.test.js. Run: node server/sites.test.js
// (or as part of `node --test server/*.test.js`.)

import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStore } from "./store/index.js";
import { resolveSiteDir, normalizeSite, _resetWarnedUnknownSitesForTest } from "./store/sites.js";
import { getSession, pushEvent, buildState } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_ROOT = path.join(__dirname, "store");

// ---- (i) default site (no arg / "" / "default") all load the same files --
{
  const a = loadStore();
  const b = loadStore("");
  const c = loadStore("default");
  assert.equal(a.site, "default");
  assert.equal(b.site, "default");
  assert.equal(c.site, "default");
  assert.deepEqual(a.catalog.map((p) => p.slug), b.catalog.map((p) => p.slug));
  assert.deepEqual(a.catalog.map((p) => p.slug), c.catalog.map((p) => p.slug));
  console.log("(i) ok — default/''/'default' all resolve to the same store");
}

// ---- (ii) a real site directory (acme) loads its OWN catalog -------
{
  const store = loadStore("acme");
  assert.equal(store.site, "acme");
  const defaultStore = loadStore("default");
  assert.notDeepEqual(
    store.catalog.map((p) => p.slug).sort(),
    defaultStore.catalog.map((p) => p.slug).sort(),
    "acme catalog is a genuinely different product list from the default store"
  );
  assert.ok(store.catalog.length >= 16, `expected the imported acme catalog to have >=16 products, got ${store.catalog.length}`);
  console.log(`(ii) ok — acme site loads its own ${store.catalog.length}-product catalog`);
}

// ---- (iii) unknown site falls back to default store + is normalized ------
{
  _resetWarnedUnknownSitesForTest();
  const resolved = resolveSiteDir("no-such-site-xyz");
  assert.equal(resolved.site, "default");
  assert.equal(resolved.unknown, true);
  const store = loadStore("no-such-site-xyz");
  assert.equal(store.site, "default");
  assert.deepEqual(
    store.catalog.map((p) => p.slug),
    loadStore("default").catalog.map((p) => p.slug)
  );
  console.log("(iii) ok — unknown site falls back to the default store");
}

// ---- (iv) normalizeSite() canonicalizes falsy/"default" ------------------
{
  assert.equal(normalizeSite(""), "default");
  assert.equal(normalizeSite(undefined), "default");
  assert.equal(normalizeSite(null), "default");
  assert.equal(normalizeSite("default"), "default");
  assert.equal(normalizeSite("acme"), "acme");
  console.log("(iv) ok — normalizeSite() canonicalizes falsy/'default' inputs");
}

// ---- (v) hot reload on mtime change, scoped to its own site's cache ------
{
  const testSite = "__test_site_reload__";
  const dir = path.join(STORE_ROOT, testSite);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(path.join(dir, "catalog.json"), JSON.stringify([{ slug: "a", name: "A", price: 10 }]));
    writeFileSync(path.join(dir, "promos.json"), JSON.stringify([]));
    writeFileSync(path.join(dir, "policies.json"), JSON.stringify({ currency: "BDT" }));

    const first = loadStore(testSite);
    assert.deepEqual(first.catalog.map((p) => p.slug), ["a"]);

    // Rewrite with new content AND bump mtime forward so the mtime check
    // (server/store/index.js's readJsonIfChanged) is guaranteed to see a
    // change even on filesystems with coarse mtime resolution.
    writeFileSync(path.join(dir, "catalog.json"), JSON.stringify([{ slug: "a", name: "A", price: 10 }, { slug: "b", name: "B", price: 20 }]));
    const future = new Date(Date.now() + 5000);
    utimesSync(path.join(dir, "catalog.json"), future, future);

    const second = loadStore(testSite);
    assert.deepEqual(second.catalog.map((p) => p.slug), ["a", "b"], "hot reload picked up the mtime-changed catalog");

    // Reloading the DEFAULT site's cache must be unaffected by this site's
    // file churn — independent per-site caches (server/store/index.js's
    // cachesBySite Map).
    const defaultStillIntact = loadStore("default");
    assert.ok(defaultStillIntact.catalog.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log("(v) ok — per-site cache hot-reloads on mtime change, independent of other sites");
}

// ---- (vi) session.site is pinned from page_view meta.site, sticky --------
{
  const session = getSession("s_sites_test_1");
  assert.equal(session.site, "", "brand new session starts with no site");
  pushEvent(session, { session: session.id, type: "page_view", target: "/products/chaa-break-mug", meta: { targets: [], site: "acme" } });
  assert.equal(session.site, "acme");
  // A later page_view that omits meta.site must NOT reset the session back
  // to default — sticky across navigations that don't all carry the
  // attribute (see state.js pushEvent()'s comment).
  pushEvent(session, { session: session.id, type: "page_view", target: "/cart", meta: { targets: [] } });
  assert.equal(session.site, "acme", "site stays pinned when a later page_view omits meta.site");
  console.log("(vi) ok — session.site pinned from page_view meta.site, sticky across omits");
}

// ---- (vii) unknown site name on a session falls back cleanly in buildState
{
  const session = getSession("s_sites_test_2");
  pushEvent(session, { session: session.id, type: "page_view", target: "/products/chaa-break-mug", meta: { targets: [], site: "totally-unknown-site" } });
  const state = buildState(session);
  assert.ok(state.business, "unknown site still gets a business block (default store's policies.json)");
  console.log("(vii) ok — buildState() degrades an unknown session.site to the default store");
}

// ---- (viii) business-block byte size: acme vs default ---------------
{
  const defaultSession = getSession("s_sites_test_bb_default");
  pushEvent(defaultSession, {
    session: defaultSession.id,
    type: "page_view",
    target: "/product/khadi-field-jacket",
    meta: { targets: ["size-guide"], site: "" },
  });
  const defaultState = buildState(defaultSession);
  const defaultBytes = Buffer.byteLength(
    JSON.stringify({ product: defaultState.product, offers: defaultState.offers, business: defaultState.business }),
    "utf8"
  );

  const acmeSession = getSession("s_sites_test_bb_acme");
  const tmCatalog = loadStore("acme").catalog;
  const tmSlug = tmCatalog[0].slug;
  pushEvent(acmeSession, {
    session: acmeSession.id,
    type: "page_view",
    target: `/products/${tmSlug}`,
    meta: { targets: [], site: "acme" },
  });
  const acmeState = buildState(acmeSession);
  const acmeBytes = Buffer.byteLength(
    JSON.stringify({ product: acmeState.product, offers: acmeState.offers, business: acmeState.business }),
    "utf8"
  );

  assert.ok(acmeState.product, "acme product page resolves to a real catalog entry");
  // The per-decision business block must stay compact regardless of catalog
  // size — it carries the CURRENT product only, never the whole 16-product
  // catalog (server/store/README.md's latency note / this task's brief).
  assert.ok(acmeBytes < 2000, `acme business block unexpectedly large: ${acmeBytes} bytes`);
  console.log(`(viii) business block bytes — default store: ${defaultBytes}, acme (16 products): ${acmeBytes}`);
}

console.log("sites.test: all assertions passed");
