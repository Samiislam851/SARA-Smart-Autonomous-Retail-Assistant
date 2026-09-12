# Behavior Signal Matrix

Research base for the agent's signal vocabulary. Existing system (as of this doc):
events emitted by `agent.js` = page_view, dwell (page+element), scroll_depth, rage_click,
cart_view, cart_update, search, back_nav, agent_outcome. `gate.js` rules 1-8 = element
attention dwell, return-visit attention, nav friction (back_nav/cart↔checkout bounce),
rage click, free-delivery-gap dwell, cart/checkout dwell floor, search friction, promo-missed
dwell. Rules 9-12 = product ping-pong, breadth-no-cart, cart-leave-no-checkout, return-after-cart.
Plus consult floor / page-moment / cost-cap. Templates: size_help, missed_discount,
auto_discount_active, similar_on_promo, delivery_gap, cart_under_threshold, checkout_bounce,
search_help.

## 1. Signal matrix

| Signal | Detection (browser) | Page(s) | Intent/friction hypothesis | Suggested response | Threshold (source) | Priority | Status |
|---|---|---|---|---|---|---|---|
| Exit intent (mouse to top edge) | `mousemove` with `clientY<=0` moving upward, desktop only | any | about to close tab/leave | last-chance card (discount/cart reminder) | fire once/session, only if cart non-empty or high-attention product — heuristic, widely used pattern [Claspo, Quikly] | P0 | new |
| Exit intent (tab blur / visibilitychange) | `document.visibilitychange`→hidden or `window.blur` | any | switching tab/app, comparison shopping | none immediately; log as trajectory signal, react on return | heuristic | P1 | new |
| Idle / inactivity | no input (mouse/scroll/key) for N ms while page open | any | distracted, reading elsewhere, or genuinely done | gentle nudge only if mid-funnel (cart/checkout) | 30-60s heuristic; don't fire on PDP idle alone | P1 | new |
| Scroll depth milestones | `scroll_depth` at 25/50/75/100% | PDP, listing | reached reviews/specs/footer | gate off low-value cards below fold; unlock review-dwell logic | existing thresholds | P0 | exists |
| Scroll-back / U-turn | scroll down then back up past a section, or fast down+up within Ns | PDP, listing | lost, re-checking something (price, size chart) | none by default; combine with dwell-on-return | Hotjar U-turn concept — heuristic mapping to scroll [Hotjar/Browsee] | P2 | new |
| Dead click | click on non-interactive element or element with no handler response | any | confusion, expects action that doesn't exist | none (dev signal); optionally treat as generic-friction proxy | Hotjar/Browsee definition | P2 | new |
| Rage click | ≥3 clicks same target within short window | any | frustration / broken UI / impatience with response time | de-escalate: surface size_help or checkout_bounce type message | existing: RAGE_CLICK_WINDOW_MS 30s, count-based [Hotjar] | P0 | exists |
| Price hover / dwell | `mouseenter`/dwell timer on price element ≥ Xms, or repeated hover | PDP, listing | price sensitivity, considering discount need | missed_discount / similar_on_promo if available | heuristic ~2-3s, no direct source | P1 | new |
| Image zoom / gallery cycling | zoom trigger events, thumbnail click count ≥N in session | PDP | high engagement, evaluating fit/appearance, close to buy | none/positive signal only — raises priority for other cards, doesn't itself trigger one | zoom/360 correlates with time-on-page & add-to-cart [CXL] | P1 | new |
| Size/variant churn | ≥2 variant/size selector changes without add-to-cart | PDP | uncertain about fit, wants guidance | size_help card | heuristic: 2 switches | P0 | partial (size_help template exists, no dedicated churn detector) |
| Add-to-cart hesitation (hover w/o click) | mouse dwell over ATC button ≥Xms without click | PDP | close to converting, something (price/shipping/size) is blocking | size_help / delivery_gap / missed_discount depending on other signals | heuristic ~1.5-2s hover | P0 | new |
| Review section dwell | element dwell on reviews/ratings block ≥ ELEMENT_ATTENTION_MS | PDP | seeking social proof before deciding | none proactive; suppress interruption while reading | reuse existing ELEMENT_ATTENTION_MS (4000ms) | P1 | partial (generic element dwell exists, not review-specific) |
| Shipping/returns info seek | click/dwell on shipping or returns accordion/tab | PDP, cart | logistics concern (returns window, delivery time) is the blocker | size_help (returns_window_days slot already exists) or delivery info card | heuristic | P1 | partial (returns_window_days slot exists in size_help) |
| Product ping-pong / comparison | same product page_view'd twice with another page between, within window | cross-page | comparing this product against alternatives | similar_on_promo or reassurance card | existing PING_PONG_WINDOW_MS 90s | P0 | exists |
| Browse breadth, no cart | ≥N distinct products viewed, zero add-to-cart all session | cross-page | undecided shopper, browsing without commitment | search_help or curated pick card | existing BREADTH_MIN_PRODUCTS (≥2, scaled) | P1 | exists |
| Listing filter/sort churn | ≥N filter/sort changes within window, no product click-through | listing | can't find what they want / low match confidence | search_help-style "let us help narrow it down" | heuristic: 2 changes/30s | P1 | new |
| Pagination depth, no click | ≥N page-forward events on listing/search results with 0 product opens | listing, search | low relevance in results, scanning exhaustively | search_help card | heuristic: page 3+ | P2 | new |
| Search refine chains | ≥2 consecutive `search` events with edited query, same session | search | first query didn't satisfy, iterating | search_help with top result surfaced | existing search event; SEARCH_FRICTION_WINDOW_MS 60s reusable | P0 | partial (search event + window exist, chain-detection logic not confirmed) |
| Search zero results | `search` event with `results:[]` or count 0 | search | dead end, high abandonment risk if unaddressed | search_help suggesting alternates/categories | zero-result pages drive near-total session abandonment if no guidance [Bloomreach, Wizzy] | P0 | partial (search event carries results, no zero-result branch confirmed) |
| Cart visit-and-leave | `cart_view` then navigation away within window, no checkout reached | cart | reviewing cart but not ready, may need reassurance (cost/shipping) | cart_under_threshold / delivery_gap / checkout_bounce | existing CART_LEAVE_WINDOW_MS 60s | P0 | exists |
| Cart quantity edits | `cart_update` with qty change (increase/decrease), esp. decrease to 0 | cart | reconsidering purchase, price-conscious | none proactive on increase; on decrease-to-remove, consider save-for-later style nudge | heuristic | P2 | new |
| Promo-field focus w/o code | focus/click on promo code input, no value entered, blur | cart, checkout | actively looking for a discount they don't have | missed_discount / auto_discount_active | existing PROMO_CART_DWELL_MS reuses CART_DWELL_MS as proxy; direct focus-event detection not confirmed | P0 | partial |
| Checkout step backtrack | back_nav or explicit "edit" click from later checkout step to earlier one | checkout | found an error or reconsidering (address/shipping/payment) | checkout_bounce card | existing NAV_FRICTION_WINDOW_MS (60s) covers back_nav generally | P1 | partial (generic nav friction exists, not step-specific) |
| Form field abandonment / validation errors | field blur with empty required value, or repeated invalid submit | checkout | confusion on a specific field, drop-off risk — Baymard: inline-on-blur validation lifts completion ~22% | checkout_bounce with targeted help, never interrupt mid-typing | Baymard checkout usability research | P0 | new |
| Long dwell on total/shipping line | element dwell ≥ ELEMENT_ATTENTION_MS on order-summary/shipping-cost row | cart, checkout | shipping cost sticker shock, primary abandonment driver per Baymard (cart abandonment ~70%, unexpected costs top reason) | delivery_gap / cart_under_threshold if close to free-shipping line | reuse ELEMENT_ATTENTION_MS | P0 | partial (generic element dwell covers it if target id captured) |
| Copy text (SKU/price) | `copy`/`selectionchange` event capturing price or SKU text | PDP | comparison shopping on another tab/site | none proactive; log as strong comparison-intent signal, raise priority of similar_on_promo | heuristic, no direct source | P2 | new |
| Returning visitor / return to same product | session/localStorage marks product seen in a prior session, revisited | PDP | high intent, was undecided, came back | lower attention thresholds (RETURN_VISIT_ATTENTION_MS), prioritize reassurance | existing RETURN_VISIT_ATTENTION_MS 2000ms | P1 | exists |
| Time-on-site / session depth, no commit | session duration ≥N min or ≥M page_views, 0 cart_update | cross-page | browsing without commitment — needs a nudge toward a decision | search_help or curated pick, low frequency | ties into consult floor / page-moment mechanism already present | P1 | partial (consult floor covers "still active" generally, not commitment-specific) |
| Mobile fast-scroll / thumb-zone taps | high scroll velocity (px/ms) or tap location clustering in bottom thumb zone | any (mobile) | mobile users scan faster, F-pattern less reliable, sticky bottom CTA more effective | prefer sticky/bottom-anchored card placement on mobile, not top-of-page | NN/g: sticky, in-thumb-zone CTAs perform better on mobile; no ms threshold in sources — heuristic | P2 | new |

