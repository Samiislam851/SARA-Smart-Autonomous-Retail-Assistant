# NextCart — Locked Build Decisions

Single source of truth for every agent working on this repo. Read this before writing code.
The behavioural-agent design spec lives at `D:\hackathon\idea\behavioral-agent-spec.md`
(read §3.3.1, §3.4, §6.5 for storefront-relevant constraints).

## 0. HARD SCOPE BOUNDARY

**Do NOT implement anything that captures, batches, or sends event data.**
No `tracker.ts`, no `/ingest`, no Socket.IO, no agent widget, no `lib/tracker/`,
no `lib/agent-widget/`, no analytics, no beacons, no page-view hooks.
This is a plain e-commerce storefront plus an admin panel. Nothing else.

The ONE exception, which is inert markup and CSS only:
- `data-agent-target="..."` attributes on key elements (see §7 below)
- `styles/agent.css` defining `.agent-pulse`, `.agent-spotlight`, `.agent-backdrop`
These are never read or triggered by any code we write now.

## 1. Project

- Root: `D:\hackathon\NextCart\`
- Next.js 15, App Router, TypeScript **strict**, React Server Components by default
- Tailwind CSS v4
- Node 24, npm (pnpm also available)
- Page structure modelled on Amazon

## 2. Data

- MongoDB via Docker: `mongo:7` service in `docker-compose.yml`. No native install.
- `MONGODB_URI=mongodb://localhost:27017/nextcart`
- Seed: **10 categories x 30 products = 300 products**
- PLP pagination: **24 per page** (2 pages per category)
- Search: MongoDB `$text` index over title/brand/category.
  NOTE: local MongoDB has **no Atlas Vector Search**. Storefront search is `$text` only.

### Collections
`categories`, `products`, `carts`, `orders`, `users`

## 3. Critical design constraints (from the spec)

- **Variants (size/colour) are controls on ONE product detail page.**
  NEVER separate routes per variant. Separate URLs would silently break the
  `pdp_ping_pong` signal later. This is non-negotiable.
- `/policies/shipping` and `/policies/returns` must exist as real routes.
- Checkout is 4 steps, then a success page.

## 4. Routes — 12 templates / 16 screens

| Route | Screens | Notes |
|---|---|---|
| `/` | 1 | Home |
| `/c/[slug]` | 1 | PLP, category grid |
| `/p/[slug]` | 1 | PDP, variants as controls |
| `/search` | 1 | `$text` search results |
| `/cart` | 1 | |
| `/checkout/[step]` | 4 | address, delivery, payment, review |
| `/checkout/success` | 1 | Thank-you page |
| `/policies/[slug]` | 2 | shipping, returns |
| `/login` | 1 | Mock login, no password |
| `/admin/products` | 1 | List, search, pagination, active toggle |
| `/admin/products/new` | 1 | Create + image upload |
| `/admin/products/[id]/edit` | 1 | Edit, same form component |

## 5. Auth

- **Mock login, no password.** Pick a user from a list, sets an httpOnly cookie.
- `users` have a `role: "customer" | "admin"`.
- `/admin/*` is gated on `role === "admin"` in middleware.
- No real credentials anywhere. No password hashing. No sessions table.

## 6. Cart & orders

- Cart persisted in the `carts` collection, keyed by an **httpOnly cookie cart id**.
  Not localStorage — cookie+DB survives reload and is actually testable.
- Payment is **Cash on Delivery only**. No card fields, no payment provider, no PCI surface.
- Order placement writes an `orders` doc and clears the cart.

## 7. Agent hook attributes (inert)

Add `data-agent-target` to these elements. Nothing reads them yet.

| Value | Element |
|---|---|
| `begin-checkout` | The cart page's primary checkout CTA |
| `add-to-cart` | PDP add-to-cart button |
| `shipping-info` | PDP shipping/returns accordion trigger |
| `search-input` | Header search field |
| `place-order` | Checkout review step's final submit |

## 8. Images

- Seed placeholders: generated deterministically, written to `public/products/seed/`, **committed**.
- Admin uploads: written to `public/products/uploads/`, **gitignored** except `.gitkeep`.
- Mongo stores the relative web path only (e.g. `/products/uploads/ab12cd.webp`).
  Never a filesystem path.

### Upload security (required)
- Allowlist extensions AND verify real MIME by sniffing magic bytes. Never trust the
  client's `Content-Type` or filename.
- Server generates the stored filename. The client's filename never influences the path.
- Enforce a max file size.
- Reject anything that resolves outside `public/products/uploads/`.

**Known limitation:** writing to `public/` works in local dev and Docker volumes but NOT on
Vercel (read-only, ephemeral FS). Acceptable for now; would become S3/R2 if ever deployed.

## 9. Testing

- **Vitest + React Testing Library.** Unit + integration.
- Cover: data-layer repositories, cart logic, search, checkout state machine,
  upload validation, and component rendering.
- No Playwright / E2E for now.
- Tests live next to what they test or under `__tests__/`. Be consistent.
- Every feature ships with its tests. A feature is not done without them.

## 10. Conventions

