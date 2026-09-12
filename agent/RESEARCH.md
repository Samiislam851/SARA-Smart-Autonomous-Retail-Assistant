# The research loop

The team needs to figure out which shopper behaviours actually mean "stuck"
and which kinds of help work — that means being able to look back at real
sessions, not just the hand-authored fixtures in `sessions/`. This doc
covers the file format, the API, and a curl walkthrough. See `NOTES.md`'s
"2026-09-11 — research loop" entry for the design writeup and known
limitations, and `OPS.md`'s endpoint table for the terse reference.

## Turning it on

- `AGENT_LIVE_RECORD=1` — records every live session, nothing else changes.
- `AGENT_DEBUG=1` — also turns on recording (so a debug server always has
  something to look at), plus registers the API below. Plain 404 for every
  route in this doc unless `AGENT_DEBUG=1` is set.

Nothing is recorded for `fx_*` (demo-player fixture sessions — already
scripted, in `sessions/*.json`) or `rp_*` (this loop's own shadow-replay
sessions, below — synthetic re-runs of an already-recorded session). Every
other session id gets a file the moment its first event arrives.

## File format — `sessions/live/<sessionId>.json`

```json
{
  "session": "s_x",
  "startedAt": 1757600000000,
  "lastAt": 1757600123000,
  "mode": "llm",
  "backend": "claude",
  "model": "sonnet",
  "events": [
    { "i": 0, "ts": 1757600000000, "type": "page_view", "target": "/", "meta": { "targets": ["..."] }, "replay": false }
  ],
  "decisions": [
    {
      "ts": 1757600008933,
      "eventIndex": 12,
      "trigger": "dwell",
      "decided": "highlight size-guide",
      "reason": "llm",
      "ms": 8933,
      "action": { "action": "highlight", "target": "size-guide", "style": "pulse", "duration_ms": 8000, "message": null, "id": "a_p2t6jgo4" },
      "trace": { "ts": 1757600008933, "signals": ["..."], "hypothesis": "...", "decision": "highlight size-guide", "confidence": 0.8, "why": "..." },
      "delivered": true
    }
  ],
  "labels": [
    { "ts": 1757600200000, "atEventIndex": 12, "expected": "help", "note": "size hesitation, highlight was right" }
  ],
  "outcomes": [
    { "action_id": "a_p2t6jgo4", "action": "highlight", "target": "size-guide", "cta_kind": null, "outcome": "dismiss", "ms_visible": 4200, "ts": 1757600012000 }
  ]
}
```

## Outcomes — what did the shopper DO after an action?

Every non-noop action the server broadcasts gets a server-assigned `id`
(`a_` + 8 base36 chars, `actionMessage()`/`decideAndBroadcast()` in
`index.js`) — carried on `decisions[].action.id` above and echoed back by
the widget (`AgentWidget.tsx` / `agent.js`) as an `agent_outcome` event the
moment the shopper resolves it:

```json
{ "session": "s_demo1", "type": "agent_outcome", "target": "size-guide", "ts": 1757600012000,
  "meta": { "action_id": "a_p2t6jgo4", "action": "highlight", "cta_kind": null, "outcome": "dismiss", "ms_visible": 4200 } }
```

`outcome` is one of:

- `cta` — the on-page card's CTA tapped (card only), OR the tray's "Show me"
  on an older suggestion (any action kind) — same bucket, only if no
  outcome was reported yet for that id.
- `dismiss` — × on the card / message bubble / highlight-spotlight chip, or
  the tray's Dismiss button.
- `turn_off` — "Turn off" clicked from the card or message bubble.
- `navigated` — the pathname changed while the card/message/highlight was
  still showing and untouched.
- `ignored` — replaced by a newer action before being touched, or still
  untouched when the tab hides/unloads (`visibilitychange` hidden +
  `pagehide`, sent via `fetch(..., {keepalive:true})`).