## 2. Frequency & fatigue

Sources: web-push fatigue-detection guidance (consecutive-dismissal tracking), exit-intent
popup norms (never >1/session, no more than 1/24h/visitor), Dynamic Yield/Insider messaging docs
(event-triggered beats scheduled).

Concrete defaults for this agent:
- **Min gap between cards (any type):** ≥ existing `COOLDOWN_MS` (reuse, don't add a second
  timer) — treat as floor, not override, for all new signal types above.
- **Per-page cap:** 1 card per page view. A second card on the same page_view only if the
  first was dismissed/ignored and a materially different (higher-priority) signal fires.
- **Per-session cap:** 3-4 total non-noop actions/session — beyond that, fatigue outweighs
  marginal value (web-push literature: users who dismiss repeatedly are cooldown candidates,
  not re-target candidates).
- **Suppress-after-dismiss:** if a card type (e.g. `missed_discount`) is dismissed, don't
  re-show the *same template* again this session; a different template for a different signal
  is still allowed.
- **Suppress-after-turn_off:** `turn_off` outcome = hard stop, no further actions this session
  (already implied by OUTCOME_KINDS; make explicit as a policy rule if not already enforced).
- **Exit-intent specifically:** fire at most once per session, and only once per rolling 24h
  for a returning visitor (heuristic borrowed from exit-intent popup norms — sources note
  10-15% trigger rates and fatigue when overused).
