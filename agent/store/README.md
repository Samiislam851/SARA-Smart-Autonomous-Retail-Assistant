# server/store/ — your business, as files

This folder IS the merchant's business context. It's not a promos add-on bolted
onto the agent — it's the plain-JSON record of the merchant's own catalog,
discounts, and store policy that the in-page agent is allowed to know and quote.
Everything the agent ever says about products, discounts, delivery, returns, or
payment must trace back to one of these three files. If a fact isn't here, the
agent doesn't know it and shouldn't invent it.

## The files

- **`catalog.json`** — product list, mirrored from `web/lib/products.ts`
  (`node web/scripts/check-store-mirror.mjs`, wired into `scripts/check.sh`, fails
  loudly if slug/price ever drift between the two — that check only compares
  slug+price, so the agent-only fields below don't need a web-side mirror).
  Adds fields the storefront doesn't need but the agent does:
  - `category` / `tags` — loose classification (`"outerwear"`, `"handloom"`, ...).
  - `similar` — an explicit array of other product `slug`s. This is a merchant
    decision ("style the mojari sandals with the nakshi scarf"), not a computed
    heuristic — if you want two products cross-sold together, list them here.
  - `fit_notes` — a short, shopper-facing sentence about fit/sizing (e.g.
    "Runs narrow through the shoulder — between sizes, take the larger.").
    Surfaced via the `size_help` fact below, safe to quote verbatim in a
    `pick_size` card. Optional — a product with no useful fit note (or no
    sizes at all) can omit it.

- **`promos.json`** — the merchant-edited discount list. Array of:
  ```json
  {
    "id": "jacket10",
    "code": "JACKET10",          // string a shopper types in, or null = automatic
    "kind": "percent",           // "percent" | "flat"
    "value": 10,                 // percent points, or a flat ৳ amount
    "applies": { "slugs": ["khadi-field-jacket"] },  // or "all", or { "categories": [...] }
    "min_cart": null,            // ৳ floor on cart total, or null = no floor
    "starts_at": null,           // ISO string, or null = always started
    "ends_at": null,             // ISO string — see "expiry" below
    "ends_in_ms": 172800000,     // fallback when ends_at is absent — see below
    "label": "10% off the Khadi Field Jacket",  // shopper-facing text, safe to quote verbatim
    "auto_apply": false          // true = applied without a code (informational to the agent, never "enter this code")
  }
  ```
  **Expiry**: `promos.json` is a static file, so it can't literally say "ends 48
  hours from whenever a demo happens to run." If `ends_at` (an absolute ISO
  timestamp) is present, that wins. If it's absent and `ends_in_ms` (a duration
  in milliseconds) is present instead, the promo's effective end time is
  **server process start + `ends_in_ms`** — i.e. restarting the server resets
  the countdown. If both are absent, the promo never expires (fine for an
  evergreen auto-apply promo like the scarf's). `starts_at` absent means
  "always started."

  **Stacking**: an `auto_apply: true` promo always applies to its eligible
  items regardless of anything else; a shopper's manually-entered code may
  additionally apply on top for the items *it* covers; a code never removes
  or replaces an auto promo (web/lib/cart.ts's `computeAppliedPromos()` is
  the source of truth for this rule — the cart/checkout pages show each
  applied promo as its own discount line).

- **`policies.json`** — the merchant's store-wide policy, not tied to any one
  product:
  ```json
  {
    "currency": "BDT",
    "delivery": { "free_over": 2000, "city": "Dhaka", "days": "1-2", "fee": 80 },
    "returns": { "window_days": 7, "note": "..." },
    "payment": ["bKash", "COD", "card"],
    "support": { "hours": "...", "contact": "..." }
  }
  ```
  This is the single source of truth for "how much until free delivery" — the
  agent's prompt (`server/prompts/decide.md`) is told to quote `business`
  (below) instead of a hardcoded number.

## Editing as a merchant

Just edit the JSON and save. **No server restart needed** — `server/store/index.js`
checks each file's mtime on every read and reloads only the files that changed.
The one exception: `ends_in_ms`-based expiry is anchored to server start, not to
when you edited the file (see above) — if you need a promo to end at an exact
moment, use `ends_at` instead.

A broken/invalid JSON file degrades to "that file's data is empty/unavailable"
(logged as a `[store]` warning), never a crash — the rest of the store and the
whole server keep working.

## Multiple stores (per-site)

This folder can serve MORE than one merchant. `server/store/catalog.json` /
`promos.json` / `policies.json` (this folder's own top-level files) are the
**default** site — unchanged from before multi-site support existed, and
still what every caller gets when it doesn't name a site. Any other
merchant lives in its own subfolder: `server/store/<site>/{catalog,promos,
policies}.json`, e.g. `server/store/acme/` (see `docs/ACME.md`
"Store import"). Each site is hot-reloaded and cached independently
(`server/store/index.js`'s `cachesBySite` Map) — editing one site's
`promos.json` can never invalidate or race another site's cache.

- **Which site resolves which directory**: `server/store/sites.js`'s
  `resolveSiteDir(site)`. Falsy / `""` / `"default"` → this folder itself.
  Any other name → `server/store/<name>/`, ONLY if that folder has its own
  `catalog.json`; otherwise it's treated as an unknown site and falls back
  to the default store (one `console.warn` per unknown name, not per
  request, so a typo'd `data-site` doesn't spam logs).
- **How a request picks its site**: the widget/embed (`server/public/
  agent.js`'s `data-site` attribute) sends `site` in every `page_view`
  event's `meta`. `server/state.js`'s `pushEvent()` pins `session.site`
  from the LATEST page_view that carries a non-empty `meta.site` — sticky
  across navigations that omit it (so a same-visit page that forgets to
  send the attribute doesn't silently flip the agent back to the default
  store mid-session). A brand-new session starts with `site: ""` (default).
- **Every call site that reads store data must pass `session.site`**, not
  call `loadStore()` bare — `server/state.js`'s `buildState()` and
  `server/policy.js`'s card guard (`add_to_cart`/`open_product`/
  `apply_code`/`pick_size` cta validation) all do this. A `loadStore()`
  call with no `site` argument ALWAYS reads the default store — that's
  the correct behavior for genuinely single-store callers/tests, but a
  defect if it happens on a path that should have respected the current
  session's site (this is exactly the bug class fixed in `server/
  policy.js`'s card guard when Acme support was added — it was
  validating every site's cards against the default catalog).
- **Route shape across sites**: `productSlugFromPage()` (this file) matches
  both `/product/<slug>` (default store) and `/products/<slug>` (Acme)
  — see `docs/ACME.md` for why a plural segment was the only
  route-shape difference worth generalizing for, rather than adding a
  per-site route-prefix config.
- **Importing a real merchant's catalog**: `server/scripts/
  import-store.mjs --site <name> --api <base-url>` (also `make import-store
  SITE=... API=...`). Writes the three JSON files for you from a live
  storefront API — see that script's own module comment and
  `docs/ACME.md` "Store import" for the Acme-specific mapping
  (poisha→Taka, category lookup, coupon-table fallback, etc).
- **Tests**: `server/sites.test.js` — default vs named site load to
  different files, unknown site fallback, hot reload scoped to one site's
  cache, `session.site` pinning, and a business-block byte-size sanity
  check (the per-decision payload must stay compact regardless of catalog
  size — see "How this reaches the model" below).

## How this reaches the model

`server/state.js`'s `buildState()` calls into this folder on every event and adds
two things to the state the model sees:

- **`business`** — the compact `{ delivery, returns, payment }` subset of
  `policies.json` (via `businessBlock()`). The model is told (in
  `prompts/decide.md`) this is the merchant's CURRENT policy and to quote it,
  never assume a number.
- **`product`** — the CURRENT product page's catalog entry (via
  `server/state.js`'s `buildState()`), `{slug, name, price, sizes,
  fit_notes}` or `null` off a product page. `server/policy.js`'s card guard
  checks a `pick_size` cta's value against `product.sizes` — the ONLY place
  that decides what counts as "a real size for the page the shopper is on."
- **`offers`** — an array of computed facts the assistant can act on (via
  `computeOffers()`), each one true and safe to quote:
  - `missed_discount` — a cart item has an active **code** promo the shopper
    hasn't applied yet (`meta.promo.code` on the latest `cart_view`/
    `cart_update` doesn't match). Carries `code`, `saving` (৳), `target_hint:
    "promo-code"` — pairs with an `apply_code` card.
  - `auto_discount_active` — a cart item has an active **automatic** promo
    already applied. Informational only — no code to mention.
  - `similar_on_promo` — the product on the current page has NO active promo
    of its own, but one of its `catalog.json` `similar` products does.
    `target_hint: "similar-products"` — pairs with an `open_product` card.
  - `delivery_gap` — cart total is within 10% under `business.delivery.free_over`
    (same percentage `server/gate.js`'s cart-friction rule uses — exported as
    `CART_GAP_PCT` so the two can't drift). `target_hint: "shipping-banner"`.
    Carries `fill_with`: `{slug, name, price, promo}` — the CHEAPEST catalog
    item whose price closes the gap (or `null` if nothing in the catalog
    does), so a card can say "add this and delivery is free" instead of just
    naming the ৳ shortfall. Pairs with an `add_to_cart` card.
  - `size_help` — the current page is a product with `sizes` to pick from.
    Carries `slug`, `sizes`, `fit_notes` (from `catalog.json`), and
    `returns_window_days` (from `policies.json`). Deliberately carries NO
    suggested size — guessing which size fits is not this layer's job; the
    decider picks one from `sizes` using its own evidence. `target_hint:
    "size-guide"` — pairs with a `pick_size` card.
  - Any offer whose `ends_in_min` is ≤ 180 gets `urgent: true` ("expiring
    soon") — a tie-breaker, not a license to skip the restraint rules in
    `prompts/decide.md`.

`server/gate.js` and `server/tick.js` also read `state.offers` to decide WHEN to
even call the model: `promo_missed` (a `missed_discount` offer + hesitation on
the cart/checkout flow) and `similar_promo` (a `similar_on_promo` offer + real
attention/return-visit on the current product) are two more entries in the same
friction-signal ladder as cart threshold, rage clicks, etc.

## Testing

- Pure unit tests, no server needed: `npm run test:store` (`node store.test.js`)
  — exercises `computeOffers()`/`businessBlock()` against hand-built fake
  stores, so it never depends on the live contents of these JSON files.
- Signal-level tests: `npm run test:gate` covers `promoMissedSignal`/
  `similarPromoSignal`.
- End-to-end against a running server: start the server
  (`AGENT_MODE=stub npm run dev`, or any port ≥ 4500 for a scratch check —
  never 3000/4000, docker owns those) and either:
  - `curl localhost:<port>/health` — look at the `store` block:
    ```json
    "store": { "promos": 3, "active": 3, "catalog": 4, "policiesLoaded": true, "loadedAt": 1699999999999, "policiesLoadedAt": 1699999999999, "ok": true }
    ```
  - `node replay.js sessions/missed-promo.json sessions/similar-on-promo.json --base http://localhost:<port>` —
    scripted fixtures that walk through exactly the two offer kinds above and
    assert the resulting action.
