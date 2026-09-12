# Demo video storyboard (~90s)

Order: sizing hesitation → cart threshold → happy browsing → cost. Matches
`docs/OPS.md`'s recorded-session recipe — nothing on screen is a live LLM call,
so nothing can go wrong on camera.

A 4th fixture, `facts-threshold` (same ৳50-under-free-delivery story as cart
threshold, but the total/threshold arrive only via `page_view.meta.facts`,
no `cart_*` events — see `agent/FACTS.md`), now passes too and is
available in the Demo row (`fx_facts_threshold`, `/cart`). It isn't in this
90s cut — the story it tells on screen is the same as session 2 — but swap
it in for session 2, or narrate it as a one-liner over the cost slide
("the agent reasons from raw page facts too, not just cart events"), if
time allows.

## Before recording — checklist

- [ ] Server running `AGENT_MODE=cached AGENT_DEBUG=1` (enables the Demo
      buttons in the trace panel and `DELETE /session/:id` for clean retakes)
- [ ] `scripts/tunnel-up.sh` up if recording against a public URL, or use
      `localhost:3000` / `localhost:4000` for a fully local take
- [ ] Reset each fixture's session before rolling: `scripts/demo.sh
      --reset-only <fixture> --base <server-url>` (avoids stale
      cooldown/never-same-target state from a prior take)
- [ ] Browser zoom set so the trace panel text is readable at video
      resolution (125–150% typical)
- [ ] Bookmarks bar hidden, browser chrome minimal, no notifications
- [ ] Trace panel open (`data-panel="true"` / the panel tab clicked) on
      every shot
- [ ] Practice the click sequence once off-camera so the Demo-button clicks
      are smooth

## Shot list

| Time | Shot | On-screen action | What appears |
|---|---|---|---|
| 0:00–0:05 | Title | Repo README or a title card | Project name + one-line pitch |
| 0:05–0:25 | Session 1 — sizing hesitation | Open `/product/khadi-field-jacket?agent_session=fx_sizing_hesitation`, click the "sizing-hesitation" row in the trace panel's Demo list (or it auto-plays via `?agent_demo=sizing-hesitation` in the URL) | Size-guide element pulses; trace panel shows signals (repeated dwell on size guide, revisit after back-nav) → hypothesis → `highlight size-guide` → why. Hold on the trace panel ~3s. |
| 0:25–0:50 | Session 2 — cart threshold | Open `/cart?agent_session=fx_cart_threshold`, click "cart-threshold" Demo row | A message bubble appears naming the exact ৳ gap to free delivery (e.g. "৳50 more for free delivery"), page scrolls to the shipping banner. Trace panel shows the same decision with `why`. Hold ~3s. |
| 0:50–1:10 | Session 3 — happy browsing | Open `/product/khadi-field-jacket?agent_session=fx_happy_browsing`, click "happy-browsing" Demo row | Normal browsing, dwell, add-to-cart — trace panel shows a run of quiet `noop` traces (collapsed as "stayed quiet ×N"), each with a real `why` (e.g. "no friction signal strong enough to justify stepping in"). No page changes. This is the restraint proof. Hold ~3s on an expanded noop entry. |
| 1:10–1:25 | Cost / cheapness | Cut to a terminal or a static slide showing `agent/NOTES.md`'s cost table (or `GET /metrics` on the running server) | Calls/session dropping from 11.67 (naive) → 3.00 (gate+tick) → 2.33 (cache cold). $237–$1,143 measured per 1M sessions across those three configurations (gpt-5-nano pricing); ~$50–150 estimated at scale with a warm shared cache (unmeasured). One sentence on screen: "Cheap by design: gate, tick, and cache before any model call." |
| 1:25–1:30 | Close | Repo URL / submission title card | — |

## Narration script (~200 words, plain spoken English)

> This is a shopping assistant that lives inside the store, not in a chat
> window. It watches what a shopper does — how long they linger, what they
> scroll past, when they hesitate — and decides on its own whether to help.
>
> Here, a shopper keeps returning to the size guide. The agent notices the
> pattern and pulses it — a small nudge, not a popup.
>
> Here, a shopper's cart is fifty taka short of free delivery, and they
> bounce between cart and checkout. The agent names the exact gap and
> scrolls to the shipping banner. One nudge, then it stays quiet again.
>
> And here — a shopper just browsing normally. The agent watches the same
> signals, decides nothing is wrong, and does nothing. That's not the
> absence of a decision. It's a decision, logged and explained, right in
> this trace panel: signals, hypothesis, what it chose, and why. A chatbot
> can only help after you ask. This agent notices before you know to ask —
> and it's allowed to do nothing.
>
> It's also cheap enough to run at scale: a gate and a cache mean most
> visits never even reach the model. And the shopper stays in control —
> one tap turns it off entirely.

## What to show in the trace panel

- The signals list (e.g. "dwell size-guide 22s", "back_nav /") — proves the
  decision is behavior-driven, not scripted UI state
- The `hypothesis` line — plain-English reasoning, not just an action name
- At least one expanded `noop` entry with its `why` — this is the criterion-2
  proof point, don't rush past it
- The on/off pill, briefly, if time allows — proves shopper control exists

## 15s "how it's cheap" shot

Either:
- A static slide with the calls/session table from `agent/NOTES.md` /
  README's Cost section, or
- A live `curl localhost:4000/metrics | jq` (or the widget's metrics strip,
  `calls · cache hits · gated · quiet`) showing real counters from the
  session just recorded

State the one-liner on screen or in narration: "gate + tick + cache mean
most visits never reach the model at all."
