// Per-site store resolution — which directory's catalog/promos/policies.json
// a given `site` name reads from. Kept separate from store/index.js's own
// read/cache/parse logic so "where do this site's files live" (this module)
// and "how do we hot-reload+shape them into offers/business facts" (index.js)
// don't tangle. See server/store/README.md "Multiple stores" section.
//
// Default site (site is falsy, "", or "default"): server/store/*.json —
// unchanged from before multi-site support existed, so every pre-existing
// caller that never passes a `site` keeps working with zero behavior change.
// Any other site name: server/store/<site>/{catalog,promos,policies}.json.
// A site directory that doesn't exist (or has no catalog.json) is NOT an
// error — falls back to the default store, with one warning logged per
// unknown site name (not per request) so a typo'd data-site doesn't spam
// logs on every page view.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STORE_ROOT = path.dirname(fileURLToPath(import.meta.url)); // server/store/

export const DEFAULT_SITE = "default";

const warnedUnknownSites = new Set();

/** normalizeSite(site) → canonical site key used for caching ("default" for falsy/"default"). */
export function normalizeSite(site) {
  if (!site || typeof site !== "string" || site === DEFAULT_SITE) return DEFAULT_SITE;
  return site;
}

/**
 * resolveSiteDir(site) → { dir, site: resolvedSiteKey, unknown } — the
 * directory to read this site's catalog/promos/policies.json from.
 * `unknown: true` means the requested site had no directory/catalog.json of
 * its own and this call fell back to the default store's files (dir will be
 * STORE_ROOT itself, and `site` will report DEFAULT_SITE so callers cache
 * the fallback under the same key as an explicit default request).
 */
export function resolveSiteDir(site) {
  const key = normalizeSite(site);
  if (key === DEFAULT_SITE) return { dir: STORE_ROOT, site: DEFAULT_SITE, unknown: false };

  const dir = path.join(STORE_ROOT, key);
  if (existsSync(path.join(dir, "catalog.json"))) {
    return { dir, site: key, unknown: false };
  }

  if (!warnedUnknownSites.has(key)) {
    console.warn(`[store] unknown site "${key}" (no ${path.join(dir, "catalog.json")}) — falling back to default store`);
    warnedUnknownSites.add(key);
  }
  return { dir: STORE_ROOT, site: DEFAULT_SITE, unknown: true };
}

// Test-only: lets server/sites.test.js reset the "warned once" dedup between
// cases without needing a fresh process per case.
export function _resetWarnedUnknownSitesForTest() {
  warnedUnknownSites.clear();
}