- Server Components by default; `"use client"` only where interaction demands it.
- Data access goes through `lib/db/` repositories. Pages never touch the driver directly.
- Zod for all input validation (forms, route handlers, search params).
- No `any`. No `@ts-ignore`.
- Keep components small and colocated under `components/`.

## 11. Resolved during build

Decisions made during feature 1 (scaffold) that §§0–10 did not cover, plus those
made when verifying it. **These are now locked. Later features consume them and
must not re-litigate them.** If one genuinely blocks you, change it here first
and update every consumer in the same commit.

### 11.1 Dependency pins

- **Next `15.5.25` (exact, not `^`)**, React `19.2.8`, Tailwind `4.3.3`,
  mongodb `7.6.0`, zod `4.6.2`, Vitest `5.0.0`. §1 says "Next.js 15", so the
  major is pinned deliberately; the exact pin keeps `eslint-config-next` in
  lockstep with the framework.
- **`npm audit` reports a `postcss <=8.5.22` advisory. It is accepted, not
  fixed.** The only vulnerable copy is nested under `next@15.5.25`; our direct
  `@tailwindcss/postcss` and Vite both resolve `postcss@8.5.28`, which is not
  affected. All four CVEs are build-time only (CSS stringify output, and
  `sourceMappingURL` reads during compilation) — postcss does not run in the
  served application, and no user-supplied CSS is ever compiled. The only
  `npm audit fix --force` path is Next 16, which §1 pins against. Re-check when
  Next 16 becomes acceptable; do not "fix" it by upgrading unilaterally.
- **`eslint.config.mjs` uses `@eslint/eslintrc`'s `FlatCompat`** because
  `eslint-config-next` for Next 15 is not flat-config native. Verified working:
  a deliberate `any` is caught by `@typescript-eslint/no-explicit-any`. Leading
  `_` marks an intentionally unused binding.
- **`vitest.config.mts`**, not `.ts` — Vite's native config loader treats a
  `.ts` config in a non-`"type": "module"` package as CommonJS.

### 11.2 Money

- Money is an **integer count of the currency's minor unit**, everywhere, with
  no exceptions. `moneyMinorUnitsSchema` enforces finite + integer +
  non-negative + a sane upper bound. It is enforcement, not a comment: a float
  price cannot be parsed into any schema in this codebase.
- **`formatPrice(amountMinorUnits, currency)` in `src/lib/format.ts` is the
  only place money becomes a string.** It throws on a non-integer input.
  Its minor-unit exponent table is: `JPY`/`KRW`/`VND` → 0, `BHD`/`KWD`/`OMR` → 3,
  **everything else → 2**. Add to the table rather than special-casing at a
  call site.
- `cartSubtotal()` / `lineTotal()` in `src/lib/schemas/cart.ts` are the only
  sanctioned totalling functions. Do not re-implement the arithmetic.

### 11.3 Currency

- One currency per store: **`DEFAULT_CURRENCY = "USD"`** (`schemas/common.ts`).
- `Cart.currency` is held **at cart level, not per item**, which makes a
  mixed-currency cart unrepresentable. It defaults, so creating an empty cart
  needs no currency field.
- `Order.currency` is **required** — a stored order must still render correctly
  years later, even if the store's currency changes.

### 11.4 Product & variants

- `Product.variants` is an **embedded array on the single product document**:
  `{ type: "size" | "colour", label, value, available }`. A variant has no
  `_id`, no slug and no price of its own — deliberately, so there is nothing a
  router could bind to. This is how §3's "never separate routes per variant" is
  made structurally true rather than merely asked for.
- `(type, value)` pairs must be unique within a product (schema-enforced).
- The array is flat and mixes both types. **`groupVariants()` in
  `schemas/product.ts` is the one place it is grouped by type** for rendering
  PDP controls.
- `Product.images` and `Category.imagePath` are validated by `imagePathSchema`:
  a relative web path matching `/products/(seed|uploads)/….(webp|png|jpg|jpeg|avif)`.
  Filesystem paths, URLs, `..` traversal and non-image extensions are rejected.
  This is where §8's "never a filesystem path" is actually enforced.

### 11.5 Cart

- `Cart.items[].variantSelection` is `Partial<Record<"size" | "colour", string>>`
  (Zod 4 `z.partialRecord`), defaulting to `{}`. Partial because a product may
  have sizes but no colours; values mirror `ProductVariant.value` bounds.
- Per-line quantity is capped at **`MAX_LINE_QUANTITY = 99`**.
- The cart is keyed by `cartId`, the httpOnly cookie value — never a user id.

### 11.6 Order

- **`Order.address`** (locked shape): `fullName`, `line1`, `line2?`, `city`,
  `state`, `postalCode`, `country`, `phone`. Deliberately country-agnostic —
  free-text `state`/`country`, loose `postalCode` — so a valid foreign address
  is never rejected on a format technicality. There is **no separate billing
  address**: COD has no payment instrument to bill.
- **`Order.status`**: `placed | processing | shipped | delivered | cancelled`.
  The storefront only ever writes `placed`; the rest exist for the admin panel.
