# server/ ops guide

Observability + concurrency safety layer over the vertical slice in `index.js`. See
`NOTES.md` for the decision loop itself (gate/tick/cache/backends); this doc covers
running, monitoring, and load-testing the server.

## Endpoints

| Route | Method | Gated by | Purpose |
|---|---|---|---|
| `/health` | GET | always on | Liveness + a snapshot: `ok, sessions, uptime_s, mode, backend, version, sockets, metrics: {llmCalls, cacheHits, llmErrors, avgLlmMs}`. |
| `/health/agent` | GET | always on | Decider self-test: runs the configured decider once against a fixed synthetic state (session id `__health__`, never a real session) through the same `decide()` entry point index.js uses. `{ok, mode, backend, latency_ms, decision, error, cached, ts}`. Cached 60s. `?force=1` only bypasses the cache when `AGENT_DEBUG=1` is set on the server — otherwise it's silently ignored (this route sits on the public tunnel; force must not be an unauthenticated LLM-call amplifier). Even when honoured, force can't re-run more than once per 10s (`AGENT_HEALTH_MIN_FORCE_INTERVAL_MS`), and concurrent callers (force or not) while a run is already in flight all await that same in-flight promise rather than each starting their own decide() call. The self-test's decide() call is counted against the same global `AGENT_MAX_INFLIGHT` cap as real `/event` traffic (`inflight.js`). 20s internal timeout. Never 500s on a decider failure — that's `ok:false` with a 200; 500 only on an actual bug in this route. |
| `/ready` | GET | always on | 200 `{ready:true}` once the HTTP server is listening AND the last `/health/agent` run (if any) was `ok:true` or never ran. 503 otherwise. Intended for a container orchestrator's readiness probe. |
| `/metrics` | GET | always on | Cost/decision counters snapshot (unchanged — see NOTES.md). |
| `/metrics/reset` | POST | `AGENT_METRICS_RESET=1` | Zeroes counters. 404 unless the env var is set. |
| `/logs/recent?n=100&level=info` | GET | `AGENT_DEBUG=1` | Last `n` (max 500) structured log entries, optionally filtered to `level` and above. 404 (route not registered at all) unless `AGENT_DEBUG=1`. |
| `/session/:id` | DELETE | `AGENT_DEBUG=1` | Dev-only demo aid: wipes ALL server-side memory of one session — `state.js`'s `resetSession()` (events, `actedTargets`, `lastInterventionAt`/`Target`, dwell buckets) plus this file's own per-session chain/coalescing bookkeeping and `decide/llm.js`'s per-session in-flight flag — so a fixture replay can be retaken without restarting the server (policy's cooldown / never-same-target guards otherwise remember the first take). 404 (route not registered) unless `AGENT_DEBUG=1`; 400 for an invalid session id (same regex as every other route). `{ok:true, existed: boolean}` on success. Does NOT close the session's WebSockets (the widget has no reconnect-on-close logic — see `DEMO.md`'s "Retakes" section). `decide/cached.js`'s replay-index (`session.events.length`) and its `x-agent-replay` header guard both keep working after a reset — the recording file on disk is untouched; only in-memory session state is cleared. |
| `/state/:id` | GET | always on | Read-only peek at a session's `buildState()` output. 404 if the session doesn't exist (unchanged). |
| `/demo/fixtures` | GET | always registered; full listing needs `AGENT_DEBUG=1` AND `AGENT_MODE=cached` | In-page ("no-terminal") demo player, see `DEMO.md`. When `AGENT_DEBUG=1` and `AGENT_MODE=cached`: lists the fixtures under `sessions/` that (a) have a `page_view` event (so `page` is always a string), (b) have a recording (`decide/cached.js`'s `hasRecording()`), and (c) whose recording actually verifies against the fixture's `expect` (`demo-play.js`'s `verifyRecording()` — an all-noop recording under a non-noop `expect` is excluded, with a startup warn). Shape: `[{name, session, description, expect, page, events}]` (`events` = count; `page` = the path a tab must be on, taken from the fixture's first `page_view` event). Otherwise (AGENT_DEBUG unset, or set but not cached mode): `200 []` — never 404, so a production/non-cached page's probe doesn't log a console error. |
| `/demo/play/:fixture` | POST | `AGENT_DEBUG=1` (registration); `AGENT_MODE=cached` (to actually run) | Plays one fixture's events, at fixture-scripted timing divided by `?speed=` (default `1` — real fixture timing, ~7–13s per fixture, the judge-visible story; clamped `1..50`), through `index.js`'s `processEventSerial()` — the same strict per-event serial decision path cached mode's live `/event` traffic uses (see "Decision coalescing" below) — in-process, not an HTTP self-call, so it never hits the cached-mode replay-header guard. 409 `{error:"demo player requires AGENT_MODE=cached"}` when the server isn't in cached mode (replaying a fixture feeds a full event sequence through the live decider — outside cached mode that's either meaningless or an unauthenticated LLM-call amplifier). Resets the fixture's session first (same `resetSessionFully()` helper `DELETE /session/:id` uses). 404 for an unknown/invalid fixture name (`^[a-z0-9-]+$`, path-traversal-safe) or one that doesn't verify (see `/demo/fixtures` above); 400 for a body `session` that doesn't match the fixture's own recorded session id (session remapping isn't supported — the caller must open the page with `?agent_session=<fixture session>` first); 409 if that fixture's session is already playing. Responds `202 {ok, fixture, session, events, estimatedMs}` immediately, then broadcasts `{kind:"demo", state:"start"\|"end"\|"error", fixture, events, error?}` on that session's WebSocket: `start` before feeding events, `error` (with a short message) if the whole play exceeds a watchdog of `estimatedMs*3+10000`ms or throws, `end` always (success or error) once the loop finishes. 404 (route not registered) unless `AGENT_DEBUG=1`. |
| `/sessions?limit=50` | GET | `AGENT_DEBUG=1` | Research loop (`server/RESEARCH.md`): newest-first summary of every recorded live session — `[{session, startedAt, lastAt, events, decisions, interventions, pages, labels, lastDecision}]`. 404 (route not registered) unless `AGENT_DEBUG=1`. |
| `/sessions/:id` | GET | `AGENT_DEBUG=1` | The full live-recording file for one session (`{session, startedAt, lastAt, mode, backend, model, events, decisions, labels}`). 404 if no such recording (or `AGENT_DEBUG` unset). |
| `/sessions/:id/labels` | POST | `AGENT_DEBUG=1` | Body `{atEventIndex:int, expected:"help"\|"quiet", note?:string≤200}` → appends a label, `200 {ok:true, labels}`. 400 for a malformed body, 404 for an unknown session. |
| `/sessions/:id/labels/:index` | DELETE | `AGENT_DEBUG=1` | Removes label `:index`. `200 {ok:true, labels}`; 400 for an out-of-range index, 404 for an unknown session. |
| `/sessions/:id/fixture` | GET | `AGENT_DEBUG=1` | Exports a `replay.js`-compatible fixture (`{name, session, description, expect, events}`) reconstructed from the recording — `events[].delay_ms` derived from consecutive `ts` values, `expect` taken from the decision at the last `expected:"help"` label's `atEventIndex` (else `{action:"noop"}`). See `RESEARCH.md`'s "fixtures promoted from real sessions" convention. 404 for an unknown session. |
| `/sessions/:id/replay` | POST | `AGENT_DEBUG=1`; `AGENT_MODE=llm\|stub` | Replays this session's non-replay-tagged recorded events, at original relative `ts` spacing but with no real-time delay, into a fresh shadow session `rp_<hash8>` through the CURRENT prompt/rules (`processEventSerial()`, strict per-event — tick/gate/policy all apply; see `RESEARCH.md`'s cooldown-timing caveat). `202 {job, shadowSession}`; broadcasts `{kind:"replay", state, job, done, total}` on the SOURCE session's WebSocket as it progresses. 409 if a replay is already running for this session, or if `AGENT_MODE=cached`. 404 for an unknown session. The shadow session is never itself live-recorded (`rp_` prefix). |
| `/sessions/:id/replay/:job` | GET | `AGENT_DEBUG=1` | Poll a replay job: `{state:"running"\|"done"\|"error", progress:{done,total}, decisions}`. 404 for an unknown job (or one belonging to a different session id). Jobs kept in memory, last 50. |
| `/session/:id/decide` | POST | `AGENT_DEBUG=1`; `AGENT_MODE=llm\|stub` | Forces a decision NOW for a live session — bypasses tick.js's quiet-tick check and gate.js's layer-0 gate, but NOT policy/cooldown. `200 {action, trace, ms}` after broadcasting like a normal decision (recorded with `reason:"forced"`). 409 if a decision is already in flight for this session, or if `AGENT_MODE=cached`. 404 if the session doesn't exist yet (has never received a real event). |
| `/`, `/agent.js`, `/demo.html`, `/embed` | GET | always on | Static embed hosting (`serve-static.js`'s `mountStatic()`, `server/public/`), mounted after every API route above so it can never shadow one. `agent.js` is served `Cache-Control: no-store`. |

## Env vars added this pass

| Var | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `info` | Minimum level printed to stdout (`debug\|info\|warn\|error`). Doesn't affect what lands in the `/logs/recent` ring buffer — every call is buffered regardless of level. |
| `LOG_PRETTY` | unset | `1` → one-line human-readable log format instead of raw JSON. |
| `AGENT_DEBUG` | unset | `1` → registers `GET /logs/recent`, `DELETE /session/:id`, `POST /demo/play/:fixture`, and switches `GET /demo/fixtures` from its always-on `200 []` stub to the full listing (the latter also needs `AGENT_MODE=cached`; see the endpoint table above). |
| `AGENT_MAX_INFLIGHT` | `32` | Global concurrent-decider-calls cap, process-wide (all sessions combined, INCLUDING `/health/agent`'s self-test — shared counter in `inflight.js`). Beyond it, a decision that's ready to call the decider WAITS (polling every 50ms) instead of skipping — events are never dropped, just delayed until capacity frees (see "Decision coalescing" below). `overloaded` metric increments once per wait-start; logged at `warn`. |
| `AGENT_MAX_SESSIONS` | `5000` | Session-store cap. Beyond it, least-recently-active sessions (by server-receive-time last event) are evicted; their WebSocket connections are closed with code `1001`. |
| `AGENT_STUB_DELAY_MS` | `0` | `decide/stub.js`-only, test-only: makes the stub decider resolve after this many ms instead of synchronously, simulating a slow (llm-speed) decider under `AGENT_MODE=stub` so `server/coalesce.test.js` can exercise decision coalescing deterministically without a real model call. `0` (default) is fully synchronous — zero behavior change for real usage. |
| `AGENT_LIVE_RECORD` | unset | `1` → enables `live-record.js` (see `server/RESEARCH.md`) even when `AGENT_DEBUG` isn't set — every live session's events/decisions get written to `sessions/live/<sessionId>.json`. `AGENT_DEBUG=1` also enables it (so the research API always has something to read on a debug server); this var exists to enable recording WITHOUT also exposing the debug-only research routes. |

## Decision coalescing (stub/llm mode)

`POST /event` never waits on the decider: the widget always gets an immediate `200 {ok, queued}` — state (session events, LRU eviction, metrics) is updated synchronously in the request handler (`processEventCore()`), and the decision (decider call, cooldowns, broadcast) always happens afterward, off the request.

There are two decision-scheduling paths, chosen by mode (`index.js`'s `decideAndBroadcast()` header comment is the single place this split is documented in code):

- **cached mode / `AGENT_RECORD=1`: strict per-event serial.** One decision per event, in arrival order (`runSerialized()`/`processEventSerial()`) — required because `decide/cached.js` indexes its recording by `session.events.length`; coalescing would desync playback. No per-session cap any more (the old `AGENT_MAX_QUEUE_PER_SESSION` is gone — see `NOTES.md`): this path is only ever driven by the demo player / `replay.js`, which pace themselves.
- **stub / llm mode (live traffic): coalesced.** At most one decision in flight per session, plus at most one *pending* — an event that arrives while a decision is already running for its session doesn't get a queued decision of its own; it just marks the session pending (latest state wins), and exactly one more decision runs, against the now-current state, the moment the in-flight one finishes. There is no per-session queue depth to exceed and nothing is ever rejected.

Metrics: `decisionsStarted` (one per decision cycle actually run — low even under a heavy burst, thanks to coalescing), `coalesced` (events that folded into an already-running or pending decision instead of starting their own), `pendingRuns` (how many "one more decision, folding N coalesced events" runs happened — logged at `info` with the fold count each time).

## Log format

JSON lines to stdout: `{ ts, level, msg, ...ctx }`. Example (`LOG_PRETTY` unset):

```json
{"ts":"2026-09-11T10:22:31.918Z","level":"info","msg":"decision","session":"fx_sizing_hesitation","event":"dwell","decided":"highlight size-guide","reason":"stub","ms":3}
```

Same line with `LOG_PRETTY=1`:

```
2026-09-11T10:22:31.918Z [INFO] decision {"session":"fx_sizing_hesitation","event":"dwell","decided":"highlight size-guide","reason":"stub","ms":3}
```

Every `/event` tick logs one `decision` entry at `info`:
`{session, event, decided: "highlight size-guide"|"noop", reason, ms}`.

`reason` is derived from what `index.js` already knows (tick/gate verdicts, and the
trace's own `why` prefix) — it never reaches into `decide/llm.js` internals. Values:
`gate` (tick/gate skipped the call), `quiet` (dwell stayed in the same bucket), `cache`
(llm decider served a cached hit — `why` started with `(cached)`), `llm` (a real model
call happened), `stub` (stub decider), `cached` (cached-mode replay decider), and two
added by this pass: `overloaded` (global in-flight cap tripped) and `guard` (policy.js
denied the proposal — `why` contains `(guard:`).

All `console.log/warn/error` calls in `index.js` were replaced by this logger.
`contracts.js`'s `console.warn` (lenient meta-shape validation) is untouched — out of
this pass's scope (not an owned file).

## Running the load test

```
node load-test.js --base http://localhost:4000 --sessions 50 --events 20 --concurrency 20 [--max-p95 200]
# or: npm run load -- --base http://localhost:4000 --sessions 50 --events 20 --concurrency 20
```

Spawns N virtual sessions concurrently (bounded by `--concurrency`); each opens a
WebSocket (`?session=<id>`) and POSTs a realistic event sequence (`page_view` with
`meta.targets`, a mix of `dwell`/`scroll_depth`, one `cart_update`) with small random
delays between events. Reports POST latency p50/p95/p99, error count (non-200 or
failed request), traces received per run, and WS drops (non-1000 closes). No new
dependencies — reuses `ws` (already a server dependency) and Node's built-in `fetch`.
Exits non-zero if any request errored or if p95 exceeds `--max-p95` (default 200ms).

## Process-level crash guard

`index.js` registers `process.on("unhandledRejection", ...)` and `process.on(
"uncaughtException", ...)` as a last resort: anything that slips past every local
try/catch and per-promise handler in this codebase is logged at `error` level (via
`log.js`, so it also lands in `/logs/recent` when `AGENT_DEBUG=1`) and bumps
`metrics.unhandledRejections`/`metrics.uncaughtExceptions` instead of crashing the
process (Node 20's default for an unhandled rejection is to exit). This is a backstop
for bugs we didn't anticipate, not a substitute for the specific fixes elsewhere in
this pass (stdin EPIPE handling in `decide/backends/shell.js`, the
`runSerialized`/`.then(cleanup, cleanup)` fix in `index.js`, `error` listeners on every
WS socket/server) — those are the ones that should actually fire in normal operation;
this guard existing at all is itself the signal something upstream needs a real fix, not
routine expected behavior.

## Docker healthcheck

Already in `server/Dockerfile`:

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
```

`/ready` (not `/health`) is the right target for a container healthcheck: it reflects
both "server is up" and "the last agent self-test, if any, didn't fail" — `/health`
alone would report `ok:true` even if the decider backend is completely dead.

## What "healthy" looks like on demo day

- `GET /health` — `ok:true`, `sessions` roughly matches active demo tabs, `mode`/`backend`
  match what you started the server with, `sockets` roughly `sessions * 1` (one widget
  tab each).
- `GET /health/agent` — `ok:true`, `decision` present (a real `{action, trace}` shape,
  even if it's a `noop`), `latency_ms` small (instant in `stub`/`cached` mode; a few
  hundred ms to low seconds in `llm` mode against a warm cache; higher, up to the 20s
  internal cap, on a cold real model call).
- `GET /ready` — 200.
- No `overloaded` or `llm error` lines in the last `/logs/recent?level=warn` (needs
  `AGENT_DEBUG=1`) during a live run.

## Incident checklist (agent health red)

1. `curl :$PORT/health/agent?force=1` — confirm it's actually failing now, not a stale
   60s-cached result.
2. If `error` mentions a timeout/HTTP failure → check backend quota/connectivity
   (codex CLI quota window, or `OPENAI_API_KEY`/`OPENAI_BASE_URL` reachability).
3. Buy time: `AGENT_MODE=cached` (replay a known-good recording) or `AGENT_MODE=stub`
   (deterministic rule) — restart the server with one of these; no code change needed.
4. Watch `/metrics`' `llmErrors` / `overloaded` counters and `/logs/recent?level=warn`
   for the failure signature repeating.
5. Once the backend recovers, restart with `AGENT_MODE=llm` again and re-check
   `/health/agent?force=1` before resuming the demo.

## Behind a tunnel or reverse proxy

`server/index.js` sets `server.keepAliveTimeout = 65s` (Node default 5s).
cloudflared/nginx reuse idle keep-alive connections; with the default the
origin resets a connection the proxy just reused and the browser sees a 502
with no CORS headers ("blocked by CORS policy" on `POST /event`). Observed
once on 2026-09-11 through a quick tunnel before the change. If it recurs,
check `docker compose logs tunnel-server` for "connection reset by peer".
