# NextCart integration

The agent (`agent/public/agent.js`, served from this repo's `agent/` on
:4000) is embedded in a second storefront, NextCart — a real Next.js 15 +
MongoDB store (home, category, product, search, cart, 4-step checkout,
policies, mock login, admin), built independently and dropped into this
repo's `storefront/` directory (see `storefront/README.md`). This doc is
the runbook for that integration.

## Scope note — build-day exception to NextCart's own BUILD-DECISIONS.md §0

NextCart's `BUILD-DECISIONS.md` §0 is a **HARD SCOPE BOUNDARY** stating "do
not implement anything that captures, batches, or sends event data... no
agent widget" — written as a *pre*-build-day rule for a store that was
built standalone. For the hackathon, that boundary was consciously set
aside so the agent could be embedded as a second real storefront alongside
the reference demo-store.

The integration edits live on a branch (`agent-embed`) in the NextCart
repo, kept separate from its `main` until merged. Dropping/not merging that
branch restores NextCart's own §0 in full.

## Ports / processes

| Component | Port | Notes |
|---|---|---|
| Mongo (`nextcart-mongo` container) | 27017 | Started via NextCart's own `docker-compose.yml`. |
| NextCart (Next.js) | 3801 | `PORT=3801 npm run dev`. Requires Node 24+ per NextCart's own README; ran successfully against an older Node with `npm install` (lockfile drift, harmless `EBADENGINE` warnings only). |
| SARA agent (this repo's `agent/`) | 4000 | Must stay up for `<script src="http://localhost:4000/agent.js">` to load. |

Fresh-machine steps:
```
cd storefront          # once NextCart is merged into this repo (see storefront/README.md)
cp .env.example .env.local
docker compose up -d          # mongo:7 on 27017
npm install
npm run seed                  # 10 categories x 30 products, 6 users
PORT=3801 npm run dev
```

## Seed / bring-up verification

`npm run seed` output: 10 categories (expected 10), 300 products (expected
300, 30/category), 6 users, 910 images already on disk. Confirmed via curl:
home (200), `/c/electronics` (200), `/p/<slug>` (200), `/search?q=camera`
(200), `/cart` (200, empty-cart state), `/checkout/address` (307 → `/cart`,
correct: checkout requires a non-empty cart). All pages are Server
Components — full markup, including agent hooks, is present in raw SSR
HTML; no client-side-fetch pages here (the reference demo-store needed
browser verification for some attributes; NextCart's SSR pages don't).

## Cart mechanism

Cookie + DB, not localStorage (BUILD-DECISIONS.md §6): an httpOnly cookie
holds a `cartId`, and the `carts` Mongo collection holds items. There is
**no client-fetchable cart JSON API route** — cart reads only happen in
Server Components (`Header`, `/cart` page) and cart writes only through
Server Actions (`cart/actions.ts`, `p/actions.ts`), which call
`revalidatePath("/cart")`. Because Server Actions trigger Next to
re-render the whole currently-mounted route tree (including the root
layout's `Header`), the header's cart badge already updates live after
every add/remove/navigate — verified by reading `cart/actions.ts` and
`p/actions.ts`, not assumed.

Given that, and no new API route being in scope, `Header.tsx` now renders
a `data-agent-cart` JSON attribute on the `<header>` element (present on
every page) — `{total, items:[{name, variant, quantity, price}]}`, amounts
converted from minor units to major units via the repo's own sanctioned
`minorUnitExponent()` helper (`src/lib/format.ts`), matching the demo-store's convention of exposing already-human-readable
amounts. `AgentCartBridge`
(`src/components/storefront/agent-cart-bridge.tsx`, mounted once in the
root layout) reads that attribute and sets `window.__agentCart = {total,
items}` — the explicit source `agent.js`'s `readCart()` checks first — on
mount, on every route-pathname change (covers full navigations + the
post-Server-Action re-render), and on a 2s poll fallback, mirroring the demo-store's bridge cadence.

## `data-agent-target` — what the teammate already had, and what was added

The teammate's own `BUILD-DECISIONS.md §7` pre-declares 5 **inert**
targets, explicitly "never read or triggered by any code" prior to this
session — kept exactly as-is, not renamed, to honor "keep existing hooks,
add ours alongside":

| Existing id | Element | File |
|---|---|---|
| `search-input` | Header search field | `components/layout/Header.tsx` |
| `add-to-cart` | PDP add-to-cart button | `components/product/ProductOptions.tsx` |
| `shipping-info` | PDP shipping/returns accordion trigger | `components/product/ShippingAccordion.tsx` |
| `begin-checkout` | Cart page's checkout CTA | `app/cart/page.tsx` |
| `place-order` | Checkout review step's submit | `components/checkout/ReviewStep.tsx` |

These map conceptually onto the agent's own `data-agent-target` vocabulary
(`search`, `cart-add`, `shipping-banner`, `checkout-btn`) but were **not
renamed** — same string, so existing tests (`Header.test.tsx`,
`ReviewStep.test.tsx`, `cart/page.test.tsx`) keep passing unmodified.
`place-order` happens to be an exact match with the agent's own vocabulary
already.

Newly added (agent `data-agent-target` vocabulary, see README's "Embed on
any store" table):

| id | Element | File |
|---|---|---|
| `product-title` | PDP `<h1>` | `app/p/[slug]/page.tsx` |
| `price` | PDP price `<p>` | `app/p/[slug]/page.tsx` |
| `size-picker` | Size variant `<fieldset>` | `components/product/VariantSelector.tsx` |
| `size-option-<SIZE>` | Each size button (value upper-cased) | `components/product/VariantSelector.tsx` |
| `color-picker` | Colour variant `<fieldset>` | `components/product/VariantSelector.tsx` |
| `cart-link` | Header cart icon link | `components/layout/Header.tsx` |
| `cart-items` | Cart page line-item list | `app/cart/page.tsx` |
| `cart-total` | Cart page total `<dd>` | `app/cart/page.tsx` |
| `address-form` | Checkout address `<form>` | `components/checkout/AddressForm.tsx` |
| `payment-options` | Checkout payment method panel | `components/checkout/PaymentStep.tsx` |
| `checkout-total` | Review step total `<dd>` | `components/checkout/ReviewStep.tsx` |
| `policies-link` | Footer nav wrapping both policy links | `components/layout/Footer.tsx` |
| `shipping-policy` | Footer "Shipping policy" link | `components/layout/Footer.tsx` |
| `returns-policy` | Footer "Returns policy" link | `components/layout/Footer.tsx` |

## Gaps (no equivalent element exists — not force-fitted)

- **`size-guide`** — NextCart has no size-chart/size-guide modal; only
  `shipping-info` (an accordion) exists on the PDP.
- **`quantity`** — NextCart's PDP has no pre-add quantity picker (always
  adds qty 1); quantity is only adjustable *after* adding, via a `<select>`
  on the cart line (`CartLineItem.tsx`). Left untagged rather than
  mislabeling a materially different control.
- **`promo-code`** — no coupon/promo feature exists anywhere; checkout is
  Cash-on-Delivery only (BUILD-DECISIONS.md §6), no discount code path.
- **`category-filter`** — the category page (`/c/[slug]`) has a
  `SortControl` (sort-by dropdown) but no filter sidebar/facets; sorting
  isn't the same affordance as filtering, so it was left untagged.
- **`checkout-btn`** — NextCart's checkout is address → delivery →
  payment → review, with a single final submit (`place-order`); there's no
  separate "go to checkout" button beyond the cart page's own
  `begin-checkout` (already covered above).

## Search result count

`agent.js` does **not** currently read any `results`/`meta.results` field
or a `data-agent-search-results`-style attribute — verified by grepping
`agent/public/agent.js` for `results`, `search`, `resultCount`: the only
`search` event it emits carries `{q: <query text>}`, nothing about result
count, and no site has a documented precedent for this attribute. `data-agent-search-results="<n>"` was still added to
`/search`'s results `<header>` (`app/search/page.tsx`, server-rendered,
`result.total`) as directed, since it's cheap and correct — but it is
currently **inert**: nothing in `agent.js` reads it yet. Flagging this so
it isn't mistaken for a working integration; wiring agent.js to consume it
is out of scope here (explicitly told not to edit `agent.js`).

## Verification

- `curl -s localhost:3801/ | grep -c 'agent.js'` → `1`.
- `npx tsc --noEmit` → clean, no errors.
- `npm run lint` → clean, no errors/warnings.
- `npm test` → 362/362 passed (38 files). Two tests (`Header.test.tsx`,
  `VariantSelector.test.tsx`) timed out once under full-suite parallel
  load but passed individually in isolation and passed on a full-suite
  rerun — pre-existing `vitest` jsdom-creation overhead flake (the runner
  itself warns "jsdom was created 38 times... create it once per worker"),
  not caused by these edits.
- Product-page target counts verified live via curl across several
  products: a no-variant product shows 9 targets
  (`add-to-cart, cart-link, policies-link, price, product-title,
  returns-policy, search-input, shipping-info, shipping-policy`); a
  colour-variant product (`sonique-always-on-display-smart-watch`) adds
  `color-picker` (10 total); a size-variant product
  (`summit-trail-chino-pants-high`, `/c/clothing-shoes`) shows
  `size-picker` + `size-option-S/M/L/XL`. All ≥8, all visible via plain
  `curl` (no client-hydration wait needed — every page here is
  server-rendered).

## Search verification (agent.js result counts)

NextCart has no in-page search input filtering — search is a full SSR
navigation to `/search?q=<query>`. The results page
(`src/app/search/page.tsx`) puts `data-agent-search-results={result.total}`
on the results `<header>`, not on any input — there is no live input to
attach a MutationObserver's target element to, so this exercises agent.js's
route-driven path (`checkRouteSearch()`, called from `sendPageView()`) and
its "search anywhere on the page" attribute-discovery fallback, not the
Enter-keydown path.

Manual check:
1. Load agent.js on any NextCart page, open devtools Network tab filtered
   to `/event`.
2. Type a query into the header search box and submit (navigates to
   `/search?q=...`).
   - Expect a `page_view` event for `/search` (existing behavior), followed
     by a `search` event with `meta.q` equal to the URL's `q` param and
     `meta.results` equal to `result.total` shown in the page's "N
     result(s)" line. A query with zero matches must produce
     `meta.results: 0` exactly.
3. Navigate directly to `/search?q=zzzznomatch` (address bar, full load) —
   confirms the boot-time `sendPageView()` call (not just SPA
   pushState/replaceState) also triggers `checkRouteSearch()`.
4. Change the query via the header search box again without a full reload
   (client-side `<Link>`/`router.push` navigation, if the header uses one)
   — confirms the pushState-monkeypatch path (`onRouteChange()` →
   `sendPageView()`) re-triggers the check and emits a fresh `search` for
   the new `q`, not a stale dedupe-suppressed repeat of the old one.
5. Devtools console on `/search?q=...`:
   `document.querySelector('[data-agent-search-results]').getAttribute('data-agent-search-results')`
   should equal the visible result count.