- **`Order.deliveryMethod`**: `standard | express`, required. Added during
  verification — checkout step 2 ("delivery") chooses an option, and without
  this the order recorded a `shipping` *cost* but not *what the shopper chose*,
  so the review step and confirmation page could not name it back to them.
  Feature 8 owns the price of each option; the enum is fixed here.
- **Order totals are schema-enforced**, not merely stored:
  `subtotal === Σ(price × quantity)` and `total === subtotal + shipping`.
  A miscalculation fails loudly at the write boundary instead of being
  persisted. There is no discount field; add one here first if it is ever needed.
- `Order.userId` is optional — guest checkout is supported.

### 11.7 Input schemas

- Every collection has a `xInputSchema` that omits server-assigned fields.
  The convention is **omit `_id` and all timestamps** — the repository sets
  them. `orderInputSchema` was brought into line with this during verification.
- `productInputSchema` is what the admin form (feature 9) validates for **both**
  create and edit; the edit route supplies `_id` from the path, not the body.

### 11.8 Database access

- **`getDb()` from `src/lib/db/client.ts` is the only entry point.** It is
  lazy (nothing connects or throws at import time), caches the connection
  promise on `globalThis` so hot reload cannot leak pools, and **evicts a
  failed connection so the next call retries** — otherwise starting `next dev`
  before `docker compose up` poisons the process until restart.
  `closeMongoClient()` exists for test teardown and one-shot scripts.
- Zod validates at the **boundary** (forms, route handlers, search params).
  Repositories may trust already-parsed data internally; do not re-parse every
  document on every read in a hot path.
- **Vitest loads `.env.local`** via `loadEnv` in `vitest.config.mts`, so
  repository integration tests get `MONGODB_URI` without a manual env prefix.
  They do need a running `docker compose up -d`; tests that must stay hermetic
  should point at a dead port instead (see `src/lib/db/client.test.ts`).
- **Indexes are the repositories' job, and no feature has created them yet.**
  Whoever lands the seed/data layer owns: a unique index on `products.slug`, a
  unique index on `categories.slug`, the `$text` index over
  product title/brand/category (§2), and an index on `carts.cartId`.

### 11.9 Presentation shell

- **The storefront is light-theme only.** It does not follow the OS colour
  scheme. The scaffold originally carried create-next-app's
  `prefers-color-scheme: dark` block, which rendered `text-slate-900` content on
  a `#0a0a0a` body for dark-mode users; it has been removed.
- App-level element styles go in **`@layer base`** so Tailwind utilities can
  still override them. Colour comes from utilities on the element, never from a
  global unlayered `body` rule — unlayered CSS outranks everything in
  `@layer utilities`, which is how the bug above hid in plain sight.
- Fonts are Geist / Geist Mono via `next/font`, wired through `--font-sans` /
  `--font-mono`.
- Route components type their own props (`{ children: ReactNode }`) rather than
  using Next's generated `LayoutProps`/`PageProps` globals: those only exist
  after `.next/types` has been emitted, so a fresh clone running
  `tsc --noEmit` before its first build would fail.

### 11.10 Seed data & indexes (feature 2)

- **`ensureIndexes(db)`** lives at `src/lib/db/indexes.ts`, is idempotent
  (`createIndex` no-ops on an unchanged spec), and is called by both the seed
  script and — per §11.8 — should be called by feature 3's data layer on
  startup.
