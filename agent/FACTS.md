# Page facts — the page reads itself, zero wiring

`agent.js` extracts two representations of the page's own content and ships
them on `page_view.meta.facts` so the LLM decider can reason about pages that
carry none of the explicit `data-agent-*` hooks.

## What is extracted

- **keys** — normalized values, emitted only when confidently detected (a
  currency number found in the same leaf element, or within its parent /
  grandparent — "2 DOM hops" — of a label word):
  - `cart_total` — label words `total | subtotal | cart total | order total`
    (Bangla `মোট`). A plain `total`/`order total`/`cart total` match outranks
    a `subtotal`-only match when both are present.
  - `cart_count` — from `"Cart (2)"` or `"2 items"`.
  - `free_delivery_threshold` — a sentence containing `free` + `deliver(y)|shipping`
    + `over|above|on orders of` + a currency number.
  - `delivery_fee` — `delivery|shipping` + currency in the same element, when
    the free-delivery-threshold pattern above doesn't match (same-leaf only —
    unlike `cart_total`, `delivery_fee` does not currently hop to a sibling
    cell if the fee is split from its label; see Limits).
  - `stock` — `out_of_stock` (`"out of stock"`/`"sold out"`), `low_stock:N`
    (`"only N left"`), or `in_stock` (`"in stock"`).
  - `size_selected` — `"true"` / `"false"` when a group of >=3 short sibling
    `<button>`/`<label>` elements matching `S|M|L|XL|...|<number>` is found,
    based on `aria-pressed="true"`, `aria-checked="true"`, a `selected`/`active`
    class, or a checked nested `<input>`; key is omitted entirely (implicit
    "unknown") when no such group exists.
  - `price` — best-effort, largest currency number found near the first
    `<h1>`. No live font-size signal is available without a real browser
    layout pass, so this is a weaker heuristic than the others (see Limits).

  Currency parsing handles `৳ Tk TK BDT $ € £ ₹`, thousands separators, and
  Bangla digits (`০-৯` → ASCII), returning integers.

- **snippets** — up to 10 deduped, trimmed, <=120-char strings from elements
  whose text matches the label vocabulary (`delivery, shipping, total, stock,
  size, return, refund, coupon, discount, offer`). Elements inside `<nav>` /
  `<footer>` are excluded. Ordered by proximity to `<main>`/`<article>` first,
  then by length.

## Precedence — explicit attrs beat heuristics

- `cart_view` / `cart_update`: only emitted from facts when the page exposes
  **neither** `window.__agentCart` **nor** `[data-agent-cart-total]`. The
  moment either explicit source exists, the heuristic cart path is fully
  disabled — `agent.js`'s existing `readCart()` wins.
- When multiple candidate matches for the same key exist on a page (e.g. a
  footer repeating a different "free shipping" number than the real
  main-content threshold), a candidate inside `<main>`/`<article>` always
  outranks one inside `<nav>`/`<footer>`, which in turn outranks anything
  else — this is what keeps a footer's marketing copy from clobbering the
  real cart threshold.

## The two modes and the flag on both ends

- **Client** (`agent.js`): `<script ... data-facts="keys|snippets|both|off">`
  (default `both`). Controls what agent.js computes and puts on
  `page_view.meta.facts` in the first place. `window.AgentEmbed.facts()`
  returns the last computed `{keys, snippets}` for debugging;
  `window.AgentEmbed._extract` is the pure extractor function itself
  (`extractFactsFrom(root, helpers)`), used by the offline probe below.
- **Server** (`state.js`): `FACTS_MODE=keys|snippets|both|off` (default
  `both`) env var. Independently filters which half of the client-sent facts
  reaches `buildState().facts` — lets us run the same recorded traffic
  through different model-input shapes without touching any page.

Facts are recomputed after load (`requestIdleCallback`, else `setTimeout 0`)
and on DOM mutation (debounced 500ms), capped at 5,000 visited DOM nodes and
a ~5ms time budget per pass; a pass that exceeds either cap bails and returns
whatever was collected so far (partial results), it does not retry
synchronously. `page_view` is re-sent only when the computed facts change
(stable JSON compare).

## R&D recipe

Compare how well the model uses `keys` vs `snippets` vs `both` on the same
scripted story (`sessions/facts-threshold.json` — cart total and threshold
arrive ONLY via facts, no `cart_*` events):

