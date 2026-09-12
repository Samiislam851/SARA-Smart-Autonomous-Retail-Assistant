# Merchant policy — `server/policy.js` + `server/policy-config.js`

`server/policy.js` is the last line of defense: no matter what the decider
(stub, cached replay, or LLM) proposes, `applyPolicy()` normalizes it to the
exact contract shape and runs it through a fixed chain of deterministic
guards before anything is broadcast to the widget. `server/policy-config.js`
makes every one of those guard constants a merchant-configurable env var,
validated at startup, with a safe default.

**The shopper's on/off pill always wins.** These are the merchant's ceiling
on how pushy the agent may be; nothing here can make the agent MORE
aggressive than the fixed contract (`server/contracts.js`) allows, and none
of it overrides the shopper turning the agent off client-side.

## Effect duration

`normalizeAction()`'s `DEFAULT_DURATION` (highlight/spotlight/message all
20000ms) and its `duration_ms` clamp ceiling (30000ms) are fixed in
`server/policy.js`, not merchant-configurable env vars — CLAUDE.md's
contract doesn't pin a duration number, only the action/trace shapes and the
30s cooldown/never-same-target rules. Sized to comfortably outlast a live
decider's 15-22s latency so an intervention can't expire before the shopper
who triggered it even sees it land.

## Vars

All optional. Unset → default. Invalid or out-of-range → falls back with a
`console.warn` at startup (never crashes, never silently runs with a garbage
value). **Numeric knobs** (`AGENT_COOLDOWN_MS`, `AGENT_MAX_NUDGES_PER_SESSION`,
`AGENT_MAX_MESSAGE_CHARS`, `AGENT_MIN_CONFIDENCE`) fall back to their
documented **default** on an invalid value — there's no meaningful "most
restrictive number" for a range, so the default is the safe fallback.
**Enum/list knobs** (`AGENT_ALLOWED_ACTIONS`) fall back to the **most
restrictive** value instead of the default when EVERY requested entry is
invalid — see that row below; a merchant who set the var clearly meant to
restrict the agent, so a typo should never silently re-open every action.