- **Don't-interrupt moments (hard suppression, not just low priority):**
  - active typing in any form field (checkout address/payment, search box, promo code) —
    wait for blur before considering a card;
  - within Ns of a just-shown card still visible/animating;
  - immediately after a `cta` outcome (let the resulting action complete first);
  - mid checkout on the payment step specifically (highest-stakes field-abandonment risk per
    Baymard — a popup here is more likely to cause the exact abandonment it's trying to prevent).

## 3. Cross-page continuity

State that must persist across navigations (session-scoped, already partially covered by
`session.events` / `state`):
- **Last N page_views** (path + timestamp) — needed for ping-pong, breadth, and search-refine
  chain detection. N≈10-15 is enough given existing 60-90s windows.
- **Products viewed this session** (id, category, price, timestamp of first/last view) — for
  ping-pong, breadth-no-cart, comparison signals, and returning-visitor detection.
- **Cart deltas** (items added/removed, qty changes, running total) — for cart_update reasoning
  and shipping-threshold gap math (already reused by delivery_gap/cart_under_threshold).
- **Dismissed/shown card log this session** (template id, target, timestamp, outcome) — for the
  suppress-after-dismiss and per-session-cap rules above; already implied by `agent_outcome`
  but needs to be queryable by template id, not just action id.
- **Last action shown + outcome** — needed to enforce the "wait for outcome before next card"
  don't-interrupt rule.
- **Cross-session (localStorage) for returning-visitor logic:** product ids seen in a prior
  session, last-visit timestamp. Retention: 30 days heuristic (long enough to catch a
  multi-day consideration cycle typical of higher-consideration purchases, short enough that
  stale product data doesn't misfire).

## 4. Context the model should always get

Per-decision context fields (in addition to the triggering event/signal):
- **Page type** (PDP / listing / search / cart / checkout / home) — already classified via
  `classifyPath()`.
- **Product attributes**: price, available sizes/variants + stock per variant, category —
  needed for size_help, delivery_gap, similar_on_promo.
- **Cart contents + running total** — needed for cart_under_threshold, delivery_gap,
  checkout_bounce.
- **Active thresholds/promos**: free-shipping line, any live discount code, auto-discount
  state — needed so the model doesn't recommend a promo already applied or irrelevant.
- **Recent trajectory**: last N page_views (path+timestamp), ping-pong/breadth state — needed
  for comparison-shopping and undecided-browsing framing.
- **Time since last card shown + its outcome** — needed to respect cooldown/fatigue rules.
- **Session-level dismiss/turn_off log** — needed to avoid repeating a suppressed template.
- **Returning-visitor flag** (product seen before, session count) — needed to lower thresholds
  appropriately (existing RETURN_VISIT_ATTENTION_MS pattern).

## 5. Sources

- [Baymard — E-Commerce Cart & Checkout Usability Research](https://baymard.com/research/checkout-usability)
- [Baymard — Ecommerce Checkout UX Guide](https://baymard.com/learn/checkout-flow-ux-optimization)
- [Betaal Optimaal — Baymard's 14 years of checkout usability research unpacked](https://www.betaaloptimaal.nl/baymards-14-years-of-checkout-usability-research-unpacked/)
- [NN/g — Scrolling and Attention (Jakob Nielsen's Original Research Study)](https://www.nngroup.com/articles/scrolling-and-attention-original-research/)
- [NN/g — Scrolling topic hub](https://www.nngroup.com/topic/scrolling/)
- [Hotjar — How to Use Rage Clicks To Improve User Experience](https://www.hotjar.com/blog/rage-clicks/)
- [Browsee — Rage Clicks, Dead Clicks, Error Clicks, and Page Performance](https://browsee.io/blog/rage-clicks-dead-clicks-error-clicks-and-page-performance-understanding-user-frustration-and-how-to-track-it/)
- [CXL — How to Design Ecommerce Product Pages](https://cxl.com/ecommerce-best-practices/product-pages/)
- [CXL — Micro Conversions: Should You Optimize for Them?](https://cxl.com/blog/should-you-optimize-for-micro-conversions/)
- [Optimonk — What Are Micro Conversions, Why They Matter & 10 Examples](https://www.optimonk.com/micro-conversions)
- [Nature Scientific Reports — Shopper intent prediction from clickstream e-commerce data with minimal browsing information](https://www.nature.com/articles/s41598-020-73622-y)
- [arXiv — Analyzing and Predicting Purchase Intent in E-commerce](https://arxiv.org/pdf/2012.08777)
- [ScienceDirect — Will this session end with a purchase? Inferring current purchase intent of anonymous visitors](https://www.sciencedirect.com/science/article/abs/pii/S1567422319300134)
- [Wisepops — Cart Abandonment Popup: Playbook & Best Practices](https://wisepops.com/blog/cart-abandonment-popup)
- [Mastercard/Dynamic Yield — 6 Exit Intent Tactics to Reduce Cart Abandonment](https://www.mastercard.com/us/en/business/consumer-acquisition-and-engagement/personalization/dynamic-yield/learning-paths/cro-growth-marketing/6-exit-intent-tactics.html)
- [Dynamic Yield — Event-Driven Triggered Messaging Engine](https://www.dynamicyield.com/triggering/)
- [Dynamic Yield Knowledge Base — Events](https://support.dynamicyield.com/hc/en-us/articles/360023172893-Events)
- [Wizzy.ai — How to Identify & Fix Zero-Result Searches](https://wizzy.ai/blog/zero-result-searches-solution/)
- [Bloomreach — How To Fix Zero Search Results in Ecommerce](https://www.bloomreach.com/en/blog/how-to-fix-zero-search-results-in-ecommerce)
- [AppStorys — Web Push Notification Best Practices (2026)](https://appstorys.com/blog-Web-Push-Notification-Best-Practices)
- [PushPilot — Push Notification Personalization in 2026](https://pushpilot.ai/blog/push-notification-personalization-2026)
