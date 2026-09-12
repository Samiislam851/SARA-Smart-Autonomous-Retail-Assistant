# storefront (NextCart)

This directory is reserved for NextCart — a real Next.js 15 + MongoDB store
(home, category, product, search, cart, 4-step checkout, policies, mock
login, admin; 300 products across 10 categories) — built independently and
merged in here as a second real storefront running SARA, alongside
`demo-store/`.

It is intentionally empty in this snapshot: NextCart is under active,
separate development and gets merged into this path once ready. See
[`docs/NEXTCART.md`](../docs/NEXTCART.md) for the integration runbook
(ports, cart bridge, `data-agent-target` vocabulary mapping, gaps, and
verification steps) covering how the agent embeds into it.