| Var | Default | Range / accepted values | What it does | Guard reason text |
|---|---|---|---|---|
| `AGENT_COOLDOWN_MS` | `30000` | integer, `30000`–`600000` | Minimum ms between non-noop actions in a session. **Tighten-only**: the fixed contract floor (`CLAUDE.md`'s "max one intervention per 30s per session") is the minimum accepted value — a value below `30000` falls back to the `30000` default, it is never honoured. Raise it (up to `600000`) to make the agent quieter. | `cooldown active (30s)` |
| `AGENT_MAX_NUDGES_PER_SESSION` | `3` | integer, `>= -1` | Hard cap on total non-noop actions ever delivered to one session. `0` = **zero nudges** — the agent stays silent all session, even the first non-noop action is denied. `-1` = **unlimited**. Any positive N = that many allowed. Counted in `session.nudgeCount` (`server/state.js`), incremented on every allowed non-noop action — including during cached-mode replay (`opts.skipCooldown` does not exempt this guard). | `session nudge budget spent (3)` |
| `AGENT_ALLOWED_ACTIONS` | all actions | comma list, subset of `highlight,scroll_to,message,spotlight,noop` | Restricts which action types the agent may ever emit. Unknown names are dropped with a warning; `noop` is always allowed regardless of what's listed. **Fail-closed**: if EVERY requested action is invalid (e.g. all typos, or the value resolves to no tokens at all), this falls back to **noop-only**, not the permissive "all actions" default. | `action "spotlight" disabled by merchant` |
| `AGENT_DENY_TARGETS` | (empty) | comma list of target ids | Target ids the agent may never highlight/scroll_to/spotlight/message, e.g. `checkout-button`. Free-text list — there's no "invalid" entry to fail closed on; an unset/empty value is (correctly) the least restrictive state, deny nothing. | `target "checkout-button" denied by merchant` |
| `AGENT_MAX_MESSAGE_CHARS` | `140` | integer, `1`–`140` | Lowers (never raises) the contract's 140-char message cap. Messages over the cap are **truncated**, not denied — see Message length note below. | n/a (truncation happens in `normalize()`, before guards run) |
| `AGENT_MIN_CONFIDENCE` | `0` | float, `0`–`1` | Non-noop actions whose `trace.confidence` is below this floor are denied. Confidence exactly at the floor is allowed. | `confidence 0.41 below merchant floor 0.6` |
| `AGENT_ON_SCREEN_QUIET_MS` | `90000` | integer `>= 0`, or `-1` to disable | Second, longer floor on top of `AGENT_COOLDOWN_MS`: while the PREVIOUS non-noop action was a `card` or `message` (the only actions that leave persistent text on screen), no new one may broadcast until this many ms have passed. Cards no longer auto-expire, so a second nudge while the first is still on screen is noise, not help. Skipped under `opts.skipCooldown` (same cached-replay rationale as the cooldown guard). **Not** in `server/policy-config.js` — this change's edit boundary excluded that file, so `policy.js` reads `process.env.AGENT_ON_SCREEN_QUIET_MS` directly rather than through the validated-singleton pattern every other knob above uses; TODO for whoever owns `policy-config.js` next: fold it in alongside `cooldownMs`. TODO: once an `agent_outcome` event reports the prior card/message was actively dismissed, this guard should shorten/clear early instead of always waiting out the full floor. | `on-screen quiet period active (90s)` |

## Sensitivity — `AGENT_SENSITIVITY` (gate.js/tick.js, not a policy.js guard)

Unlike every var above, this one doesn't touch `policy.js`'s guard chain —
it controls how readily `server/gate.js`'s layer-0 pre-filter and
`server/tick.js`'s decision trigger ASK the model in the first place. It's
loaded through `server/policy-config.js` (`loadPolicyConfig()` /
`describePolicyConfig()` / `getSensitivityMultiplier()`) purely for the
shared validated-singleton pattern and so it shows up in `GET /health`
alongside the other knobs — it is not one of the six guard constants above.

| Var | Default | Accepted values | What it does |
|---|---|---|---|
| `AGENT_SENSITIVITY` | `normal` | `normal` \| `demo` | `normal` is tuned for a real shopper session. `demo` multiplies every `gate.js` dwell/window threshold (element attention, return-visit attention, nav-friction/rage-click/search-friction windows, cart dwell, the four shopper-pattern signal windows, breadth-without-commit's product-count floor) by `0.6`, and shrinks `buckets.js`'s `bucketAttention()` boundaries by the same factor so `tick.js`'s dwell-bucket decision trigger also fires sooner. Enum knob (like `AGENT_ALLOWED_ACTIONS`) — an invalid value falls back to `normal` (the less aggressive setting), not silently to `demo`. |

Found live 2026-09-12 (session `me_1`, a real ~3-minute shopper session —
see `server/NOTES.md`): the model was called only twice, both `noop`, over
235 real behavioral events. The eight original `gate.js` signals (rules
1-8) and `tick.js`'s decision trigger were implicitly tuned for a scripted
"hover one element for 8 seconds" recipe — they never fire on a shopper who
moves between several products, returns to one, visits the cart, and leaves
without checking out, which is what most real browsing looks like. Fixed
by (a) re-tuning the original six behavioral thresholds down toward me_1's
measured real-attention distribution (`ELEMENT_ATTENTION_MS` 5000→4000ms,
`RETURN_VISIT_ATTENTION_MS` 3000→2000ms, `CART_DWELL_MS` 8000→4000ms — me_1's
real cart glance before leaving was 4600ms, well under the old floor) and
(b) adding four new signals (rules 9-12) that fire directly on the shapes
above: product ping-pong, breadth-without-commit, cart-visit-and-leave,
return-to-product-after-cart. Replaying me_1's raw events through
`gate.js`+`tick.js` with no model call (`server/replay-count.test.js`) went
from ~1.3 would-call decisions/minute (old code) to 2.27/minute under
`normal` and 4.53/minute under `demo` — both inside this fix's targets
(2-4/min normal, 4-8/min demo).

## Consult floor + page moment + cost cap — `gate.js`/`tick.js`, added 2026-09-12

Found live 2026-09-12 (session `you_2`, a real Acme browsing session):
47 events, 31 decision cycles, **0 model calls** — every single one skipped
as a quiet tick or gated out, including every `page_view` (landing page →
`/shop` → a product page → home). The shopper-pattern signals (rules 9-12
above) need a return visit or several products; an ordinary FIRST minute of
browsing trips none of the twelve `gate.js` signals, so the model never even
got asked. Category: **the model was only ever consulted on a signal edge —
there was no floor.**

Two new trigger reasons, both computed in `gate.js` (`consultFloorCheck()` /
`pageMomentCheck()`) and OR'd into `tick.js`'s `shouldCallDecider()` so they
also clear the quiet-tick throttle, not just the gate:

| Reason | Fires when | Bypasses |
|---|---|---|
| `floor` | The shopper is active (>=1 non-heartbeat event — anything except a page-level dwell heartbeat — in the last 20s) AND it's been >= `AGENT_CONSULT_FLOOR_MS` since the last model call (or since the session's own first event, if the model has never been called yet — a brand-new session gets its own grace period, it isn't treated as "overdue since Unix epoch 0"). | Every friction signal (rules 1-12) — but ONLY as a fallback, checked in `gate()` after all twelve signals have already had their turn; a real friction signal always keeps its own specific reason, floor only fires when nothing else did. |
| `page_moment` | A `page_view` lands on a product/cart/checkout page AND the shopper has already made >=2 other page_view events this session (so it isn't one of the first couple of pages — those already get `tick.js`'s existing "first-ever page_view of this path" trigger). | Same as `floor` — fallback only, after rules 1-12. |

Both are still subject to `gate()`'s cooldown hard-guard (a `floor`/
`page_moment` call during an active cooldown is denied like anything else)
and to the new cost cap below. A `noop` decided off a `floor`/`page_moment`
call is free of cooldown effects for the same reason every other `noop`
already is: `policy.js`'s `applyPolicy()` only sets `lastInterventionAt` on a
non-noop action, never just because the decider was called.

**Cost cap**: `AGENT_MAX_MODEL_CALLS_PER_MIN` (default 6) is a hard ceiling
on model calls per session in ANY rolling 60-second window, checked in
`gate()` right after the cooldown guard and before every other check —
across every reason (friction signals, floor, page_moment alike), not just
floor. Deliberately not run through `policy-config.js`'s validated-singleton
loader (that module keeps exactly one new knob from this fix,
`AGENT_CONSULT_FLOOR_MS`, since it's the one that needs
`AGENT_SENSITIVITY`-aware defaults); a simple positive-integer parse with a
`console.warn` fallback lives directly in `gate.js`. When the cap trims a
`floor` call specifically, `gate.js` logs a `[gate] rate cap trimmed a floor
call` warning (deduped to at most once per rolling 60s per session, since
once the cap saturates a busy session would otherwise log on every
subsequent qualifying event).

Replaying `server/sessions/samples/me_1.json` and a saved live Acme
session (`server/sessions/samples/final_tm_242431.json`, the session that
first surfaced this defect) through `gate.js`+`tick.js` with no model call
(`server/replay-count.test.js`):

| Fixture | Before (signals only) | After (+ floor/page_moment/cap) |
|---|---|---|
| `me_1` | 2.27 calls/min | 3.89 calls/min |
| `final_tm_242431` | 5.89 calls/min | 5.76 calls/min, max 6 in any rolling 60s window (at the cap) |

`me_1` picks up the floor/page_moment fallback in its otherwise-quiet
stretches (target 3-6/min). `final_tm_242431` already had heavy
rule-1-through-12 signal coverage from the earlier shopper-pattern fix, so
the floor mostly fills in the pre-signal opening minute (the exact gap
`you_2` exposed) while the cap keeps the session from exceeding 6/min
overall — see `server/gate.test.js` (xiv)-(xvii) for the floor/page_moment/
cap unit tests and `server/replay-count.test.js` for the fixture replay.

### Message length note

`AGENT_MAX_MESSAGE_CHARS` is enforced by clamping in `normalizeAction()`,
the same place the fixed 140-char contract cap is enforced today — a
100-char message under a 60-char merchant cap comes out as a 60-char
message, not a denial. The `checkViolation()` "message exceeds N chars"
guard is a defense-in-depth check for callers that bypass `normalize()`;
under normal flow through `applyPolicy()` it should never fire.

## Observability

`describePolicyConfig(config?)` (exported from `server/policy-config.js`)
returns a plain, JSON-serializable object with the six fields above — the
effective config, not just what's in `.env`. Called with no argument it
describes the env-loaded singleton (`policyConfig`, loaded once at import).
Intended to be wired into `GET /health` by whoever owns `server/index.js`;
this module only exposes the function.

## Guard order

Applied in `checkViolation()`, in this order, first match wins:

1. **allow-list** — `action.action` must be one of the fixed contract
   actions (`server/contracts.js`); anything else is already `noop` by the
   time it reaches here (`normalize()` forces it).
2. **merchant allowed actions** — `AGENT_ALLOWED_ACTIONS`.
3. **shape** — e.g. a `message` action needs a non-empty message; a `card`
   action needs `title`/`body`/`cta.label` and a `cta.kind` in the fixed
   vocabulary (see "card guards" below).
4. **target-in-visibleTargets (snapshot)** — the decider can't point at an
   element it never told us exists.
5. **target-on-current-page (live re-check)** — `state.visibleTargets`
   above is a SNAPSHOT taken when the decision was requested; a slow
   decider (a live LLM call can take 15-20s) can return after the shopper
   has already navigated on. This re-derives the session's CURRENT page's
   targets from `session.events` (the same rule `server/state.js`'s
   `buildState()` uses to build the snapshot) and denies if the target
   isn't there anymore — unconditional, not merchant-configurable. Found
   live 2026-09-11 (session `s_kmtgye1g`): a `card promo-code` decided on
   `/cart` broadcast onto `/checkout`, where `promo-code` was never a
   target. `currentVisibleTargets(session)` is exported for reuse.
6. **deny-targets** — `AGENT_DENY_TARGETS`.
7. **min-confidence** — `AGENT_MIN_CONFIDENCE`.
8. **cooldown** — `AGENT_COOLDOWN_MS` (skipped only under cached-replay's
   `opts.skipCooldown`).
9. **never-same-target** — a session never gets acted on for the same
   target twice (unconditional, not merchant-configurable).
10. **same-CTA-already-offered** — for `card` actions only: denies a second
    card whose `cta.kind`+`cta.value` matches one already offered this
    session, even on a DIFFERENT target (unconditional, not
    merchant-configurable). "Never same target" alone let two cards
    44s apart — `card size-guide` then `card size-picker`, both
    `{kind:"pick_size", value:"L"}` — both through, burning the whole nudge
    budget on a repeat (found live 2026-09-11, session `s_kmtgye1g`).
    Tracked in the bounded (max 10) `session.recentCtas`, appended to only
    when a `card` action actually passes.
11. **on-screen quiet period** — `AGENT_ON_SCREEN_QUIET_MS` (skipped under
    `opts.skipCooldown`, same as cooldown). See the Vars table above.
12. **nudge budget** — `AGENT_MAX_NUDGES_PER_SESSION` (NOT skippable via
    `opts.skipCooldown`).

Every denial keeps the existing trace format:
`<why> (guard: <reason>; proposed <decision>)`.

## Card guards

`card` is the one action that lets the agent DO something in one tap
(pick a size, add an item, apply a code, open a product, search) instead of
just pointing/pulsing/talking — see `server/contracts.js`'s `card` doc
comment for the full shape. Because tapping the card's `cta` triggers a real
client-side action, `checkViolation()` verifies `cta.value` is REAL before
broadcast, not just present:

| `cta.kind` | `cta.value` must be | Checked against |
|---|---|---|
| `add_to_cart` / `open_product` | a real product slug | `server/store/catalog.json` (live, via `loadStore()`) |
| `apply_code` | an ACTIVE promo's code | `server/store/promos.json`'s currently-active promos (`activePromos()`) |
| `pick_size` | a size of the CURRENT product | `state.product.sizes` (`server/state.js`'s `product`, the catalog entry for the page the shopper is actually on) — denied if the shopper isn't on a product page at all (`state.product` is `null`) |
| `search` | a non-empty string, ≤60 chars | shape only, no external lookup |
| `none` | must be absent (`null`) | informational card, no cta to validate |

Any mismatch — a fake code, a slug that isn't in the catalog, a size the
current product doesn't offer — denies the whole action (downgraded to
`noop`, same fail-closed pattern as every other guard, trace explains why).
`title` (≤60 chars), `body` (≤200 chars), and `cta.label` (≤28 chars) are
truncated in `normalizeAction()`/`normalizeCard()` before guards run, same
as the message-length truncation below; an empty title/body/label after
truncation forces `noop` (a blank card helps nobody). `card` is `null` on
every other action type.

## Merchant recipes

**Quiet store** — long cooldown, at most one nudge per visit:
```
AGENT_COOLDOWN_MS=120000
AGENT_MAX_NUDGES_PER_SESSION=1
```

**Hands-off checkout** — never touch the checkout button, no spotlight:
```
AGENT_DENY_TARGETS=checkout-button
AGENT_ALLOWED_ACTIONS=highlight,scroll_to,message
```

**Conservative model** — only act when the decider is confident:
```
AGENT_MIN_CONFIDENCE=0.7
```

## Testing against a scoped config

`applyPolicy(session, state, proposed, opts)` accepts `opts.config` — a
config object from `loadPolicyConfig({...})` — so tests can exercise a
specific policy without touching `process.env` or the module-level
singleton. The running server always uses the singleton (`policyConfig`,
loaded once from `process.env` at import) unless a caller passes an
explicit `opts.config`. See `server/probe-policy.test.js` for examples.
