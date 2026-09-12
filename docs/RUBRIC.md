# Judging rubric mapping

4 criteria, 1–5 each, judged only from title + description + repo + a short
video (no live demo). Honest about gaps — this isn't a sales pitch.

## (1) Core Requirements & Functionality

**Look at:** `make setup && make dev`, the product page after ~5s dwell, and
`docs/VIDEO.md`'s three-session video.

**Evidence:**
- `agent/sessions/*.json` — 4 scripted fixtures with `expect` blocks,
  replayable without a human clicking (`node agent/replay.js
  sessions/*.json`).
- Stub mode (`npm test`) is 1/4 by design (only the sizing-hesitation rule is
  implemented as a hardcoded fallback); the real judgment happens in
  `AGENT_MODE=llm`/`cached` — `claude` backend passes all 3 demo fixtures
  (`agent/NOTES.md`'s "claude backend measurement").
- The demo is recorded, not live, on purpose: `AGENT_MODE=cached` replays a
  known-good decision trace so nothing can fail on camera —
  `agent/sessions/recorded/`.
- Load test: p95 8ms, 0 errors, 0 WS drops at 50 concurrent sessions ×20
  events (measured for this doc, see README's "Ops" section).

**We'd say:** "It runs end to end against real recorded sessions, with a
deterministic fallback path (cached mode) so the demo can't break live."

**Gap:** `anthropic`/`gemini` backends are auth-failure-path-only, never
exercised against a real key.

## (2) Innovation & Theme Alignment

**Look at:** the `happy-browsing` fixture and its `noop` trace entries; the
trace panel's collapsed "stayed quiet ×N" rows.

**Evidence:**
- `noop` is a modeled, traced decision (`agent/prompts/decide.md`: "noop...
  is the default and the preferred action. Every noop still needs a real
  trace explaining why you chose not to act"), not silence-by-omission —
  something a chat window can't express, because a chatbot only ever
  produces output when asked.
- The agent acts on the page itself (`highlight`, `spotlight`, `scroll_to`)
  — a location and interaction shape a chat interface structurally cannot
  offer.
- Behavior-as-input: 8 event types (`agent/contracts.js`) covering dwell,
  scroll, rage clicks, cart state, search, back-nav — the model reasons over
  what the shopper *did*, not what they typed.

**We'd say:** "A chatbot can only help after you ask. This agent notices
you're stuck before you know to ask, and it's allowed to do nothing."

**Gap:** none identified for this criterion specifically; it's the project's
strongest.

## (3) Technical Execution & Integration

**Look at:** `agent/policy.js`, `agent/gate.js`, `agent/tick.js`,
`docs/ARCHITECTURE.md`, `agent/metrics-runs/`.

**Evidence:**
- Layered cost design with measured numbers, not felt-sense: gate → tick →
  fingerprint cache → model call → policy guards (`docs/ARCHITECTURE.md`'s
  cost funnel; raw data in `agent/metrics-runs/`).
- `policy.js`'s `normalize()` treats every decider (even a real LLM) as
  untrusted input, rebuilding output to the exact contract shape on every
  path before any guard runs — a defensive boundary a naive integration
  wouldn't have.
- 5 pluggable LLM backends behind one interface (`decide/backends/`), with
  documented per-backend auth failure handling (`decide/backends/anthropic.js`,
  `gemini.js` — auth errors pattern-matched into a consistent noop, never a
  crash).
- Ops layer: `/health`, `/health/agent` (self-test), `/ready`, `/metrics`,
  structured JSON logging (`agent/log.js`), a process-level crash guard
  (`unhandledRejection`/`uncaughtException` backstop), backpressure (global
  in-flight cap, per-session queue cap, LRU session eviction) —
  `agent/OPS.md`.
- Zero-wiring page-facts extraction for pages with no `data-agent-*` hooks
  at all (`agent/FACTS.md`), handling Bangla digits/currency, ambiguous
  decimal/thousands separators, promotional-amount exclusion.

**We'd say:** "The guards, replay tests, cached fallback, and measured cost
layers are the depth here — not just 'call an LLM and hope'."

**Gap:** the session store is **count-bounded, not time-bounded** — capped
at `AGENT_MAX_SESSIONS` (default 5000) via LRU eviction (`agent/OPS.md`),
not a wall-clock TTL sweep. A single session's own maps (`actedTargets`,
`lastDwellBuckets`) never shrink for the life of that session, and nothing
proactively evicts a session that's merely gone idle short of hitting the
global cap — fine for a hackathon demo, not for a real multi-day deployment
(`agent/NOTES.md` "Known limits"). `facts.keys` vs `facts.snippets`
effectiveness is an open, unresolved R&D question (`agent/FACTS.md`).

## (4) Usefulness & Agentic Experience

**Look at:** the on/off pill (bottom-right), the trace panel's plain-words
line, a message bubble's dismiss (×).

**Evidence:**
- Shopper stays in control: on/off pill persists in `sessionStorage`; off
  means actions stop applying to the DOM but tracking/trace panel keep
  running (never a silent, un-auditable agent); click-anywhere dismisses an
  active highlight/spotlight early; message bubbles always have a dismiss
  and auto-hide.
- Messages are informational, not persuasive, by prompt rule
  (`agent/prompts/decide.md`: "no exclamation marks", exact ৳ amounts, only
  when a message adds real information the shopper doesn't already have).
- Hard ceilings even if the model misbehaves: 30s cooldown, never the same
  target twice, a nudge budget (`AGENT_MAX_NUDGES_PER_SESSION`, default 3
  per session), merchant-configurable via `agent/POLICY.md` — none of these
  can be loosened by the model, only tightened by the merchant.
- The trace panel itself is the transparency mechanism: signals →
  hypothesis → decision → confidence → why, for every tick including
  `noop`.

**We'd say:** "The shopper can always see why, always turn it off, and the
agent has hard limits on how often and how it can speak — regardless of what
the model proposes."

**Gap:** no user-facing settings beyond on/off (e.g. no way for a shopper to
say "fewer messages, more page hints") — control is binary, not graduated.
