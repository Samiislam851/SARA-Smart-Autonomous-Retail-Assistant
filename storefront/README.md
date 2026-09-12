# NextCart storefront

Next.js 15 + MongoDB demo store, ~300 seeded products, promo codes, full
cart/checkout flow. Second storefront target for the shopping agent in
`../agent`, embedded via a `data-agent-target` attribute contract instead of
`../demo-store`'s DOM scanning.

## Run

Mongo, either:
- `docker compose up -d mongo` (repo root `docker-compose.yml`), or
- rely on `mongodb-memory-server` if configured for local dev (check
  `src/lib/db` for the connection helper in use).

Then:

```
npm install
npm run seed   # loads ~300 products into MONGODB_URI
PORT=3801 npm run dev
```

Copy `.env.example` to `.env.local` first (`MONGODB_URI`, `SESSION_SECRET`,
`NEXT_PUBLIC_AGENT_URL`).

## Agent embed

`src/app/layout.tsx` loads the agent widget script, pointed at the agent
server via `NEXT_PUBLIC_AGENT_URL` (default `http://localhost:4000`):

```html
<script src="http://localhost:4000/agent.js" data-site="nextcart" data-server="http://localhost:4000" async>
```

Instead of a heuristic DOM scan, key elements carry a `data-agent-target`
attribute the agent reads directly:

| data-agent-target | element |
|---|---|
| address-form | checkout address form |
| add-to-cart | add-to-cart button |
| begin-checkout | begin checkout button |
| cart-items | cart line items container |
| cart-link | header cart link |
| cart-total | cart total |
| checkout-total | checkout order total |
| id | product id marker |
| payment-options | checkout payment method selector |
| place-order | place-order button |
| policies-link | policies link |
| price | product price |
| product-title | product title |
| promo-code | promo code input/form |
| returns-policy | returns policy text/link |
| search-input | search box |
| shipping-info | shipping info block |
| shipping-policy | shipping policy text/link |
| size-picker | variant size picker |
| size-selector | variant selector |

## Import catalog into the agent

The agent needs NextCart's product/promo data in its own store format:

```
cd ../agent && node scripts/import-nextcart.mjs
```

This populates `../agent/store/nextcart/` (catalog/promos/policies) so the
agent can serve facts and offers for `data-site="nextcart"`.

## Note

The teammate's `agent-mock` prototype directory (if present elsewhere in this
repo) is untouched by this sync — this is the real storefront integration.