Exactly ONE outcome is ever recorded per action id — the widget keeps a
`Set` of already-reported ids (client-side half); `recordOutcome()` in
`live-record.js` dedupes again by `action_id` server-side (a duplicate
report, e.g. a slow tab-close beacon racing an earlier explicit dismiss, is
acknowledged `{ok:true, duplicate:true}` but not double-counted).
`agent_outcome` is handled entirely outside the normal event pipeline
(`index.js`'s dedicated branch in `POST /event`) — it's never pushed into
`state.js`'s `session.events`, so it can never feed `gate.js`/`tick.js`'s
friction signals or `buildState()`'s `recent` log, and can never itself
trigger a decision. `scroll_to` has no lingering on-page affordance (no
chip), so its outcome resolves immediately on execution instead of via a
live slot: `cta` if it found and scrolled to its target, `ignored`
otherwise (or, if the agent was off entirely, whenever the tray later
resolves it).

Notes:

- `events[].i` is this recorder's own running index — unbounded, independent
  of `state.js`'s 200-event ring buffer, so it stays meaningful for a long
  session whose in-memory ring has already wrapped.
- `events[].replay` is `true` only when that event's `POST /event` carried
  `x-agent-replay: 1` (i.e. `replay.js` — the day-of tuning-loop tool —
  driving this exact live session id, not a fixture). It's `false` for
  everything a real browser tab sends.
- `decisions[].eventIndex` is the most recently recorded event's index at
  the moment this decision cycle finished — the same "decide against
  whatever is CURRENT" semantics `decideAndBroadcast()` already uses
  internally (see `index.js`'s own doc comment on that function).
- `decisions[].reason` is one of `llm | stub | cached | cache | guard | gate
  | quiet | overloaded | forced` — the last one only ever comes from
  `POST /session/:id/decide` below.
- `decisions[].delivered` is `true` iff a non-noop action was actually
  broadcast to the widget for this decision.
- Writes are debounced (≤1/s per session for events), flushed immediately
  whenever a decision is appended. The store is capped at 500 files under
  `sessions/live/`; oldest by `lastAt` is deleted first once exceeded.

## API

| Route | Method | Request | Response |
|---|---|---|---|
| `/sessions?limit=50` | GET | — | `200 [{session, startedAt, lastAt, events, decisions, interventions, pages, labels, lastDecision:{decided,reason}, outcomes:{cta,dismiss,turn_off,navigated,ignored}}]`, newest (`lastAt`) first. |
| `/sessions/:id` | GET | — | `200` the full file above, with each `decisions[]` entry also carrying `outcome` (joined from `outcomes[]` by `action.id`, or `null`). `404` if unrecorded. |
| `/sessions/stats` | GET | — | `200 {totalActionsShown, byActionType:{<action>:{shown, outcomes, cta_rate, dismiss_rate}}, byTarget:{<target>:{...same shape...}}}`, aggregated across every recorded live session. |
| `/sessions/:id/labels` | POST | `{atEventIndex:int, expected:"help"\|"quiet", note?:string≤200}` | `200 {ok:true, labels}`. `400` malformed body, `404` unknown session. |
| `/sessions/:id/labels/:index` | DELETE | — | `200 {ok:true, labels}`. `400` out-of-range index, `404` unknown session. |
| `/sessions/:id/fixture` | GET | — | `200` a `replay.js`-compatible fixture (see below). `404` unknown session. |
| `/sessions/:id/replay` | POST | — | `202 {job, shadowSession}`. `409` already replaying this session, or `AGENT_MODE=cached`. `404` unknown session. |
| `/sessions/:id/replay/:job` | GET | — | `200 {state:"running"\|"done"\|"error", progress:{done,total}, decisions}`. `404` unknown job. |
| `/session/:id/decide` | POST | — | `200 {action, trace, ms}`. `409` decision already in flight, or `AGENT_MODE=cached`. `404` session doesn't exist (never received a real event). |

`POST /sessions/:id/replay` replays the session's non-`replay`-tagged
recorded events into a brand-new shadow session `rp_<hash8>`, through
`processEventSerial()` — the same strict per-event path cached-mode
playback and `replay.js` use — so tick.js/gate.js/policy.js all run exactly
as they would for live traffic. Each event's *original* recorded `ts` is
preserved (time-window rules key off it) but there's no real-time delay
between them. Progress is broadcast on the **source** session's WebSocket as
`{kind:"replay", state, job, done, total}`. Only `AGENT_MODE=llm` or `stub`
— cached mode's decider is index-keyed to its own recording, not meaningful
here.

**Known limitation:** because replay has no real-time delay, `policy.js`'s
wall-clock 30s cooldown can behave differently than it did live (a proposal
that was legitimately >30s apart in the original session can land <30s
apart here and get denied). This is intentional — the brief calls for
tick/gate/policy to apply unmodified, so a cooldown-denied noop in a replay
is itself a finding ("today's rules would have gone quiet here"), not a bug
to paper over the way cached-mode fixture playback's `skipCooldown` does.

`POST /session/:id/decide` forces the session's decider to run right now,
bypassing tick.js's quiet-tick throttle and gate.js's layer-0 gate — but
**not** policy.js (allow-list, cooldown, no-repeat-target all still apply).
Recorded with `reason:"forced"`.

## Fixtures promoted from real sessions

A fixture exported via `GET /sessions/:id/fixture` is a normal
`replay.js`-shaped JSON (`{name, session, description, expect, events}`).
To promote a real session into the regression suite: save the export under
`sessions/<name>.json` (matching every other fixture there) — `npm test`
(`node replay.js sessions/*.json`) and `scripts/check.sh` then include it
automatically, same as any hand-authored fixture. `expect` is derived from
the last `expected:"help"` label (matched to the decision recorded at that
label's `atEventIndex`); label the session before exporting if you want a
non-`noop` expectation baked in.

## Curl walkthrough

```bash
# 1. Run a debug server (stub mode is fine for a dry run):
AGENT_MODE=stub AGENT_DEBUG=1 PORT=4000 node index.js

# 2. Browse the storefront for a bit (or drive a fixture as live traffic —
#    no x-agent-replay header — so it gets recorded):
curl -s localhost:4000/event -H 'content-type: application/json' -d '{
  "session":"s_demo1","type":"page_view","target":"/product/khadi-field-jacket",
  "meta":{"targets":["size-guide","cart-add"]}
}'
curl -s localhost:4000/event -H 'content-type: application/json' -d '{
  "session":"s_demo1","type":"dwell","target":"size-guide",
  "meta":{"ms":15000,"kind":"attention","interactions":{"hover_ms":3000,"clicks":1}}
}'

# 3. List recorded sessions:
curl -s localhost:4000/sessions | jq .

# 4. Inspect one:
curl -s localhost:4000/sessions/s_demo1 | jq .

# 5. Label the moment a highlight fired as the right call:
curl -s -X POST localhost:4000/sessions/s_demo1/labels \
  -H 'content-type: application/json' \
  -d '{"atEventIndex":1,"expected":"help","note":"size-guide dwell, highlight was right"}'

# 6. Replay it against the current prompt/rules:
JOB=$(curl -s -X POST localhost:4000/sessions/s_demo1/replay | jq -r .job)
curl -s localhost:4000/sessions/s_demo1/replay/$JOB | jq .

# 7. Export it as a fixture and promote it:
curl -s localhost:4000/sessions/s_demo1/fixture > sessions/demo1-hesitation.json
node replay.js sessions/demo1-hesitation.json --base http://localhost:4000

# 8. Force a decision on a still-live session right now:
curl -s -X POST localhost:4000/session/s_demo1/decide | jq .

# 9. Report an outcome for a delivered action (action_id from step 4's
#    decisions[].action.id), then check the aggregate:
curl -s localhost:4000/event -H 'content-type: application/json' -d '{
  "session":"s_demo1","type":"agent_outcome","target":"size-guide",
  "meta":{"action_id":"a_p2t6jgo4","action":"highlight","outcome":"dismiss","ms_visible":4200}
}'
curl -s localhost:4000/sessions/stats | jq .
```

## Tests

`npm run test:research` (`server/research.test.js`) drives a hesitation
sequence into a stub+debug server as live traffic, exercises every route
above end to end (including the fixture-export → `replay.js` round trip),
confirms the debug gate 404s every route on a plain server, and confirms
cached mode 409s `/session/:id/decide` and `/sessions/:id/replay` while the
4 recorded fixtures still go 4/4.

`npm run test:outcome` (`server/outcome.test.js`) drives the
sizing-hesitation fixture (deterministic card in stub mode) into an
isolated stub+debug server (its own temp `cwd`, so `sessions/live/` never
touches this repo's real one), reads the card's server-assigned action id
back off `GET /sessions/:id`, posts an `agent_outcome` "cta" event for it,
and asserts: it never triggers a new decision, `GET /sessions/:id` joins
`outcome: "cta"` onto the matching decision, `GET /sessions/stats` reports
`cta_rate: 1` for action type `"card"`, and a duplicate report for the same
action id is acknowledged but ignored.