```
AGENT_MODE=llm FACTS_MODE=keys    node index.js &   # run 1
node replay.js sessions/facts-threshold.json
curl -s localhost:4000/metrics | jq .              # note tokens/call, cache hit rate
kill %1

AGENT_MODE=llm FACTS_MODE=snippets node index.js &  # run 2, repeat
AGENT_MODE=llm FACTS_MODE=both     node index.js &  # run 3, repeat
```

For each run, record: replay.js's PASS/FAIL verdict against the fixture's
`expect`, tokens per decider call, and `GET /metrics`' cache-hit rate. `both`
is expected to win on PASS rate at a token-cost premium over `keys` alone;
`snippets` alone tests whether the model can extract the ৳ gap itself from
prose instead of being handed a parsed number.

### Status (2026-09-11)

`facts-threshold` now PASSES: re-recorded on the `codex` backend
(`gpt-6-astra`, ChatGPT login, ~06:50) after a `prompts/decide.md`
clarification (the `action.target` bullet now says a `message` targets the
element it's about, so the widget scrolls to it) —
`sessions/recorded/fx_facts_threshold.json` has 8 proposals, index 6 is
`message shipping-banner` (86% confidence, reasoning from the cart→
checkout→cart return plus the parsed ৳50 gap). Cached-mode replay of
`sessions/*.json` is 4/4. Earlier, the `claude` backend could not satisfy it
(model did not act on page facts alone) — kept here as R&D evidence: this
recording sent both `keys` and `snippets` together (`FACTS_MODE=both`, the
default), and the stronger model reasoned from the parsed `keys`, per the
recorded `hypothesis` text, with `snippets` present but not obviously load-
bearing. **Keys vs snippets is still open** — the recipe above (`keys` vs
`snippets` vs `both`, run separately) has not yet been run; that's the next
experiment, to find out whether `keys` alone is sufficient or `snippets`
materially helps/hurts.

## Known limits

- **iframes**: not traversed — content inside a same- or cross-origin
  `<iframe>` is invisible to the extractor.
- **Images**: prices/labels rendered as text-in-image (no DOM text node) are
  never seen; only real text content is read.
- **Currency ambiguity**: `$`/`Tk` alone (no other context) can't disambiguate
  BDT from USD or other `Tk`-adjacent currencies; the extractor returns the
  raw parsed integer with no currency-code field — callers assume the site's
  single stated currency.
- **`delivery_fee`** only matches when the fee and its label share one leaf
  element (no 2-hop search like `cart_total` gets) — a fee split across
  sibling cells is missed today.
- **`price`** has no real font-size signal outside a live browser layout
  pass; it is a best-effort "smallest nearby currency-only leaf near the
  first `<h1>`" heuristic, weaker than the other keys.
- **Text node cap (5,000) / 5ms budget**: extremely large or deeply nested
  pages can produce partial results if either cap is hit mid-pass; the next
  scheduled pass (idle callback or mutation-debounced) will retry from
  scratch, not resume. This budget is now shared across all three full-tree
  walks a facts pass can run (leaf walk, size-selection grouping, first-`<h1>`
  search) — previously each had its own (or no) cap.
- **Decimal vs. thousands separator**: `.`/`,` are disambiguated as follows —
  if a number contains both, the LAST one in the string is the decimal
  separator (e.g. `1.950,00` → 1950; `1,950.00` → 1950); if only one
  separator type appears exactly once, a lone `.` followed by exactly 3
  digits is treated as a thousands separator (`1.950` → 1950, not 1.95),
  any other lone `.` is a decimal point (`12.50` → ~13 after rounding), and
  a lone `,` defaults to a thousands separator (`1,950` → 1950); repeated
  occurrences of one separator type are always thousands grouping
  (`1,234,567` → 1234567). Ranges (`৳2,000–3,000`) are not specially
  parsed — the regex simply stops at the first non-digit/separator
  character, so the first number in the range is what's returned.
- **Promotional amounts excluded**: a currency match preceded (within 12
  characters) by `save`, `off`, or `discount` is treated as a markdown/promo
  figure and discarded (returns no value) rather than being misread as a
  total/price/fee — e.g. `Save ৳500` near a product `<h1>` no longer gets
  picked up as `price`.