- **The `products` text index is `{ title, brand, description }`**, weighted
  10/5/1, not `{ title, brand, category }` as §11.8's one-line note said.
  There is no free-text "category" field on `Product` — only `categorySlug`,
  a slug, which a text index over would be useless (slugs aren't prose). This
  feature's own brief was explicit and detailed about title/brand/description;
  §11.8's mention predates this feature and is superseded by this entry.
- **`products.categorySlug` + `products.isActive` is one compound index**,
  not two single-field indexes: the PLP's real query filters by both at once
  (active products in one category), and the compound index still serves a
  `categorySlug`-only query as a prefix.
- **Seed placeholder images are composed as SVG but written to disk as
  `.webp`, never `.svg`.** `imagePathSchema` only accepts
  `webp|png|jpg|jpeg|avif`, and `product.test.ts`'s existing "a non-image
  extension" case explicitly asserts `/products/uploads/payload.svg` is
  *rejected* — that test predates this feature and must keep passing, so the
  schema was correctly left untouched. `lib/seed/svg.ts` builds an SVG string
  (gradient background, wrapped title, index badge) purely in memory;
  `lib/seed/images.ts` rasterizes it with `sharp` and writes the `.webp`
  result. The SVG string itself is never written to disk — only its
  well-formedness (escaping, structure) is unit-tested.
- **`_id` for every seeded document is deterministic**, derived from its
  natural key via `deterministicHexId(namespace, naturalKey)`
  (`lib/seed/ids.ts`, an MD5-derived 24-hex string — no security property
  needed, only stability). The seed script upserts on that `_id`
  (`replaceOne({ _id }, doc, { upsert: true })`), which is what makes
  `npm run seed` idempotent without a read-before-write.
- **Changing what `generateProducts()`/`generateCategories()` emit (title
  text, a slug-affecting field) is NOT idempotent against an existing
  database or `public/products/seed/` — only re-running the *same* generator
  is.** A product's `_id` and image filenames are derived from its slug
  (`deterministicHexId("product", slug)`), which is derived from its title.
  Change the title text and you get a *new* `_id`/slug upserted alongside the
  *old* one, which the old `_id` still occupies — the collection now has more
  than 300 documents, and the image directory carries orphaned files for
  slugs nothing references anymore. If you ever change seed data generation,
  you must: `docker exec nextcart-mongo mongosh nextcart --eval
  "db.dropDatabase()"`, remove orphaned files under
  `public/products/seed/` (diff the on-disk filename list against the image
  paths actually referenced by a fresh `npm run seed` run), then reseed.
  `npm run seed` run twice in a row with *no* generator change is exactly the
  idempotency the seed script promises; it does not cover regenerating the
  data itself.
- **Title uniqueness is enforced past exact-string collisions.**
  `generateProducts()` retries a colliding title (bounded, 30 attempts, using
  the same `SeededRng` so it stays deterministic) against a **bag-of-words
  fingerprint** (`titleFingerprint()` in `generate.ts`, exported for reuse) —
  not just the raw string — because MongoDB text search, `slugify()`, and a
  shopper's eye all treat "Moonlight and Dust" / "Dust and Moonlight" as the
  same title even though they're different strings. A fixed-word-order title
  (every non-book product is always `brand [adjective] noun [suffix]`) can
  never collide on the fingerprint without also colliding on the exact
  string, so this is a strict superset of plain dedup, not a separate,
  riskier check. If a future feature adds a product line whose title-word
  pool is small enough that 30 retries can't find a unique fingerprint,
  `generateProducts()` throws — treat that as "the pool is too small," not as
  a bug to catch and ignore.
- **`ProductLineTemplate` (categories.ts) carries three more knobs beyond
  price/variant policy, all consumed in `generate.ts`:** `plural` (agrees the
  description's verb and head determiner — "is"→"are", "This"→"These" — via
  `agreeTemplateForPlural`/`agreeSentenceForPlural`; set it on any noun that
  reads as more than one item — "wireless earbuds", "chino pants", "floor
  mats" — never on a singular collective like "car seat cover pair"),
  `sizeScale: "footwear"` (draws `FOOTWEAR_SIZES`, numeric US sizes, instead
  of `CLOTHING_SIZES`'s S/M/L/XL — set on any shoe/boot/sneaker line), and
  `colours` (overrides the shared `COLOUR_PALETTE` — used by
  `COSMETIC_SHADES` for lipstick/nail-polish lines, where "Forest Green" and
  "Midnight Black" are not real shades). `CategoryTemplate.closingFragments`
  similarly overrides the generic `CLOSING_FRAGMENTS` pool (which talks about
  warranties — nonsense on food or a book); Grocery and Books each supply
  their own. **A product line's `adjectives` must never share a word with its
  own `noun`** — `composeProductTitle()` filters out any adjective that does,
  because the combination reads as a doubled word ("True Wireless Wireless
  Earbuds"); this was a live bug in the electronics category, not a
  hypothetical.
- **Placeholder image directory (`public/products/seed/`): 910 files, ~9.3
  MB total, verified.** Fine to keep committed as-is; if a future feature
  changes `IMAGES_PER_PRODUCT` or adds products, watch this number — the
  images are placeholder gradients (see `lib/seed/svg.ts`), not judge-facing
  photography, so there is no quality reason for it to grow much larger than
  this.
- **A product title containing `&`, `"`, `'`, and non-ASCII characters is
  safe end-to-end**: `slugify()` (NFKD-normalizes then strips to `a-z0-9-`)
  keeps the resulting slug/image-path pure ASCII regardless of what's in the
  title, and `escapeXml()` in `lib/seed/svg.ts` correctly escapes the XML
  entities in the SVG that gets rasterized to the placeholder image — the raw
  title (special characters included) only ever reaches the SVG's text
  content, never a filesystem path. Verified directly against
  `Tom & Jerry's "Café" Édition`.
- **`ensureIndexes(db)` verified idempotent against real MongoDB**: called by
  two consecutive `npm run seed` runs with no error, and the full index set
  is present afterward — unique on `products.slug`/`categories.slug`, the
  weighted `{title,brand,description}` text index on `products`, the
  `products.categorySlug + isActive` compound index, plus unique natural-key
  indexes on `carts.cartId`, `orders.orderNumber`, `users.email` (the latter
  two ahead of the features that populate those collections).

### 11.11 Repositories (feature 3)

`src/lib/db/repositories/` is the only place `lib/db/client.ts` is imported
outside `scripts/seed.ts` and the tests below. Pages, route handlers and
server actions must import from here, never from `mongodb` or `db/client.ts`
directly — see §10.

- **Serialization convention — this is the answer to HARD REQUIREMENT 1.**
  A repository document's own `_id` is stored in Mongo as a real `ObjectId`
  (exactly as `scripts/seed.ts` already does); every other id-shaped field
  the schemas declare (`cartItem.productId`, `order.userId`, …) is stored as
  the plain hex **string** the schema already validates it as — there is no
  round-trip `ObjectId` conversion for those, since nothing ever joins on
  them inside the driver, only compares them for equality. Every repository
  read converts the document's `_id` to a string, then validates the whole
  document through the collection's Zod schema (`z.date()` fields still want
  a real `Date` at this step — that's what's actually stored). Only *after*
  that validation does a second step convert every `Date` to an ISO-8601
  string, producing the `XDTO` type each function actually returns
  (`ProductDTO`, `CartDTO`/`CartWithTotals`, `OrderDTO`; `CategoryDTO` and
  `UserDTO` are plain aliases for `Category`/`User` since neither schema has
  a `Date` field). No repository function ever returns an `ObjectId` or
  `Date` instance — every repository test file asserts this with
  `assertJsonSafe()` (`lib/db/repositories/test-helpers.ts`).
- **Validate on read, not just on write** (HARD REQUIREMENT 2): every mapper
  (`mapProductDoc`, `mapCategoryDoc`, …) runs the raw Mongo document through
  the schema's `.parse()`, not just `.safeParse()`-and-trust — a document
  that has drifted from the schema throws instead of silently serving bad
  data. Writes validate too (`productInputSchema`/`orderInputSchema.parse()`
  before every insert/update).
- **`getReadyDb()`** (`repositories/shared.ts`) wraps `getDb()` with a
  process-cached, failure-evicted call to `ensureIndexes()` — §11.8/§11.10
  say the data layer should call it on startup, and this is that call, made
  exactly once per process rather than once per query. Every repository
  function uses `getReadyDb()`, never `getDb()` directly.
- **Pagination**: `PAGE_SIZE = 24` (§2). `PaginatedResult<T> = { items, total,
  page, totalPages }`. `totalPages = Math.ceil(total / PAGE_SIZE)`, which is
  `0` for an empty result set, not `1`. `page` is the caller's requested page
  (clamped only to a positive integer, e.g. `0`/negative/NaN → `1`) — asking
  for a page past the end is not an error, it is Mongo's `skip()` naturally
  returning `items: []` while `total`/`totalPages` still describe the whole
  set.
- **Sorting** (`ProductSortOption`): every sort appends `_id` as a tiebreaker
  (`price: 1, _id: 1`, etc.) so that ties (two products at the same price)
  don't reorder between page 1 and page 2 of the same query — without this,
  pagination across a tied sort key can silently duplicate or skip a
  product. **`relevance` on the PLP (`listProductsByCategory`) explicitly
  falls back to `newest`** (`createdAt` desc): there is no `$text` query on
  a category listing to rank against, so "relevance" is meaningless there,
  and rather than error or silently do something else, it is defined to mean
  the same thing as not sorting at all. `relevance` only ever means
  `{ $meta: "textScore" }` inside `searchProducts` (and `listProductsForAdmin`
  when a `query` is given), where a real `$text` query exists.
- **`searchProducts("")`** (empty/whitespace query) short-circuits to an
  empty `PaginatedResult` *before* touching Mongo — `$text: { $search: "" }`
  is a query-shape error, not a legitimate zero-result search, and must
  never reach the driver.
- **Cart totals are never persisted** — `Cart` (the schema) has no
  `subtotal`/`total` field, deliberately (§11.5 predates this feature and
  didn't need one). Every `carts.ts` function that returns a cart computes
  `subtotal` fresh via `cartSubtotal(items)` on the way out
  (`CartWithTotals = CartDTO & { subtotal: number }`) — this *is* "recompute
  on every mutation, never trust a client total": there is no stored total
  to go stale, and no path returns anything but a freshly-derived one.
- **Cart line identity is `(productId, variantSelection)`**, compared by
  value (key/value equality, not reference or JSON-string — variant
  selections have no fixed key order). Adding the same product with the same
  selection increments the existing line's quantity, clamped at
  `MAX_LINE_QUANTITY` (99) rather than erroring; a different selection
  (including "no selection" vs. "a selection") is always a new line.
  Incrementing an existing line **keeps its original `price`/`title`/
  `imagePath` snapshot** — a repeat add never silently changes what the
  shopper already agreed to pay for the units already in the cart.
  `updateCartItemQuantity` sets a quantity outright and rejects (throws,
  via `quantitySchema.parse`) anything outside 1..99; use `removeCartItem`
  to go to zero.
- **`createOrder`'s input is narrower than `orderInputSchema`**: callers
  never supply `orderNumber`, `subtotal`, `total`, or `status` — the
  repository generates the order number (`RK-YYYYMMDD-XXXXXX`, retried with
  a numeric suffix on the rare unique-index collision, up to 5 attempts),
  computes `subtotal`/`total` from `items`/`shipping` via `cartSubtotal()`
  (never from anything the caller passed), and defaults `status` to
  `"placed"` and `paymentMethod` to `"cod"`. The assembled document is still
  run through `orderInputSchema.parse()` before insert — the totals
  refinement re-checks arithmetic this function just did, as a write-boundary
  guard against a future bug in this function, not a formality.
- **Repository tests run against the real seeded Mongo** (`docker compose up`
  required, same as `npm run seed`), not a mock. They never touch the seeded
  300 products / 10 categories / 6 users: product/category fixtures use
  slugs prefixed `repo-test-` (deleted by regex in `afterAll`), cart fixtures
  use `cartId`s prefixed `repo-test-cart-` (deleted by exact list in
  `afterAll`), and order fixtures are deleted by the exact `_id`s each test
  created. `categories.test.ts`/`users.test.ts` are read-only against the
  seeded data (nothing to clean up: `users.ts` has no write functions, and
  `categories.ts` isn't written to by this feature either).

### 11.12 Repositories verified (feature 3 independent audit)

Mutation-tested and attacked independently after `566d680`. Findings:

- **`getProductById(id)` was missing and has been added to
  `products.ts`.** The admin edit route is `/admin/products/[id]/edit`
  (§4) — it needs to load a product **by id, including an inactive one**,
  to prefill the edit form. `getProductBySlug` can never serve this: it is
  slug-keyed and always filters `isActive: true`, so a deactivated
  product's own edit page (reachable from `/admin/products` list, where
  inactive products are visible) had no repository call that could load it.
  `listProductsForAdmin` is a paginated list, not a single-item lookup.
  `getProductById` mirrors `getUserById`'s convention: `tryToObjectId`,
  returns `null` (not a throw) for a malformed id, and does **not** filter
  by `isActive` — same as `listProductsForAdmin`'s admin-sees-everything
  default. Covered by 5 new tests in `products.test.ts` (active, inactive,
  nonexistent id, malformed id, `assertJsonSafe`).
- **Explicit `undefined` in a `variantSelection` value throws, rather than
  behaving like an absent key.** `{ size: "M", colour: undefined }` fails
  `cartItemSchema.parse()` (Zod's `partialRecord` requires a present key to
  satisfy the value schema; `undefined` is not a valid string) while
  `{ size: "M" }` succeeds identically to it being absent. This is
  pre-existing schema behavior from `schemas/cart.ts` (feature 1, out of
  this audit's scope to re-litigate) and is defensible fail-fast strictness,
  not corrected here — but it is a footgun for whichever of features 6/7
  builds the cart UI: **never spread an object that may carry an explicit
  `undefined` value into `variantSelection`; omit the key instead** (e.g.
  build the object conditionally, don't do
  `{ size: form.size, colour: form.colour }` when `form.colour` can be
  `undefined`).
- **Everything else attacked held.** Independently mutation-tested against
  the real seeded Mongo (each mutation confirmed RED, then reverted): the
  storefront `isActive` filter, the admin `isActive` filter, variant line
  identity in `addCartItem`, the 99 quantity cap, `cartSubtotal`'s per-line
  summation, the pagination `skip()` calculation, and `Date`/`ObjectId`
  leaking past a DTO boundary — all seven caught by the existing suite, no
  broken (false-green) tests found. Also independently verified and
  confirmed correct, not just claimed: `variantSelectionsEqual` merges
  `{size,colour}` and `{colour,size}` (different key insertion order) into
  one line; `price-asc`/`price-desc` sort numerically in MongoDB, not
  lexically (verified against prices of differing digit lengths: 9, 90,
  900, 1000 sort correctly); pagination garbage input (`0`, negative,
  `NaN`, `Infinity`, non-integer, `undefined`) all clamp to page 1 or floor
  as documented; `$text` search tolerates regex metacharacters, a 10,000-
  character query, and a literal `"$where"` string without throwing or any
  operator-injection risk (search input is only ever a filter *value*,
  never a key, so there is no NoSQL injection surface here); and
  `createOrder`'s retry-on-collision is genuinely bounded — forcing all 5
  candidate order numbers to collide (mocked `Math.random`, pre-occupied
  every `attempt` 0..4 candidate) makes it throw in well under a second,
  not spin forever.

### 11.13 Cart, mock login, checkout (features 7+8)

**Session/auth helper — feature 9's `/admin/*` pages should use this:**

- `src/lib/session/auth.ts` exports `getSession()` (returns
  `{ userId, role } | null`), `setSession(payload)`, `clearSession()` (all
  three: Server Components/Actions/Route Handlers only — they wrap
  `next/headers` `cookies()`), and `getCurrentUser()` (re-validates the
  session against `getUserById`, returns the full `UserDTO | null`). Feature
  9's admin *pages* (not the gate itself — see below) should call
  `getCurrentUser()` or `getSession()` from a Server Component the same way
  `Header`/`/login` do, to know who's signed in and render accordingly.
- The httpOnly session cookie (`nextcart_session`, name exported as
  `SESSION_COOKIE_NAME`) holds `{ userId, role }` as base64url-encoded JSON
  — **not just a user id.** This is deliberate: `role` is needed by
  `src/middleware.ts` to gate `/admin/*`, and middleware runs on the Edge
  runtime, which cannot load the `mongodb` driver to look the role up. The
  codec (`src/lib/session/cookie.ts`, `encodeSessionCookie`/
  `decodeSessionCookie`) is pure — no `next/headers`, no DB import — so it
  is safe to import from both `middleware.ts` (edge) and `lib/session/
  auth.ts` (Node). `decodeSessionCookie` never throws; a missing, malformed,
  or hand-edited cookie decodes to `null`.
- **Known limitation, explicitly accepted per §5 ("no passwords, no real
  credentials"):** the cookie is not signed or encrypted, only httpOnly. A
  user who edits their own cookie value client-side (devtools, curl) could
  claim `role: "admin"`. There is no session table and nothing else to
  check it against. If this is ever a real concern, sign the cookie (e.g.
  HMAC the payload) before feature 9 ships — `encodeSessionCookie`/
  `decodeSessionCookie` are the one place to add it.
- **`/admin/*` gate**: `src/middleware.ts`, `matcher: ["/admin/:path*"]`.
  Redirects to `/login?next=<attempted path>` when there is no session or
  `role !== "admin"`. Feature 9 does not need to write its own gate — every
  route under `/admin/` is already covered by the matcher. `loginAction`
  already honours `?next=` (redirects there after a successful login,
  same-origin paths only) so "sign in as the admin from the gate's
  redirect" round-trips correctly.

**Cart cookie:**

- `src/lib/session/cart.ts`: `CART_COOKIE_NAME = "nextcart_cart_id"`,
  holding a random `randomUUID()`, httpOnly. `readCartId()` (read-only,
  never creates) vs. `ensureCartId()` (Server Actions only — creates on
  first call). Every page that merely *views* the cart (the cart page, the
  checkout pages, the header's item-count badge) uses `readCartId()`; only
  `addToCartAction` (`src/app/p/actions.ts`) calls `ensureCartId()`, so the
  cookie is minted exactly once, on the first add-to-cart, never on a page
  view.

**Login/cart merge rule:** signing in does **not** touch the cart cookie at
all, and that omission *is* the merge rule. `Cart` (the locked schema) has
no `userId` field — a cart is identified solely by its httpOnly cookie,
independent of who (if anyone) is signed in. So there is never a second,
separate "this user's cart" to merge into: the anonymous cart already *is*
what becomes the signed-in shopper's cart, because it's the same cookie
before and after `loginAction` runs. Verified live: added an item as a
guest, logged in, and the cart still showed the same line (see the DONE
section's manual walkthrough).

**Checkout state — new collection, not an extension of `Cart`:**

- `src/lib/schemas/checkout.ts` (`checkoutStateSchema`) and
  `src/lib/db/repositories/checkoutState.ts` are a **new** schema/
  repository pair, added rather than editing the locked `cart.ts`/`carts.ts`
  — the task brief allowed "extend the cart document," but `Cart`'s Zod
  schema (non-strict) would silently strip any extra fields on every read,
  and editing the locked schema file was out of scope. A separate
  `checkoutStates` collection (one doc per `cartId`, unique index added in
  `lib/db/indexes.ts`) holds `{ cartId, address?, deliveryMethod?,
  orderClaimed }`, filled in one field at a time across steps 1–2 and read
  back for guarding/review/order placement.
- **Step guard** (`src/lib/checkout/guard.ts`, `requiredStepFor`): `delivery`
  requires an address; `payment` and `review` require both an address and a
  delivery method. `/checkout/[step]/page.tsx` redirects to `/cart` first if
  the cart is empty (for all 4 steps), then to the earliest missing step —
  a deep link to `/checkout/review` with nothing filled in lands on
  `/checkout/address`, never a half-rendered review page.
- **Delivery pricing** (`src/lib/checkout/delivery.ts`,
  `DELIVERY_OPTIONS`): `standard` = free, `express` = 999 minor units
  ($9.99). The cart page shows an *estimate* using the standard rate before
  checkout is entered (no delivery method is chosen yet at that point); the
  real cost is locked in at checkout step 2 and is what `createOrder`
  actually uses.
- **Double-submit guard**: `claimCheckoutForOrder(cartId)`
  (`checkoutState.ts`) atomically flips `orderClaimed` from
  falsy→`true` via a single `findOneAndUpdate` filtered on
  `orderClaimed: { $ne: true }` — only one concurrent `placeOrderAction`
  call can win it. The loser (and any later refresh/replay once the cart is
  already empty) redirects to `/cart` instead of calling `createOrder`
  again. `placeOrderAction` clears both the cart and the checkout state
  document after a successful order, so `/cart` is never a broken page for
  the loser — by the time it renders, the winner has usually already
  emptied it too.
- **Success page** (`/checkout/success`) takes the order number from
  `?order=` in the URL and always re-reads it via `getOrderByNumber` —
  no reliance on cart/checkout state, which are gone by the time this page
  renders anyway. Missing or unknown order numbers redirect home, never
  500.

**Manual walkthrough performed for the DONE section** (real browser via
Claude in Chrome, not just automated tests): added a variant product to
cart twice (same colour → incremented to qty 2, one line, confirmed
server-recomputed subtotal), viewed `/cart`, logged in as a customer
(cart line survived login unchanged), completed all 4 checkout steps with
express delivery, placed the order, landed on `/checkout/success` with the
real order number in the URL, re-navigated to that exact URL (simulating a
refresh) and got an identical render, and confirmed via `mongosh` that the
order document, its totals, and its `userId` were written correctly, the
cart and checkout-state documents were cleared, and the 300/10/6 catalog
was untouched. Also confirmed live: a signed-in customer hitting
`/admin/products` is redirected to `/login?next=/admin/products`, and
signing in as the admin from that page's list correctly returns to
`/admin/products` (which then 404s only because feature 9 hasn't built
that page yet — the gate itself worked).

### 11.15 Promo codes & notifications (post-launch features)

Landed after all 9 original features and the `58e1a52` verification pass.
Two independent additions:

**Promo codes — the first deliberate change to a previously-locked
contract.** §11.6 said `Order` totals are schema-enforced as
`total === subtotal + shipping` and explicitly "there is no discount field;
add one here first if it is ever needed." That is exactly what happened:
`schemas/order.ts`'s `orderSchema`/`orderInputSchema` now widen the
invariant to `total === max(0, subtotal + shipping - discount)`
(`computeOrderTotal`, exported from `schemas/order.ts` so the repository
and every UI total agree on the exact same formula), and add `discount`
(integer minor units, defaults 0) and `promoCode` (optional string). The
`subtotal === Σ(price × quantity)` half of the invariant is untouched.
`discount` defaults to 0, so every pre-existing order document and every
pre-existing test that never mentions a discount still validates
identically to before — this is a strict widening, not a breaking change.
`total` is clamped at 0; `discount` itself is not clamped to
`subtotal + shipping` (a fixed-value code can legitimately exceed it — the
clamp on `total` is what stops a negative total/implied refund, per the
brief).

`Cart` (`schemas/cart.ts`) also gained one optional field: `promoCode`
(the applied code's string only — never a discount amount, never the promo
document). This is the second, much smaller edit to a locked schema; it was
explicitly pre-approved by the brief the same way `checkoutStates` (§11.13)
was allowed to be a *new* collection rather than a cart-schema edit, except
here the brief specifically asked for the cart-schema edit instead.

A discount is **never persisted anywhere except the final `Order` document.**
The cart only remembers *which code* was applied; `src/lib/promo/validate.ts`
(pure) and `src/lib/promo/lookup.ts` (the async DB-touching wrapper,
`getCartPromoState`) recompute the actual discount fresh from the promo
document and the cart's current `subtotal` on every read — the cart page,
the checkout review step, and `placeOrderAction` all call the same function
rather than trusting a previous computation. `placeOrderAction` re-validates
one more time immediately before `createOrder`; an applied code that has
gone invalid in the meantime (expired, deactivated, `maxUses` hit) is
dropped from the cart (`removeCartPromoCode`) and the shopper is bounced
back to `/cart?promoRemoved=1` with an explanation, rather than either
silently honouring it or silently charging full price without saying so.
`incrementPromoUse` is called exactly once, from `placeOrderAction`, only
after `createOrder` has actually succeeded — applying a code to a cart that
never checks out never consumes a use.

Percent discounts are computed against `subtotal` only (never `shipping`)
and rounded **down** to the nearest minor unit (`computePromoDiscount` in
`lib/promo/validate.ts`) — the rounding direction is in the store's favour
and applied in exactly one place, so the cart page, the review step and the
placed order can never disagree by a cent.

New collection `promoCodes` (`schemas/promoCode.ts`,
`repositories/promoCodes.ts`), unique index on `code` (always normalized to
uppercase before it's stored or queried). `/admin/promo-codes` (list +
create + active toggle) sits behind the existing `/admin/*` middleware
matcher — no new gate was needed, `src/middleware.ts`'s `matcher:
["/admin/:path*"]` already covers it.

**Notifications — a new collection, no contract change.**
`schemas/notification.ts` / `repositories/notifications.ts`. Read from the
database on page render only — the Header's bell badge
(`countUnreadForUser`) and `/notifications` are both computed fresh on
every request; per §0 there is no WebSocket/SSE/polling anywhere in this
feature. `markNotificationRead`/`markAllReadForUser` are always called with
`session.userId` from `getSession()` (`src/app/notifications/actions.ts`),
never a client-supplied id — verified specifically: the repository query
filters on `{_id, userId}` together, so a signed-in user requesting another
user's notification id gets exactly the same `null` result as a
nonexistent id (no enumeration signal either way). `/admin/notifications`
sends one document per selected recipient via `createNotifications`
(recipients are checkboxes over `listMockUsers()`, still re-validated as
well-formed ObjectId strings server-side before any write) and shows a
"Sent to N recipients" confirmation plus a recently-sent list grouped by
(title, exact shared `createdAt`) — a bonus, not required.

### 11.16 Logout empties the cart

Signing out calls `clearCart(cartId)` and then `clearCartCookie()`, so a
signed-out visitor always sees an empty cart and a zero header badge.

This is a deliberate narrowing of §11.13. Signing *in* still never touches the
cart cookie — that is what makes an anonymous cart carry into a session with
nothing to merge. Signing *out* is now the exception.

The cart document is emptied as well as orphaned. Dropping only the cookie
would leave a populated cart reachable by anyone who later presented that id;
emptying it first means the id is worthless even if it leaks.

A signed-out visitor can still browse and add to cart — doing so mints a new
cart id. Carts are not gated on login (that option was considered and
rejected, because it would block the anonymous-shopper flow).
