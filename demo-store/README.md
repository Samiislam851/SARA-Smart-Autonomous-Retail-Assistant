# web/ — storefront + agent widget

Next.js (App Router) storefront. The agent widget (`components/AgentWidget.tsx`)
is a tracker + executor + trace panel in one file, mounted once in
`app/layout.tsx` so it survives client-side route changes.

## Pages

- `/` — product listing (`lib/products.ts`), search box, cart link.
- `/product/[slug]` — product detail (`components/ProductClient.tsx`), size
  guide modal, add to cart.
- `/cart` — cart items, total, free-delivery gap banner (`shipping-banner`).
- `/checkout` — address form, payment options, place order.

## Marking elements for the agent

Any element the agent may act on (highlight/spotlight/scroll_to/message-target)
carries `data-agent-target="some-id"`. The widget scans the DOM for all such
ids and sends them as `page_view`'s `meta.targets` — the server only allows
actions against ids it has seen this way (`policy.js`'s `visibleTargets` guard).

## Events the widget emits (`POST /event`)

- `page_view` — on mount, on route change, and (debounced 300ms) after any
  DOM mutation (modal open/close, etc.) that changes the set of visible
  `data-agent-target` ids. `meta.targets` = all current ids.
- `dwell` — a page-level heartbeat every 5s (`target` = pathname, `meta.ms`
  = time on page), plus per-element dwell: any `data-agent-target` element
  visible (IntersectionObserver, 50% threshold) for 3s+ fires with
  cumulative `meta.ms` for that element, then again every further 3s while
  it stays visible.
- `scroll_depth` — `meta.pct` at 25/50/75/100, once each per page.
- `rage_click` — `meta.count` when the same `data-agent-target` element is
  clicked 3+ times within 1.5s.
- `cart_update` — on any cart store change, `meta.{total, items}`.
- `cart_view` — once per visit to `/cart`, same `meta` shape.
- `search` — `meta.q` when the nav search box (`data-agent-target="search"`)
  is typed into, debounced 400ms.
- `back_nav` — on browser back/forward (`popstate`).

## Session 2 decision (resolved: option b)

A `message` action may carry a non-null `target`. The widget shows the
message bubble AND smooth-scrolls to that target in one action, so the
server only needs to emit a single `message` action for the cart-threshold
fixture instead of two actions racing the 30s cooldown. See
`server/sessions/cart-threshold.json` (`expect: {action:"message",
target:"shipping-banner"}`) and `CLAUDE.md`'s session 2 description.

## User stays in control

- An active highlight/spotlight ends on the EARLIEST of: its `duration_ms`
  (defaults 20s, server-clamped to 30s max — see `server/policy.js`'s
  `DEFAULT_DURATION`, sized to comfortably outlast a live decision's 15-22s
  latency), an interaction with it (clicking its own target, or its own
  chip's `×`), or navigating away — never earlier. Clicking its own target
  dismisses it immediately; an unrelated click elsewhere on the page also
  dismisses it, but only after a 5s grace period (`EFFECT_GRACE_MS`) so a
  single accidental click right after it lands can't kill help the shopper
  hasn't seen yet.
- The "Agent on/off" pill (bottom-right) persists in `sessionStorage`. Off:
  the widget keeps tracking and the trace panel keeps updating, but incoming
  actions are not applied to the DOM — the corresponding trace row is greyed
  out and labeled "suppressed by shopper".
- The message card always has a dismiss (×) and auto-hides after its
  `duration_ms` (default 20s).
- `prefers-reduced-motion` disables the highlight pulse animation and forces
  instant (non-smooth) scrolling for `scroll_to`/`message`-with-target.
- The trace panel shows a "thinking · Ns" line once it's been >3s since the
  last `{kind:"trace"}` frame while the socket is open — a live decision
  takes 15-20s and quiet ticks collapse into one row, so without this the
  panel can look frozen the whole time. Clears on the next trace.

## What the shopper sees

The trace panel is the developer view — collapsed by default (and hidden
entirely under 1100px width), so it never competes with the shopper-facing
surfaces below. Help is never *only* a transient bubble/pulse: a persistent
**launcher** (a round button, bottom-right, always visible — the on/off pill
now lives inside its panel, not floating on its own) gives the shopper an
on-demand way to see everything the agent has done, is doing, and could do
right now.

- **Launcher + assistant panel**: clicking the launcher (`aria-haspopup`
  `dialog`) opens a ~340px panel anchored to the same corner
  (`role="dialog"` `aria-label="Store assistant"`). It shows a live status
  line — `watching` / `thinking · Ns` (same indicator as the trace panel) /
  `paused` (agent off) / `offline` (socket closed) — and four sections:
  - **Suggestions**: every non-noop action delivered this session, newest
    first, as a card (`aria-live="polite"` container so new cards are
    announced) with the message text (or a plain sentence for
    highlight/spotlight/scroll_to, e.g. "I pointed at the size guide"), a
    relative timestamp, and `Show me` (re-scrolls to the target + a 5s pulse,
    independent of any live effect in progress) / `Why?` (that suggestion's
    own hypothesis + confidence, not just the latest trace) / `Dismiss`.
    Cards persist in `sessionStorage` until dismissed, so a reload doesn't
    lose the tray.
  - **What I noticed**: a plain-language read of the *latest* trace — up to 5
    signals, the hypothesis, and the decision (including quiet: "Nothing to
    help with right now: browsing normally.").
  - **Controls**: the on/off toggle (same `sessionStorage`-persisted path as
    before) and "Clear suggestions".
  - **Tester tools** (only rendered when the server exposes `AGENT_DEBUG` —
    detected via `GET /demo/fixtures` returning a non-empty list OR `GET
    /sessions?limit=1` returning 200, since the former alone 200s `[]`
    outside `AGENT_MODE=cached`): the Demo row (moved here from the trace
    panel, same behaviour), `Decide now` (`POST /session/<id>/decide`,
    shows `decided: <action> <target>, <n>s` or the server's error inline),
    `Reset session` (`DELETE /session/<id>`, then reloads), and a link to
    `/sessions/<id>` (the research page).
  - Escape closes the panel and returns focus to the launcher; a badge on
    the launcher counts suggestions delivered since the panel was last
    opened.
- **Message bubble**: a footer row under the text with a `Why?` toggle and a
  `Turn off` link. `Why?` expands/collapses an inline line built from the
  *most recent* `{kind:"trace"}`: its `hypothesis` (falling back to `why` if
  no hypothesis) plus `confidence` as a rounded percentage, e.g. "Cart is ৳50
  under free delivery and you bounced from checkout · 82% sure". `Turn off`
  calls the same disable path as the assistant panel's on/off toggle
  (persisted the same way in `sessionStorage`) and additionally clears the
  current bubble and any active highlight immediately.
- **Highlight/spotlight chip**: while a highlight or spotlight is active, a
  small chip appears (not anchored to the arbitrary target element, to stay
  simple and robust) with the same `Why?` behaviour and a `×` that dismisses
  the highlight early. Clicking the highlighted target itself also dismisses
  it immediately; an unrelated click elsewhere on the page dismisses it too,
  but only after a 5s grace period — see "User stays in control" above.
- Both `Why?` lines (and every suggestion card's `Why?`) are rendered via
  `textContent` only (trace text is model output, never treated as markup).
  All buttons are real `<button>` elements with visible focus outlines.
- No new motion was added, so there's nothing additional to gate behind
  `prefers-reduced-motion` beyond the existing highlight-pulse gating above.

## Trace panel

- Consecutive `noop` traces collapse into one row ("stayed quiet ×N") showing
  the latest `why`; click to expand and see every collapsed entry.
- A metrics strip (`calls · cache hits · gated · quiet`) appears once the
  first `{kind:"metrics"}` WS message arrives; hidden before that.
- A plain-words line under the header: "One nudge per 30s. Never twice on the
  same element. Silence is a decision."
- List key is `${ts}-${index}` (traces/groups can share a `ts` at high replay
  speed).
- Panel visibility (shown/hidden via a small tab) persists in
  `sessionStorage`.
- Tolerates traces with missing/empty `signals` (renders "(no signals)").

## Running against the local server

```
cd server && npm i && node index.js               # :4000 (AGENT_MODE=stub by default)
cd web    && npm i && npm run dev                  # :3000
```

Or point at a different port via env:

```
NEXT_PUBLIC_AGENT_HTTP=http://localhost:5200 NEXT_PUBLIC_AGENT_WS=ws://localhost:5200 npm run dev -- -p 3200
```

## Running the fixtures

Fixtures talk directly to the server over HTTP/WS — they don't drive a
browser or this widget:

```
cd server && node index.js &
node replay.js sessions/*.json
```

## Research page (`/sessions`)

A tool for the team, not shoppers: browse recorded sessions, replay the
shopper's timeline next to the agent's decisions and reasons, mark where the
agent should have helped or stayed quiet, replay a session against the
current prompt/rules to see what changed, and export a session as a fixture.

- `/sessions` — table of recorded sessions (newest first), auto-refreshing
  every 5s. Filters: "with interventions", "labelled", "today". Click a row
  to open it.
- `/sessions/[id]` — two-column timeline: shopper events on the left (with
  runs of identical page-dwell heartbeats collapsed into one row), agent
  decisions aligned by event index on the right (consecutive quiet ticks
  collapsed into one row with a count). Each event row has "should help
  here" / "should stay quiet" buttons that POST a label (with an optional
  ≤200-char note); existing labels show inline with a delete `×`.
- "Replay against current prompt" re-runs the session against the live
  decision logic in a shadow session, polling every 1.5s, then adds a third
  "Replay" column plus a diff summary ("same N · changed N · new
  intervention N · lost intervention N").
- "Copy fixture JSON" copies the session's fixture JSON to the clipboard
  (viewers can't download files) with a suggested filename
  `server/sessions/<name>.json` for you to paste and save.
- "Reset live session" calls `DELETE /session/:id` after a confirm prompt.

These routes only exist when the server is run with `AGENT_DEBUG=1`; every
request 404s otherwise, and the page shows an explicit "research endpoints
are off" empty state instead of erroring. A separate network-failure empty
state covers the server being unreachable at all.

### Wire contract vs. page-facing types

`lib/research.ts` mirrors the server's on-disk/wire shape (see
`server/RESEARCH.md`) with `Raw*` types — `RawSessionDecision.decided` is a
string ("noop" or "<action> <target>"), `RawSessionDecision.action` is the
full action object (or `null`), and `RawSessionSummary.labels` is the full
label array, not a count. A normalization step (`normalizeDecision`,
`normalizeSummary`, `normalizeDetail`, `normalizeReplayStatus`) converts
these into the page's internal types before any component sees them:
`SessionDecision.acted: boolean` (prefers `delivered`, falling back to
`action?.action && action.action !== "noop"`), `actionLabel: string | null`,
`target: string | null`, and `SessionSummary.labels: number`. Components only
ever deal with the normalized types.

Label deletion (`DELETE /sessions/:id/labels/:index`) takes the **array
index** into `labels[]`, not the event index the label is anchored to —
`SessionLabel.index` (assigned during normalization, by array position) is
what `deleteLabel()` sends, not `atEventIndex`.

The Nav's "Research" link is visible by default; set
`NEXT_PUBLIC_AGENT_RESEARCH_LINK=0` to hide it (e.g. in a shopper-facing
deploy).

### Developing without the real server

`server/**`'s debug routes may not exist yet in your checkout. Use the bundled
mock instead — it serves the same contract (`/sessions`, `/sessions/:id`,
labels, a replay job that completes after 3 polls, fixture export) with two
canned sessions, one of them with interventions and labels:

```
node web/scripts/mock-research-server.mjs                 # :4811
NEXT_PUBLIC_AGENT_HTTP=http://localhost:4811 \
  npx next dev -p 3811                                     # separate terminal, in web/
```

Then open `http://localhost:3811/sessions`.
