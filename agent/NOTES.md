# server/ module map

- `contracts.js` — EVENT_TYPES, ACTIONS, META_SHAPES, `validateMeta()` (lenient: unknown keys ok, wrong types just warn).
- `state.js` — session store (ring buffer 200 events, cooldown/actedTargets bookkeeping), `buildState(session)` (LLM input shape), `summarize(events)`.
- `policy.js` — `normalize(proposed, session)` + `applyPolicy(session, state, proposed, opts)`. `normalize()` is the untrusted-decider-output boundary: rebuilds action/trace to EXACTLY the contract fields (exact-string action, clamped duration/confidence, trimmed/length-capped message, array-or-summarize signals) before any guard runs, on every path (allow/deny/throw). `applyPolicy` then runs: allow-list, visibleTargets check (now applies to `message` targets too, not just page-changing actions), 30s cooldown, no-repeat-target, message length guard. `opts.skipCooldown` (cached-mode playback only) skips the wall-clock cooldown while keeping allow-list/target/shape guards. Any violation/error → noop with `why: "<human sentence> (guard: <reason>; proposed <decision>)"`.
- `decide/stub.js` — deterministic rule stand-in: fires ONLY when the current event is itself a `dwell` and `state.dwell.pageMs >= 5000` (previously any event once pageMs crossed 5s, including scroll_depth/back_nav, could re-propose). Pure, no cooldown logic.
- `decide/llm.js` — build-day stub, throws until written.
- `decide/cached.js` — replays `sessions/recorded/<sessionId>.json` by event index; falls back to stub (and `console.warn`s once per session when it does). Also exports `record()` for `AGENT_RECORD=1`. See "Cached mode semantics" below.
- `decide/index.js` — picks decider by `AGENT_MODE`.
- `tick.js` — `shouldCallDecider()`: throttles decider calls to 1/15s for non-dwell-triggered llm mode only. Bypassed for `AGENT_MODE=stub`, `AGENT_MODE=cached`, and whenever `AGENT_RECORD=1` — all three need a decider call on every event (see comment in index.js).
- `index.js` — http/ws wiring only: validate session id + event shape → push event → tick → decide → applyPolicy → broadcast. Wire messages (`{kind:"action",...}` / `{kind:"trace",...}`) are built explicitly field-by-field, never by spreading a decider/policy object — `kind` can never be overridden by decider output. `GET /state/:session` is a read-only peek (404 if the session doesn't exist; never creates one).

## Session id validation

Any session id entering the system — `POST /event` body, WS `?session=` query param, `GET /state/:session` — must match `/^[A-Za-z0-9_-]{1,64}$/` (`isValidSessionId()` / `SESSION_ID_RE` in `contracts.js`). Invalid → 400 on HTTP routes, WS close code 1008. `decide/cached.js` additionally re-checks this before touching the filesystem and verifies the resolved recording path stays inside `sessions/recorded/` (defense in depth against a session id smuggling `../`).

## Cached mode semantics

- The decider is called on **every event** in cached mode (see tick.js note above) because a recording has exactly one entry per event — index-in-recording must equal index-in-session.events for playback to line up.
- What gets recorded (`AGENT_RECORD=1`) is the decider's **pre-policy proposal**, not the post-policy `{action, trace}` — policy re-runs identically on playback.
- Cached playback skips the wall-clock 30s cooldown (`applyPolicy(..., {skipCooldown: true})`): replaying with `--speed 10` compresses real time, so a proposal legitimately spaced >30s apart during recording can land <30s apart on playback and get wrongly denied. Allow-list/target/shape guards and no-repeat-target still apply.

## Env vars

- `PORT` — http port (default 4000).
- `AGENT_MODE` — `stub` (default) | `llm` | `cached`.
- `AGENT_RECORD` — `1` to append the decider's pre-policy proposal for every event to `sessions/recorded/<sessionId>.json`.
- `REPLAY_FIXED_SESSION` (replay.js) — `1` disables the per-run session suffix so record and playback share an id.

Record → playback recipe (after tuning tomorrow):
```
AGENT_MODE=cached AGENT_RECORD=1 node index.js &   # or AGENT_MODE=llm AGENT_RECORD=1
REPLAY_FIXED_SESSION=1 node replay.js sessions/*.json
# restart:
AGENT_MODE=cached node index.js &
REPLAY_FIXED_SESSION=1 node replay.js sessions/*.json   # must match the recorded run
```

## Asks for storefront dev

1. `page_view` events must carry `meta.targets` = all `[data-agent-target]` ids present on the page. Without this the server allows any target (backward compat), but real target-validation only works once this is sent.
2. `cart_view` / `cart_update` events must carry `meta.{ total, items }` (items: `{sku, qty, price}[]`) so `buildState().cart` is populated for tomorrow's LLM input.
3. Trace panel list `key` should not be `t.ts` alone — at high replay speed (`--speed 10`+) or with cached playback, two traces can share the same `ts` and collide as React keys. Key on `` `${t.ts}-${i}` `` (index in the rendered list) instead.
4. The widget must tolerate a trace with an empty `signals` array. The server now always guarantees `signals` is an array (never undefined/null — `normalize()` in `policy.js` falls back to `summarize(session.events)` when the decider's `signals` is missing/invalid), but render defensively anyway (empty state, not a crash) since that's cheap insurance.

## Open decision — cart-threshold fixture cooldown conflict

`sessions/cart-threshold.json` expects TWO interventions — a `message` (about the ৳50 gap) AND a `scroll_to shipping-banner` — inside the 30s cooldown window, which `policy.js`'s "max one intervention per 30s" rule forbids by design. Pending product decision, not changed by this pass. Options on the table:

- (a) Expected result becomes a single `message` only (drop the `scroll_to` expectation).
- (b) Widget scrolls to `target` itself when a `message` action carries a non-null `target`, so the server only needs to emit one `message` action (whose target is `shipping-banner`) instead of two separate actions.
- (c) Policy exempts `scroll_to` specifically from the cooldown (weakens "one intervention per 30s" as a blanket rule).

Do not change `sessions/cart-threshold.json`'s `expect` until this is decided — the fixture is expected to FAIL under the current policy (see acceptance run in the review pass that added this section).

## Tomorrow

Write `decide/llm.js`. Input is `buildState()` output (+ session). Output is `{ action, trace }`. Policy (`policy.js`) and tick throttling (`tick.js`) already handle safety — the LLM decider can propose freely.

## LLM decider

`decide/llm.js` exports `decide(state, session) → Promise<{action, trace}>`. `index.js`'s
`/event` handler `await`s it; stub/cached deciders stay sync-returning (`await` on a plain
value is a no-op, so both paths work through the same call site).

### Backends — `LLM_BACKEND` env: `codex` (default) | `claude` | `openai` | `anthropic` | `gemini`

As of the M4 pass (2026-09-11), shell-out backends (codex, claude) share one generic
subprocess runner, `decide/backends/shell.js` (argv via `execFile`, no shell; prompt on
stdin; hard timeout that kills the WHOLE process group via `detached:true` +
`process.kill(-pid)`, not just the direct child; stdout/stderr capped at 64KB each;
unique out-file, if any, always cleaned up). This closes the "grandchild kill on codex
timeout" gap listed under "Known limits" below — both codex and claude now get
process-group kill on timeout. Each backend is its own module under `decide/backends/`;
`decide/llm.js` keeps prompt building, the fingerprint cache, in-flight guard/queue,
`validateProposalShape`, and metrics, and dispatches to whichever backend module
`LLM_BACKEND` selects via a small registry (also holds each backend's default
model/timeout, overridable by `LLM_MODEL`/`LLM_TIMEOUT_MS`).

| backend | auth | latency observed (this machine) | quota/cost notes | tested in this pass |
|---|---|---|---|---|
| `codex` (default) | local `codex` CLi, ChatGPT/API auth via `~/.codex` | 10.4–15.0s (5-call probe, `gpt-6-astra`) | personal ChatGPT auth hit a daily usage-limit wall after ~30 calls in an earlier pass | not re-run this pass (quota); code path untouched except the shared shell runner |
| `claude` | local `claude -p` CLI, `~/.claude` login (OAuth or API key) | 14.0–30.1s (5-call direct probe: min 14015ms / median 23072ms / max 30087ms, one hit the 30s default timeout) | Claude Code subscription/API usage; `--no-session-persistence` avoids leaving resumable sessions on disk per call | **yes** — see "claude backend measurement" below |
| `openai` | `OPENAI_API_KEY` bearer to `OPENAI_BASE_URL` — covers **OpenAI itself, OpenRouter, or a local Ollama server** (any OpenAI-chat-completions-compatible endpoint) by pointing `OPENAI_BASE_URL` at it | 61.9s/call (`qwen2.5:3b` on Ollama, CPU) — see "Run status" below | free (local Ollama) or metered per the endpoint | tested in an earlier pass against Ollama, not re-run since |
| `anthropic` | `@anthropic-ai/sdk`, resolves `ANTHROPIC_API_KEY` or an `ant auth login` profile | n/a — no key on this machine | untested-live; code path + auth-failure noop verified (see below) | **no** (no key) |
| `gemini` | `@google/genai` SDK, resolves `GEMINI_API_KEY` or `GOOGLE_API_KEY` | n/a — no key on this machine | untested-live; code path + auth-failure noop verified (see below); exact model id `gemini-2.5-flash-lite` NOT confirmed against a live `models.list()` — do that first once a key is available | **no** (no key) |

- **codex**: `decide/backends/codex.js`, using the shared shell runner. Behaviour
  unchanged from before the refactor: `exec --ephemeral --skip-git-repo-check -s
  read-only -C <fixed empty tmp dir created on first use> --output-schema
  <copied schema.json> -o <unique tmp file per call> [-m $LLM_MODEL]`, prompt on stdin,
  `tokens used\n<N,NNN>` parsed from stdout/stderr into `tokensTotalCodex`. Default
  timeout 20000ms.
- **claude**: `decide/backends/claude.js`. Spawns `claude -p --model $LLM_MODEL
  --output-format json --tools "" --no-session-persistence --system-prompt
  <prompts/decide.md> --json-schema <schema.json>` via the shared shell runner, with
  `state JSON + "\nDecide."` on stdin. `--tools ""` disables ALL tools (per `claude
  --help`: `""` = none, `"default"` = all) — the decider must never get Bash/Read/etc.
  `--json-schema <schema>` IS a real structured-output flag on this CLI (confirmed via
  `claude -p --help`) — when given, the JSON envelope includes a pre-parsed
  `.structured_output` object alongside the usual `.result` string; the backend prefers
  `.structured_output` and falls back to parsing `.result` (stripping a ```` ```json ````
  fence if present) only if it's missing. `LLM_MODEL` default `"haiku"` for this backend
  specifically (registry-level per-backend default, not a global one). `CLAUDE_BIN` env,
  default `claude`. Default timeout 30000ms (raised vs the other backends' 20000ms — this
  CLI's per-call overhead runs noticeably higher, see latency table above; even so one
  probe call hit the 30s ceiling and errored to noop, see "claude backend measurement").
  Token usage: `envelope.usage.input_tokens + cache_creation_input_tokens +
  cache_read_input_tokens` as `tokensIn` (all three are billed input-token categories
  under Anthropic pricing), `usage.output_tokens` as `tokensOut`; chars/4 estimate only if
  `usage` is absent entirely. Nested-session note: the server process itself sometimes
  runs INSIDE a Claude Code session (dev), setting `CLAUDECODE=1` in its env — tested
  in one run, a nested `claude -p` call **succeeded even with `CLAUDECODE=1` still set** (no
  refusal observed); the backend strips it from the child's env anyway as a no-cost
  defensive measure in case a future CLI version changes that behavior.
- **openai**: `decide/backends/openai.js`, moved unchanged out of `decide/llm.js`. Plain
  `fetch` to `${OPENAI_BASE_URL:-https://api.openai.com/v1}/chat/completions` with
  `OPENAI_API_KEY` bearer auth — works unmodified against **OpenAI, OpenRouter, or a
  local Ollama server** (`OPENAI_BASE_URL=http://localhost:11434/v1`, any API key
  string), by overriding `OPENAI_BASE_URL`; any server speaking the OpenAI
  chat-completions shape is fair game. **Tested against Ollama (`qwen2.5:3b`)** in an
  earlier pass — see "Run status" below. Two JSON modes, auto-detected once at startup
  unless `LLM_JSON_MODE=schema|object` pins one: `schema` sends
  `response_format:{type:"json_schema",json_schema:{schema,strict:true}}` (OpenAI, and
  Ollama's OpenAI-compat endpoint — confirmed via curl probe, no 400 even against the
  full `prompts/schema.json`); `object` sends `response_format:{type:"json_object"}` with
  the schema pasted into the system prompt instead, for servers that reject `json_schema`
  (400 → runtime fallback, remembered for the rest of the process). `usage.prompt_tokens`/
  `usage.completion_tokens` from the response are recorded as `tokensIn`/`tokensOut`
  regardless of JSON mode. Kept short, no new deps (plain `fetch`).
- **anthropic**: `decide/backends/anthropic.js`, using `@anthropic-ai/sdk`
  (`npm i @anthropic-ai/sdk`, the one new dep this pass allows for this backend).
  `new Anthropic()` resolves `ANTHROPIC_API_KEY` or an `ant auth login` profile — never
  hardcoded. `LLM_MODEL` default `"claude-haiku-4-5"`. Uses `client.messages.create`
  (not `.parse` — `.parse`'s typed parsing path is built around `zodOutputFormat()`;
  feeding it a raw JSON-Schema object doesn't buy anything `.create` + a manual
  `JSON.parse` of the first text block doesn't already give) with `output_config: {
  format: { type: "json_schema", schema } }`, confirmed against the installed SDK's
  types (`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts`:
  `JSONOutputFormat = { type: "json_schema", schema }`, exactly this shape). No
  `budget_tokens`/thinking config — not needed for a 5-way classification.
  **Schema adaptation**: `prompts/schema.json`'s `action.style` field is
  `{"type":["string","null"],"enum":["pulse","outline",null]}` (enum-with-null combined
  with a type array) — untested against the live API (no key here), so
  `buildAnthropicSchema()` proactively swaps it for an `anyOf` branch (`{type:"string",
  enum:[...]}` OR `{type:"null"}`) in a backend-local schema copy; `prompts/schema.json`
  itself is unchanged. Errors mapped separately per the brief:
  `Anthropic.RateLimitError` → `"rate limited"`, `Anthropic.APIConnectionError` →
  `"connection failed"`, `Anthropic.AuthenticationError` (401) → `"auth"`, any other
  `Anthropic.APIError` → `"api error <status>"`. **Verified**: with no
  `ANTHROPIC_API_KEY` configured, the SDK throws a plain `Error` (NOT an
  `AuthenticationError`/`APIError` instance — no HTTP call is even attempted) with
  message `"Could not resolve authentication method. Expected one of apiKey, authToken,
  credentials, config, or profile to be set..."`; the backend pattern-matches this
  message (`/authentication method|api.?key/i`) into the same `"auth"` bucket, and a live
  `decide()` call confirmed the end-to-end result: noop proposal, `trace.why: "llm error:
  auth"`. **Untested beyond that** — no key on this machine to exercise a real 200/401
  API round-trip or the schema adaptation against the live structured-output validator.
- **gemini**: `decide/backends/gemini.js`, using `@google/genai`
  (`npm i @google/genai@2.21.0`). `new GoogleGenAI({})` resolves `GEMINI_API_KEY` or
  `GOOGLE_API_KEY` from env (SDK checks `GOOGLE_API_KEY` first, warns to stderr if both
  are set). `LLM_MODEL` default `"gemini-2.5-flash-lite"` — **not verified against a live
  `models.list()`** as ideally it should be (no key on this machine to do so); confirm
  the id exists before relying on it once a key is available. Uses
  `models.generateContent({model, contents: prompt, config: {systemInstruction,
  responseMimeType:"application/json", responseSchema, abortSignal}})`. **Schema
  adaptation** (required, not just defensive — Gemini's schema dialect is NOT plain JSON
  Schema): `schemaToGemini()` converts `prompts/schema.json` into the SDK's `Schema`
  shape — `type` becomes a single upper-case `Type` enum member instead of a
  `["string","null"]` array (nullability moves to a separate `nullable: true` flag),
  `enum` becomes a plain string array with any `null` member stripped (mapped to
  `nullable: true` instead), and `additionalProperties` is dropped (not part of the
  dialect). `prompts/schema.json` itself is unchanged. Errors: an `ApiError` (SDK's own
  error class) with status 401/403 → `"auth"`, status 429 → `"rate limited"`; a
  credentials-resolution failure that happens BEFORE any HTTP call (see below) is
  pattern-matched the same way as the anthropic backend. **Verified**: with no
  key configured, the SDK does NOT throw at construction — it falls through to
  Application Default Credentials and `generateContent()` throws a plain `Error`,
  `"Could not load the default credentials. Browse to
  https://cloud.google.com/docs/authentication/getting-started..."`; a live `decide()`
  call confirmed the end-to-end result: noop, `trace.why: "llm error: auth"`.
  **Untested beyond that** — no key on this machine for a real round-trip or to verify
  the model id / schema conversion against the live API.
- Any backend failure (timeout, non-zero exit, bad/missing JSON, auth, rate limit,
  connection) → noop proposal, `trace.why: "llm error: <reason>"`, `confidence: 0`. Never
  throws — `decide()`'s try/catch in `index.js` is effectively dead code for the llm path
  but stays as defense in depth.

### claude backend measurement (M4 pass, 2026-09-11)

`AGENT_MODE=llm LLM_BACKEND=claude AGENT_METRICS_RESET=1 PORT=5100 node index.js` +
`node replay.js sessions/*.json --speed 2 --settle 30000`, run twice (first before,
second after `sessions/cart-threshold.json`'s `expect` was updated elsewhere during this
session to a single `{action:"message", target:"shipping-banner"}` — resolving the "Open
decision" above via option (b): the widget now scrolls to a `message` action's target
itself, so the server only needs to emit one action; that change is NOT part of this
pass, just observed mid-session):

- `sizing-hesitation`: **PASS** both runs (`highlight size-guide` fired on sustained
  size-guide dwell).
- `happy-browsing`: **PASS** both runs (noop throughout, correct restraint on a
  near-threshold cart during calm browsing).
- `cart-threshold`: **FAIL** on the first run (old two-action `expect`, inside the 30s
  cooldown `policy.js` forbids by design — the then-documented unsatisfiable case), **PASS**
  on the second run/the `cost-compare.js --label claude-cold` run below (new single-action
  `expect`, satisfied directly, no policy change needed).
- One `dwell size-guide` call in each run hit the 30s default timeout and errored to noop
  (`llm error: timeout after 30000ms`) — both runs still passed their sizing-hesitation
  fixture because a later dwell tick on the same target re-triggered `highlight
  size-guide` successfully, but this shows 30000ms is a tight-not-generous default for
  this backend.

Direct 5-call `decide()` latency probe (bypassing the cache, fixture-derived states):
**min 14015ms, median 23072ms, max 30087ms** (the max is the timeout-and-noop case
above, i.e. the "successful call" ceiling is closer to ~26s and the tail is longer than
codex's or a fast API model's).

`cost-compare.js --label claude-cold --price-in 1.00 --price-out 5.00 --speed 2 --settle
30000` (Haiku 4.5 list price, no cached-input tier applied), run against the same server
right after the fixture run above (so this is a warm-ish cache, 1 hit / 21 misses, not a
clean cache-off measurement):

```
ticks=35  quietTicks=5  gated=8  llmCalls=17  sessions=3
callsPerSession=5.67  cacheHitRate=4.5%  (1 hits / 21 misses)
tokens/call: in=25628 out=1446
avg ms/call=25957  llmErrors=4
est. cost per 1,000,000 sessions = $186,190
fixture verdicts: {"cart-threshold":"PASS","happy-browsing":"PASS","sizing-hesitation":"PASS"}
```

**~25.6K input tokens/call here = Claude Code CLI harness overhead, NOT our prompt.**
The claude backend shells out to the `claude -p` CLI (see `decide/backends/claude.js`),
which injects its own system scaffolding/session bookkeeping on top of whatever
`--system-prompt`/stdin we send — our actual prompt (`prompts/decide.md` + state JSON)
is ≈1.1K tokens. This whole row is therefore **NOT API-comparable**: it measures "cost of
running Claude Code CLI as a decider backend," not "cost of calling the Claude API with
our prompt." For an apples-to-apples API-comparable figure, see the openai row (uses
the OpenAI API's own `usage.prompt_tokens`, no CLI harness in between) elsewhere in this
file. The `$186,190/1M sessions` figure above should be read/quoted as "cost of running
Claude Code CLI as a backend for this workload," not as what a Claude API deployment of
the same prompt would cost.

A true cache-cold vs cache-warm pair (two separate server processes, per the "Cost
design" recipe below) was not additionally re-run — this single `claude-cold` row
is the one saved to `metrics-runs/claude-cold-*.json`; treat `tokens/call: in=25628` as
dominated by the CLI harness overhead above (not `prompts/decide.md` + state JSON) and
by Claude's own prompt caching re-creating the harness's cache entry on nearly every
call, not a cross-run steady-state average.

### codex backend, facts-threshold re-record (2026-09-11 ~06:50)

`facts-threshold` had no documented pass on any backend as of the claude-backend
measurement above (claude did not act on page facts alone). Re-recorded with
`LLM_BACKEND=codex` (model `gpt-6-astra`, ChatGPT login) after one prompt
clarification in `prompts/decide.md` — the `action.target` bullet now says a
`message` targets the element it's about, so the widget knows to scroll to it.
Recording (`sessions/recorded/fx_facts_threshold.json`) is 8 proposals; index 6 is
`message shipping-banner` (86% confidence, hypothesis about the cart→checkout→cart
return plus the parsed ৳50 gap) — satisfies `expect`. Cached-mode replay of
`sessions/*.json` is now **4/4** (up from 3/4). Keys-vs-snippets remains open —
see `server/FACTS.md`'s R&D recipe; this recording sent both.

### Concurrency + per-session in-flight guard

Tiny queue, `LLM_MAX_CONCURRENT` (default 2) concurrent codex/openai calls process-wide. If a
call for a given session is already in flight, a new `decide()` for that session short-circuits
to a noop proposal with `why: "decision in progress"` instead of queuing (avoids piling up slow
calls behind each other for one shopper).

### Fingerprint cache

Key = sha256 of the **exact prompt string sent to the model** (system prompt +
`JSON.stringify(state)` + the trailing "Decide." line), not a hand-picked subset of state
fields. A prior version hashed a curated subset (`page`, `visibleTargets`, `cartBucket`,
`dwellBucket`, per-target dwell buckets, last-6 `recent` tail, `lastIntervention.target`) — any
state field the model actually saw but the subset omitted could make two genuinely different
prompts collide on the same key and serve a stale cached decision for a situation the model
never evaluated (fixed as part of the M1 review pass, 2026-09-11). Hashing the literal prompt
text trades a lower hit rate (near-but-not-identical situations now miss instead of colliding)
for the correctness guarantee that a cache hit can only happen when the model would have seen
byte-identical input. `bucketCart`/`bucketDwell` are still used, just for a coarse `page|cart:X|
dwell:Y` "class" string logged alongside cache stats, not for the key itself. `Map`, TTL
`LLM_CACHE_TTL_MS` (default 10 min), max 500 entries (oldest evicted on overflow — insertion-
order eviction, not LRU). Hit → returns the cached `{action, trace}` with `trace.why` prefixed
`"(cached) "` and `trace.ts` refreshed to now. Hit/miss counters log to console every 20 total
calls (`[llm] cache: N hits / M misses (T total)`), and only fire when the cache is enabled
(`LLM_CACHE!=="0"`) — see "Metrics counter accuracy" below. `GET /metrics` exposes
`cacheEnabled` so a consumer can distinguish "no traffic yet" from "cache off, hits/misses
aren't tracked at all".

### Metrics counter accuracy (M3 review pass, 2026-09-11)

Two counter-bias bugs fixed:

- `llmCalls` previously incremented as soon as a backend call was *attempted*, before knowing
  whether it succeeded — a timeout or non-zero exit still counted as a "call" for the
  cost-per-call averages (`tokensPerCallIn`/`avgLlmMs`/etc.), understating true per-successful-
  call cost. Now incremented only after the backend call returns AND `validateProposalShape()`
  passes; every failure path (timeout, bad JSON, invalid shape) increments `llmErrors` only.
- `cacheMisses` previously incremented on every `decide()` call regardless of `LLM_CACHE`
  (double-counting "disabled" as "miss") and even on the per-session in-flight short-circuit
  (which never touches the cache at all, real or not). Now: skipped entirely when
  `LLM_CACHE_ENABLED` is false, and only incremented once the call is past the in-flight check
  and committed to a real backend call.

### Latency observed (this machine, `gpt-6-astra` via ChatGPT auth, real prompt + state)

5 direct `decide()` calls (bypassing the cache) against fixture-derived states: **min 10448ms,
median 11052ms, max 15019ms**. A trivial schema-only probe (no system prompt) was ~9-10s, so
most of the latency is the model call itself, not prompt size. This is why `tick.js`'s 15s
dwell throttle and replay's default 500ms post-fixture settle are both too tight for llm mode —
see the `test:llm` recipe below.

### Running fixtures in llm mode

```
AGENT_MODE=llm PORT=4700 node index.js &
AGENT_HTTP=http://localhost:4700 node replay.js sessions/*.json --speed 2 --settle 15000
```
`npm run test:llm` runs `AGENT_MODE=llm node replay.js sessions/*.json` against a server you
must start separately (`AGENT_MODE=llm node index.js`) — the env var on the replay side does
nothing (replay is the HTTP client, not the server); it's there as a reminder of which mode the
server needs. In practice also pass `--speed 2 --settle 15000` (not the npm script's bare
invocation) so ~11-15s LLM calls have room to land before replay closes the socket and grades
the fixture.

Observed per-fixture result (3 prompt-tuning rounds against `prompts/decide.md`):
- `sizing-hesitation` (fixture 1): **PASS** — `highlight size-guide` fires on the second visit
  after repeated size-guide dwell, consistent across repeated runs; second consecutive run
  showed `(cached)` hits (identical fingerprint on identical event sequence).
- `cart-threshold` (fixture 2): model proposes `message` (the ৳50 gap) at the correct moment
  (bounce back to `/cart` from `/checkout`), matching one of the two expected actions, but never
  the second (`scroll_to shipping-banner`) — it's inside the 30s cooldown, which `policy.js`
  forbids by design. This is the known-unsatisfiable case (see "Open decision" above); fixture
  not modified.
- `happy-browsing` (fixture 3): **PASS** — noop throughout; required tightening the prompt so a
  near-threshold cart alone doesn't trigger a message. Rule that worked: a delivery-gap message
  needs BOTH being on `/cart` or `/checkout` AND a hesitation signal there (dwell or bounce),
  not just proximity to the ৳2,000 threshold while still browsing products.

### Env vars (llm mode)

- `LLM_BACKEND` — `codex` (default) | `claude` | `openai` | `anthropic` | `gemini`.
- `LLM_TIMEOUT_MS` — per-backend default: 20000 for codex/openai/anthropic/gemini, 30000
  for claude. Set explicitly to override for whichever backend is selected.
- `LLM_MAX_CONCURRENT` — default 2.
- `LLM_CACHE_TTL_MS` — default 600000 (10 min).
- `LLM_MODEL` — per-backend default if unset: codex has none (CLI default), claude
  `"haiku"`, openai `"gpt-4o-mini"`, anthropic `"claude-haiku-4-5"`, gemini
  `"gemini-2.5-flash-lite"`.
- `CODEX_BIN` — path to the codex binary, default `codex`. codex backend only.
- `CLAUDE_BIN` — path to the claude binary, default `claude`. claude backend only.
- `OPENAI_API_KEY`, `OPENAI_BASE_URL` — openai backend only. Covers OpenAI, OpenRouter, or
  a local Ollama server, selected via `OPENAI_BASE_URL`.
- `LLM_JSON_MODE` — `schema` | `object`, openai backend only. Unset (default) auto-detects
  once at startup by probing the endpoint; set explicitly to skip the probe and any
  runtime 400-triggered fallback.
- `ANTHROPIC_API_KEY` — anthropic backend only. Resolved by `@anthropic-ai/sdk`; an
  `ant auth login` profile also works if no env var is set.
- `GEMINI_API_KEY` / `GOOGLE_API_KEY` — gemini backend only. Resolved by `@google/genai`
  (checks `GOOGLE_API_KEY` first, warns if both are set).

## Cost design

Goal: cheap-by-design LLM calls, with hard numbers (calls, tokens, ms) rather than
felt-sense. Four layers, cheapest first:

- **Layer 0 — `gate.js`** (llm mode only). `gate(state, session, event) → {pass, reason}`.
  Deterministic, no model call. Blocks: `/checkout` with no `rage_click`/`back_nav` in the
  last 3 events; a `dwell` event before its own subject (page, or the specific element it
  targets — see `buckets.js`'s `isPageDwellTarget()`) has been dwelled 5s; any event inside
  the 30s cooldown after a non-noop intervention; `cart_update` when the cart is already ≥
  ৳2,000 (no threshold left to cross); non-empty `search` on a listing page (self-serving).
  Applied only when `AGENT_MODE=llm` and the event already passed the tick trigger below —
  stub/cached bypass it entirely (cached needs one decider call per event to stay
  index-aligned with its recording; stub is the vertical slice and untouched).
- **Layer 1 — `tick.js`** (llm mode only). `shouldCallDecider(session, event, state)`
  replaces the old 15s wall-clock throttle with a signal-class trigger: any non-dwell
  event always calls; a `dwell` event only calls if it crosses a dwell bucket boundary
  (`0-5s | 5-20s | 20-60s | 60s+`, from `buckets.js`, shared with the fingerprint cache
  below so "same situation" means the same thing in both places), tracked **per dwell
  subject** — `session.lastDwellBuckets` is a map keyed `"__page__"` or the specific
  target name, since page-level dwell (`state.dwell.pageMs`) and per-element dwell
  (`state.dwell.perTarget[target]`) advance independently (see `state.js`). A prior
  version tracked only the page bucket, which meant a run of per-element dwell events
  (e.g. repeated `size-guide` dwell) stopped registering as a class change once the
  page-level bucket had already settled — see "Run status" below for the fix and its
  effect on `sizing-hesitation`. Dwell events whose OWN subject stays in the same bucket
  are quiet ticks — server replies with the last-known-shape noop trace, no decider call
  at all.
- **Layer 2 — fingerprint cache** (`decide/llm.js`, still llm mode only). Repeated
  identical situations (same page/targets/cart bucket/page dwell bucket/**per-target
  dwell buckets**/recent tail/last-intervention target) reuse a cached `{action, trace}`
  instead of a new model call — per-target dwell buckets were added to the fingerprint
  for the same reason as Layer 1's per-subject fix (a page-dwell-only key would treat two
  different per-element dwell situations as the same cache hit). `LLM_CACHE=0` disables
  the cache entirely (every call is a forced miss) — used for the cache-off comparison
  run. TTL/size unchanged (`LLM_CACHE_TTL_MS`, 500-entry cap).
- **Layer 3 — the actual model call** (codex or openai backend, unchanged call shape).
  Token accounting added: codex backend parses the `tokens used\n<N,NNN>` line codex
  prints to stdout after the response (probed once — see below) into
  `tokensTotalCodex`; that figure includes codex's OWN system instructions/session
  overhead on top of ours, so it is NOT what an API deployment would be billed. Alongside
  it we record `tokensInEst = round((SYSTEM_PROMPT + state JSON).length / 4)` and
  `tokensOutEst = round(JSON.stringify(modelOutput).length / 4)` as the API-comparable
  estimate (`tokensIn`/`tokensOut` in `/metrics`). The openai backend instead uses the
  API's own `usage.prompt_tokens`/`usage.completion_tokens` — exact, no estimation.

Codex probe (one-off, `codex exec` with a trivial prompt):
```
$ echo 'Reply with {"ok":true}' | codex exec --ephemeral --skip-git-repo-check -s read-only -C <dir> --output-schema schema.json -o out.json -
...
codex
{"ok":true}
tokens used
19,344
{"ok":true}
```
Confirms `tokens used\n<N,NNN>` (comma-separated thousands) on stdout — regex in
`decide/llm.js` is `/tokens used\s*\r?\n\s*([\d,]+)/i`.

### Metrics (`metrics.js`, `GET /metrics`, `POST /metrics/reset`)

In-process counters (reset on process restart, no persistence): `ticks`, `quietTicks`,
`gated`, `llmCalls`, `cacheHits`, `cacheMisses`, `llmErrors`, `tokensIn`, `tokensOut`,
`tokensTotalCodex`, `llmMsTotal`, `sessions` (distinct session ids seen, via
`inc("sessions", sessionId)` — the one counter that's a Set, not a running total).
`GET /metrics` returns the snapshot plus derived `callsPerSession`, `cacheHitRate`,
`tokensPerCallIn`, `tokensPerCallOut`, `avgLlmMs`, `cacheEnabled`, all divide-by-zero safe.
`POST /metrics/reset` is registered **only when `AGENT_METRICS_RESET=1`** — 404 otherwise (was
gated on `NODE_ENV!=="production"` until the M2 review pass, 2026-09-11: that meant the reset
route was live by default in every dev/demo run, including the docker-compose server, which
never sets `NODE_ENV=production` — anything able to reach the port could zero the cost counters
mid-measurement). Any `cost-compare.js` / measurement run MUST start the server with
`AGENT_METRICS_RESET=1`; `cost-compare.js` itself now exits loudly (code 2) if `/metrics/reset`
doesn't return 200, instead of silently measuring on top of stale counters.

After every `/event`, the server also broadcasts `{kind:"metrics", ...snapshot}` over
the session's WebSocket. Checked `web/components/AgentWidget.tsx`'s `onmessage`: it
special-cases `kind === "trace"` and falls through to `apply(msg)` for everything else,
whose `switch (a.action)` has no case for `undefined` (a metrics message has no
`action` field) — so this is a confirmed no-op there today, not a crash. **Ask for the
storefront dev**: add a real case for `kind === "metrics"` in `onmessage` (store it in
state, e.g. `setMetrics(msg)`) and a small panel showing `llmCalls`, `cacheHitRate`,
`callsPerSession` live, next to the trace panel.

### `server/cost-compare.js` — measurement script (no deps, `npm run cost`)

`node cost-compare.js --label <name> [--base http://localhost:PORT] [--price-in 0.05]
[--price-out 0.40] [--sessions 1000000] [--speed 2] [--settle 15000]`. Per run: `POST
/metrics/reset`, spawns `node replay.js sessions/*.json --base <base> --speed <speed>
--settle <settle>` as a child process (streaming its stdout so fixture PASS/FAIL is
visible live and parsed back out of it), `GET /metrics`, prints a summary row
(ticks/quietTicks/gated/llmCalls/callsPerSession/cacheHitRate/tokens-per-call/avg
ms/estimated cost per N sessions), and saves the full snapshot + row to
`server/metrics-runs/<label>-<timestamp>.json`. Cost formula: `costPerNSessions =
callsPerSession * N * (tokensPerCallIn*priceIn + tokensPerCallOut*priceOut) / 1e6`.
`--price-in`/`--price-out` default to **0.05/0.40 USD per 1M tokens — gpt-5-nano list
price, cached-input tier not applied** (verified against OpenAI's pricing docs
2026-09-11); pass different values for other models (e.g. gpt-4.1-nano: 0.10/0.40).
`--speed`/`--settle` default to `2`/`15000` (fine for a fast API model) but should be
raised for a slow local model — e.g. `--speed 1 --settle 90000` for a CPU-bound 3B model
whose calls take 25-60s+, so the last event's response has time to land before replay
grades the fixture and closes the socket.

Because `LLM_CACHE` is read once at process start, comparing cache-off vs cache-on needs
**two separate server processes** (the script itself never restarts the server):

```
# cache-off (AGENT_METRICS_RESET=1 required — cost-compare.js calls POST
# /metrics/reset before each run and now exits loudly if that 404s)
LLM_CACHE=0 AGENT_MODE=llm AGENT_METRICS_RESET=1 PORT=4800 node index.js &
AGENT_HTTP=http://localhost:4800 node cost-compare.js --base http://localhost:4800 --label cache-off
kill %1

# cache-cold then cache-warm against the SAME long-lived server (second pass hits the cache)
AGENT_MODE=llm AGENT_METRICS_RESET=1 PORT=4801 node index.js &
AGENT_HTTP=http://localhost:4801 node cost-compare.js --base http://localhost:4801 --label cache-cold
AGENT_HTTP=http://localhost:4801 node cost-compare.js --base http://localhost:4801 --label cache-warm
kill %1
```

### Run status — measured (2026-09-11, via Ollama, codex CLI still on quota)

The codex CLI was still on its usage-limit wait (message: retry at 6:45 AM) when this
pass ran, so the measurement below uses the **openai backend against a local Ollama
server** (`qwen2.5:3b`, CPU, `http://localhost:11434/v1`) instead — same backend code
path an OpenRouter/OpenAI deployment would use, just pointed at a free local model so
the comparison wasn't blocked another 6+ hours. The Codex quota exhaustion itself
(~30 calls burning through a personal ChatGPT subscription's daily window) is direct
evidence for why the cache/gate/tick layers below matter: a slow personal-auth CLI
backend cannot survive even a handful of fixture runs without hitting a wall, and a
metered API key would simply bill for the same volume instead of erroring.

**openai backend against Ollama — what had to change:**
- Ollama's `/v1/chat/completions` DOES accept
  `response_format:{type:"json_schema",json_schema:{...}}` (confirmed by curl probe
  against both a trivial schema and the real `prompts/schema.json` — no 400, structurally
  valid JSON back both times). `decide/llm.js` now auto-detects this once at startup
  (`detectJsonMode()`, gated by `LLM_BACKEND==="openai"`) by probing the endpoint with a
  throwaway schema request; a 400 there — or a late 400 on a real call — flips a
  module-level `LLM_JSON_MODE` to `"object"` for the rest of the process (pastes the
  schema into the system prompt instead, using `response_format:{type:"json_object"}`).
  `LLM_JSON_MODE=schema|object` env var pins the mode and skips the probe entirely. Not
  needed for this measurement (schema mode worked), but the fallback path exists and is
  exercised by the same code either mode takes.
- New `validateProposalShape(parsed)` in `decide/llm.js` checks the returned JSON's
  `action`/`trace` fields (enum values, null-or-typed fields, required keys) against
  `prompts/schema.json`'s shape by hand — needed because `json_object` mode has no
  server-side schema enforcement, so a model faithfully returning syntactically-valid-but-
  wrong-shape JSON must be caught here rather than crashing `applyPolicy()` downstream.
  Applied uniformly (codex and both openai json modes) as defense-in-depth; replaces the
  old weak `!parsed.action || !parsed.trace` check. Invalid shape → `llmErrors` + noop
  proposal, same as any other llm error.
- `usage.prompt_tokens`/`usage.completion_tokens` from Ollama's response are recorded
  into `tokensIn`/`tokensOut` exactly like a real OpenAI response — no code change needed
  there, Ollama's OpenAI-compat endpoint returns the same `usage` shape.
- `LLM_TIMEOUT_MS=90000` was set via env for this run only (not a code default change) —
  a direct `decide()` probe against Ollama took **61.9s** for one call (CPU 3B, full
  `prompts/decide.md` + real state), well inside 20-40s guidance range on the slow side;
  the default (`20000`) stays untouched in code.

Direct `decide()` probe (bypassing cache), schema mode, `qwen2.5:3b`, latency 61924ms:
```json
{
  "action": { "action": "highlight", "target": "size-guide", "style": "outline", "duration_ms": 2000, "message": null },
  "trace": {
    "signals": ["dwell", "size-guide"],
    "hypothesis": "The shopper appears to be hesitant or stuck on the jacket size guide.",
    "decision": "highlight size-guide",
    "confidence": 0.85,
    "why": "Recent dwell time suggests the shopper is interested in sizing, but they have yet to decide what sizes to purchase."
  }
}
```

**Gate/tick bug found and fixed during this run** — category: both `tick.js`'s
signal-class trigger and the `decide/llm.js` fingerprint cache keyed dwell state ONLY off
`state.dwell.pageMs` (the page-level dwell timer). But a `dwell` event whose `target` is a
specific element (e.g. `size-guide`) accumulates into `state.dwell.perTarget[target]`
instead (`state.js`'s `buildState()`), never touching `pageMs`. Once the page-level bucket
had already settled, a run of size-guide dwell events (8s → 15s → 22s — exactly the
`sizing-hesitation` fixture's triggering signal) all hashed to the same "quiet tick" /
same cache fingerprint and never reached the decider at all. Same defect class also
existed in `gate.js`'s "dwell < 5s, too early" check (used `pageMs` unconditionally, which
could wrongly gate a genuine 5s+ per-target dwell if no page-level dwell tick had landed
yet). Fixed all three sites off one new shared helper, `isPageDwellTarget(target, page)`
in `buckets.js`, plus per-subject bucket tracking (`session.lastDwellBuckets`, a map keyed
`"__page__"` or the target name, replacing the old single `lastDwellBucket` string) in
`tick.js`, and a per-target bucket map in the fingerprint (`bucketPerTargetDwell()` in
`decide/llm.js`). Re-ran after the fix: `sizing-hesitation` now reaches the decider on the
size-guide dwell events and **passes** in llm mode (previously would have silently noop'd
throughout — the bug, not a model-quality issue). `cart-threshold` and `happy-browsing`
still fail against `qwen2.5:3b`, but their triggering events DO reach the decider each
time (confirmed in the run logs — cooldown/gate reasons only, never "quiet tick" on a
signal that should have counted); the failures are the 3B model choosing the wrong action
(e.g. `highlight cart-total` instead of `message`, or over-triggering `highlight
size-guide` during calm browsing) — a model-capability gap, not a gate/tick regression,
so left as-is (prompt tuning for a specific small model is out of scope for this pass).

**Measurement recipe used** (`--speed 1 --settle 90000` instead of the script's
`--speed 2 --settle 15000` default — the 3B-on-CPU per-call latency, ~25-60s, needs far
more settle time than a fast API model; `cost-compare.js` now accepts `--speed`/`--settle`
passthrough args for this):

```
AGENT_MODE=llm LLM_BACKEND=openai OPENAI_BASE_URL=http://localhost:11434/v1 \
  OPENAI_API_KEY=ollama LLM_MODEL=qwen2.5:3b LLM_TIMEOUT_MS=90000 LLM_CACHE=0 \
  AGENT_METRICS_RESET=1 PORT=4900 \
  node index.js &
AGENT_HTTP=http://localhost:4900 node cost-compare.js --label cache-off \
  --price-in 0.05 --price-out 0.40 --speed 1 --settle 90000
kill %1

AGENT_MODE=llm LLM_BACKEND=openai OPENAI_BASE_URL=http://localhost:11434/v1 \
  OPENAI_API_KEY=ollama LLM_MODEL=qwen2.5:3b LLM_TIMEOUT_MS=90000 AGENT_METRICS_RESET=1 PORT=4901 \
  node index.js &
AGENT_HTTP=http://localhost:4901 node cost-compare.js --label cache-cold --price-in 0.05 --price-out 0.40 --speed 1 --settle 90000
AGENT_HTTP=http://localhost:4901 node cost-compare.js --label cache-warm --price-in 0.05 --price-out 0.40 --speed 1 --settle 90000
kill %1
```

**Model used for measurement: `qwen2.5:3b` on CPU via Ollama.** Token-in counts reflect
OUR prompt (`prompts/decide.md`) + state JSON size, which is model-independent for a
given fixture run — a bigger/smaller model reading the same input is billed the same
input tokens. Token-OUT counts (~130-140 tokens/call here) may differ slightly by model
(verbosity of `hypothesis`/`why` free-text fields), so treat the output-token column as
approximate for other models, not exact.

**Final comparison table** (3 fixtures, 3 sessions, 35 total ticks per run — same
fixture set every run, `sessions/*.json`; raw snapshots in `server/metrics-runs/`):

| row | ticks | quiet ticks | gated | LLM calls | calls/session | cache hit rate | tokens in/call | tokens out/call | avg ms/call | est. USD / 1M sessions (gpt-5-nano) |
|---|---|---|---|---|---|---|---|---|---|---|
| naive (every tick) | 35 | 0 | 0 | 35 | 11.67 | 0% | 922* | 130* | 24374* | **$1,143.46** |
| cache-off (`LLM_CACHE=0`) | 35 | 5 | 21 | 9 | 3.00 | 0% (forced) | 922 | 129.8 | 24,374 | **$294.04** |
| cache-cold (fresh cache, this run warms it) | 35 | 5 | 22 | 7 | 2.33 | 12.5% (1/8) | 919.1 | 138.9 | 26,503 | **$236.84** |
| cache-warm (same process, cache re-run) | 35 | 5 | 22 | 0 | 0.00 | 100% (8/8) | — | — | — | **$0.00** |

\* naive row has no real per-call token/ms samples (it never calls the decider in this
measurement — see below); tokens/ms columns borrow the cache-off run's actuals as the
estimate, since the "naive" input state at each tick is drawn from the same fixtures.

Same table at gpt-4.1-nano list price ($0.10 in / $0.40 out per 1M tokens), same call
counts and token counts as above:

| row | est. USD / 1M sessions (gpt-4.1-nano) |
|---|---|
| naive (every tick) | $1,681.30 |
| cache-off | $432.34 |
| cache-cold | $236.84 → $344.07 |
| cache-warm | $0.00 (test artifact: identical fixtures replayed; do NOT quote as a real-traffic number) |

Reading the table: gate.js (Layer 0) + tick.js (Layer 1) alone cut calls from a naive
35/run (every tick) to 9/run (cache-off) — a 74% reduction before any caching, from
deterministic rules with zero model cost. The fingerprint cache (Layer 2) then cuts the
*warm* case to 0 calls for this fixture set (small, deterministic, repeats the exact same
situations across sessions) — real traffic won't hit 100%, but `cache-cold`'s 12.5% (1
hit within a single run, cache empty at start) is the conservative floor and already
saves ~20% vs. cache-off. "naive" is calls=ticks by definition (every event would go to
the model with gate/tick fully bypassed); it is **not** a runnable server mode — computed
analytically from the ticks counter, not measured against a live "no gate/tick" server,
per the brief.

**How "naive" was computed**: analytically, as directed — `ticks` from any of the three
runs' `/metrics` snapshots (35, identical across runs since it's the same fixture set),
used directly as the naive LLM-call count, rather than adding a code path that disables
gate/tick (`LLM_NAIVE_TICKS`-style env var was considered and rejected as unnecessary
complexity — the counter already gives the exact number a "call on every tick" design
would produce).

Fixture verdicts, every run (`qwen2.5:3b`, all three cost-compare runs):

| fixture | cache-off | cache-cold | cache-warm |
|---|---|---|---|
| sizing-hesitation | PASS | PASS | PASS |
| cart-threshold | FAIL (model chose `highlight cart-total`, expected `message` + `scroll_to`) | FAIL (same) | FAIL (same, served from cache) |
| happy-browsing | FAIL (model over-triggered `highlight size-guide` on calm browsing) | FAIL (same) | FAIL (same, served from cache) |

`cart-threshold`'s expected result is already known-unsatisfiable under current policy
regardless of model quality (see "Open decision" above — two interventions inside one
30s cooldown). `happy-browsing`'s failure here is `qwen2.5:3b` being trigger-happy on a
9s dwell; the codex-backed `gpt-6-astra` run documented earlier in this file passed both
`sizing-hesitation` and `happy-browsing` after prompt tuning — that tuning was against a
different, larger model and was not re-tuned for `qwen2.5:3b` in this pass (out of
scope — the deliverable here is the cost measurement, not re-tuning the prompt per
model).

Raw run files: `server/metrics-runs/cache-off-1789072750102.json`,
`cache-cold-1789073291071.json`, `cache-warm-1789073621916.json`. The earlier partial
run from the codex-quota-blocked attempt (`cache-off-1789071429187.json`, `llmCalls=25`
with 22 `llmErrors` from the quota wall) has been deleted — not representative, superseded
by the numbers above.

## Known limits (B1/B2/M1/M2/M3 review pass, 2026-09-11)

Deliberately not fixed in this pass — deferred:

- ~~**Grandchild kill on codex timeout.**~~ **Fixed in the M4 pass (2026-09-11).**
  `decide/backends/shell.js` (the runner shared by codex and claude) now spawns with
  `detached: true` and, on `LLM_TIMEOUT_MS`, sends `SIGKILL` to the whole process group
  (`process.kill(-child.pid)`), not just the direct child — a codex/claude grandchild that
  previously could outlive the parent's kill signal is now reaped too.
- **Error body in `trace.why`.** When an llm call fails, `trace.why` is `"llm error: <reason>"`
  truncated to 150 chars — the reason string itself (e.g. an HTTP error body) is not
  further sanitized/redacted before reaching the trace panel, which is broadcast to any
  connected widget for that session. Acceptable for a hackathon demo (no untrusted multi-
  tenant traffic), not acceptable to ship broader without a redaction pass.
- **Gate uses the last `page_view` page after `back_nav`.** `gate.js`'s checkout guard reads
  `state.page` (the last `page_view` event's page), which after a `back_nav` may lag one
  event behind what the shopper's browser is actually showing until the next `page_view`
  lands. Narrow window, not observed to cause a wrong gate verdict in the four fixtures.

Pre-existing, documented here for visibility (not review findings, not changed):

- **Stub-mode `npm test` is 1/4 PASS by design.** `AGENT_MODE=stub` is a fixed rule
  (dwell ≥ 5s → highlight size-guide) — only `sizing-hesitation` is shaped to trigger it.
  `cart-threshold`, `happy-browsing`, and `facts-threshold` are expected to FAIL against
  the stub decider; they exist to be run against `AGENT_MODE=llm`/`cached`, not stub. A
  1/4 stub-mode result is not a regression. (`facts-threshold` itself now PASSES in
  `AGENT_MODE=llm`/`cached` on the `codex` backend — see "codex backend, facts-threshold
  re-record" above — this bullet is about the stub decider only.)
- **Per-session in-memory maps grow unbounded.** `session.actedTargets`, `session.
  lastDwellBuckets`, and `metrics.js`'s `sessions` Set all key off client-supplied session
  ids with no eviction — a session that never ends keeps its entries forever, and an
  adversarial client could grow these maps by minting new session ids. Fine for a demo
  (in-memory, process-lifetime, low volume); would need a TTL/LRU sweep before any real
  multi-day deployment.
- **Fixture 1's last dwell tick is intentionally quiet.** `sizing-hesitation`'s final
  `dwell` event stays within the same dwell bucket as the one before it (by fixture
  design — it's testing that a repeat within a bucket does NOT re-trigger), so it produces
  a quiet-tick noop, not a decider call. Not a bug if you see it while eyeballing a replay
  log.
- **Web container has no `HOSTNAME=0.0.0.0`, and `.next/cache` is root-owned.** The
  `web` Dockerfile doesn't set `HOSTNAME=0.0.0.0` for the Next standalone server (relies on
  the default bind, which has worked in testing) and its `.next/cache` directory is
  root-owned at build time — only matters if something later needs to write into that
  cache as a non-root runtime user (e.g. `next/image`'s optimizer cache); not exercised by
  this project (no `next/image` usage) so left as-is.

## Decision coalescing replaces per-event serial queueing (2026-09-11)

**Incident:** a live browser session (page_view, dwell heartbeats every few
seconds, scroll_depth, cart events) hit `AGENT_MODE=llm` with a real model
backend (~14s/call). `POST /event` ran one decider call PER EVENT, serially
per session (`runSerialized()`). With a slow decider, the per-session promise
chain backed up faster than it drained; `AGENT_MAX_QUEUE_PER_SESSION` (8)
filled within seconds and every later event was rejected with `event
rejected: session queue too deep` — 1,131 rejections in a few minutes, 0
completed decisions. The HTTP response was also held until the decision
completed (14s per POST), so the widget itself stalled on every event.

**Fix (category: slow decider × per-event serial processing, not a one-off
tune of the queue cap):**

1. State updates (`processEventCore()`: pushEvent, LRU eviction, metrics) are
   now always synchronous and immediate, decoupled from any decision.
   `POST /event` responds `200 {ok, queued}` right away — the widget never
   waits on the model, regardless of mode.
2. Decisions are now COALESCED for live traffic (stub/llm mode): at most one
   decision in flight per session, plus at most one pending (latest state
   wins). An event that arrives mid-decision doesn't queue its own decision —
   it folds into the next one. There is no per-session queue depth any more,
   so nothing to exceed and nothing to reject. `AGENT_MAX_QUEUE_PER_SESSION`
   and the `busySessions` rejection path are gone.
3. Cached mode / `AGENT_RECORD=1` keep the OLD strict per-event serial
   behavior (`runSerialized()`/`processEventSerial()`) — required for
   `decide/cached.js`'s index-by-`session.events.length` recording format —
   just with the HTTP response decoupled per (1).
4. The global in-flight cap (`AGENT_MAX_INFLIGHT`) no longer skips a decision
   with a noop when saturated; it waits (polling every 50ms) so an event is
   delayed, never dropped, under global overload.

New metrics: `decisionsStarted`, `coalesced`, `pendingRuns` (see
`server/OPS.md`'s "Decision coalescing"). New test: `server/coalesce.test.js`
(`npm run test:coalesce`) reproduces the burst scenario against
`AGENT_MODE=stub` with `AGENT_STUB_DELAY_MS` (test-only artificial latency,
`decide/stub.js`) standing in for a slow model call, and asserts the fix
holds (fast POSTs, low `decisionsStarted`, high `coalesced`, no "queue too
deep" log line).

Category-fix audit — every site that used to assume "one decide() call per
event" or the old queue-depth cap:
- `index.js`'s `runSerialized`/`sessionQueueDepth*` — replaced with
  `sessionChains` (serial path, uncapped) + `sessionCoalesce` (coalescing
  path). ✅ fixed.
- `index.js`'s `resetSessionFully()` — now clears `sessionCoalesce` instead
  of the old `sessionQueueDepth` map. ✅ fixed.
- `index.js`'s demo player (`POST /demo/play/:fixture`) — switched from a
  `fakeRes`-wrapped `processEvent()` call to `processEventSerial()`, same
  strict-serial semantics, no fake response object needed since nothing
  reads its body any more. ✅ fixed.
- `decide/llm.js`'s own per-session in-flight guard (`sessionsInFlight`,
  `clearSessionInflight()`) — orthogonal to this pass's scheduler (it guards
  direct `decide()` callers like `/health/agent`'s self-test, which never
  goes through `index.js`'s coalescing scheduler); left as-is, still wired
  into `resetSessionFully()`. ✅ verified consistent, not a defect site.
- `decide/stub.js` — was always synchronous; the only reason it needed a
  change at all is `AGENT_STUB_DELAY_MS` for `coalesce.test.js` to simulate a
  slow decider under `AGENT_MODE=stub` without a real model call. ✅ fixed
  (opt-in, default-0, zero behavior change otherwise).
- `health.js`'s `/health/agent` self-test — calls `decide()` directly against
  a fixed synthetic session, never through `index.js`'s `/event` path at
  all — not a per-event-serial site, unaffected. ✅ verified, no change
  needed.

## Per-element state leak across page navigations + fixed-short-effect-lifetime (2026-09-11)

Live free-browsing shopper test hit two defects; both are categories, not one-off bugs.

### Defect 1 — per-element state leaks across page navigations

Observed: shopper dwelled on Leather Mojari Sandals' size picker ~15s, then
navigated to Jamdani Saree (one-size, no size picker). The saree page's trace
cited "dwell size-guide 12975ms · dwell size-picker 12975ms" — figures from
the PREVIOUS page. Root cause in `server/public/agent.js`: `elVisibleSince`
(per-element dwell "visible since" map) and `state.scrollSeen` (scroll-depth
thresholds already emitted) were never reset on `onRouteChange()` — only
`pagePath`/`pageStart` were. `web/components/AgentWidget.tsx`'s equivalent
trackers (`dwellStateRef`, `scrollAchievedRef`) were ALREADY reset on route
change before this pass; the leak's client-side root was agent.js-only.

Category-fix audit — every per-target/per-element signal tracker or
aggregation site:
- `server/public/agent.js` `elVisibleSince` (IntersectionObserver-based
  per-element dwell) — NOT reset on route change. ❌ leaked → ✅ fixed:
  `onRouteChange()` now calls `io.disconnect()` + `elVisibleSince.clear()`
  before `discoverTargets()` re-observes.
- `server/public/agent.js` `state.scrollSeen` (scroll_depth thresholds) —
  NOT reset on route change (scroll_depth is documented "once per page", not
  "once per session"). ❌ leaked → ✅ fixed: reset to `new Set()` in
  `onRouteChange()`.
- `server/public/agent.js` `state.clickBursts` (rage-click timestamps,
  WeakMap keyed by element) — self-expiring (1.5s filter) and keyed by DOM
  element, which is never re-clicked after navigation in practice. ✅ not
  leaking, no change needed.
- `web/components/AgentWidget.tsx` `dwellStateRef` (per-element dwell
  cumMs/visibleSince) — already cleared on the `pathname` route-change
  effect. ✅ already correct, pre-existing.
- `web/components/AgentWidget.tsx` `scrollAchievedRef` — already reset on
  route change. ✅ already correct, pre-existing.
- `web/components/AgentWidget.tsx` `clickTimestampsRef` — self-expiring
  (1.5s filter), same reasoning as agent.js's clickBursts; not leaking, but
  now explicitly `.clear()`ed on route change too for hygiene/consistency
  since the effect was already being touched for defect 2's nav-triggered
  effect clearing.
- `server/state.js` `buildState()`'s `dwell.pageMs`/`dwell.perTarget` — were
  ALREADY scoped by array position to events since the latest `page_view`
  (pre-existing, correct). Added defense in depth: `dwell.perTarget` now
  additionally cross-checks the event's target against this page_view's own
  `visibleTargets`, so a dwell event for a target the shopper cannot
  currently see (client bug, race, or a future regression in the two resets
  above) can never be attributed to the current page, even if it's
  positioned after the page_view in the event log. See `server/state.test.js`.
- `server/state.js` `visibleTargets` — already sourced from the latest
  `page_view`'s own `meta.targets`. ✅ already correct, current page only.
- `server/tick.js`/`server/gate.js` — both read `state.dwell`/
  `state.visibleTargets` from `buildState()`'s output only, no independent
  per-target state of their own. ✅ inherit the state.js fix, no direct leak.
- `server/tick.js`'s `session.lastDwellBuckets` (dwell-bucket history per
  subject, "__page__" or a target name) — NOT reset on page_view. This is
  the FALSE-NEGATIVE direction of the same defect class: a target name
  reused across two pages (e.g. "size-guide" on two different products)
  could land in the same bucket its dwell already reached on the PREVIOUS
  page, making `shouldCallDecider()` see "no class change" and silently
  swallow the new page's own legitimate dwell signal. ❌ leaked → ✅ fixed:
  `server/index.js`'s `processEventCore()` resets
  `session.lastDwellBuckets = {}` on every `page_view` event. See
  `server/state.test.js` part (iv).
- `server/decide/llm.js`'s fingerprint cache — key is a sha256 of the full
  serialized state (`JSON.stringify(state)`), which includes `page` and
  `dwell.perTarget`; `fingerprintClass()` (log-only) also includes
  `state.page` explicitly. ✅ already correct, no cross-page cache
  collision once `buildState()` is page-scoped.
- `server/decide/stub.js` — reads `state.dwell.pageMs` only (page-scoped),
  no per-target logic of its own. ✅ not a leak site. (Its hardcoded
  `highlight size-guide` proposal regardless of page is a pre-existing
  vertical-slice simplification, not part of this defect — it's caught by
  policy.js's target-in-visibleTargets guard when size-guide isn't on the
  current page, same guard exercised by `sessions/page-switch-no-leak.json`
  in stub mode.)
- `session.actedTargets` (never-repeat-same-target guard) — persists across
  pages BY DESIGN (CLAUDE.md: "never twice on the same target", session-wide
  not page-wide). Not a leak; intentionally global.
- `server/prompts/decide.md` — added an explicit rule that `dwell.pageMs`,
  `dwell.perTarget`, and `visibleTargets` describe the CURRENT page only, and
  that `recent` entries from before the latest `page_view` are history, not
  current-page state — so an LLM decider can't be talked into treating a
  pre-navigation number as live.

New regression test: `server/state.test.js` (`npm run test:state`) — direct
`buildState()`/`shouldCallDecider()` probe, no HTTP, no decider. Plus fixture
`server/sessions/page-switch-no-leak.json`: sandals page (has `size-picker`,
no `size-guide`) dwelled 13s, page_view to a one-size saree page (no size-*
targets at all) with a straggler `dwell size-picker` event still landing
after the new page_view (reproducing the observed race) — `AGENT_MODE=stub`
replay asserts `noop` throughout. Note: this fixture's stub-mode pass
currently leans on policy.js's pre-existing target-in-visibleTargets guard
(stub always proposes `highlight size-guide`, denied when size-guide isn't
on the page) rather than exercising the per-target dwell number itself —
`server/state.test.js` is what directly proves the dwell-number scoping fix.
**LLM-mode verification for this exact defect (a live model actually citing
scoped-vs-leaked dwell numbers) comes from the browser pass, not from a
stub-mode fixture** — stub's decider doesn't read `dwell.perTarget` at all.

### Defect 2 — intervention lifetime too short for a slow decider

Observed: live decision latency 14-22s (claude CLI backend). The old
highlight `duration_ms` default (8000ms) could expire entirely inside the
shopper's wait for the effect to land, making the intervention invisible.

Fix, `server/policy.js`: `DEFAULT_DURATION` highlight/spotlight/message all
8000/8000/10000 → 20000/20000/20000; `normalizeAction()`'s `duration_ms`
clamp ceiling 15000 → 30000 (so a decider-proposed duration isn't clamped
below the new 20000 default). CLAUDE.md's contract doesn't pin a duration
number — only the action/trace shapes and the 30s cooldown/never-same-target
rules — so this is ours to tune. `server/probe-policy.test.js`'s clamp-range
assertion updated to match (`<= 30000`).

Both clients (`web/components/AgentWidget.tsx`, `server/public/agent.js`):
an effect now ends on the EARLIEST of (a) its `duration_ms`, (b) an
interaction with it — clicking its own highlighted/spotlighted target, or
its own dismiss/close button (which already called clear directly) — or (c)
navigation away (new: `onRouteChange()`/the `pathname` effect now clear any
active highlight/spotlight/message) — never earlier. The pre-existing "any
document click clears the effect" behavior is replaced with: a click on the
effect's own target dismisses it immediately; an unrelated click elsewhere
on the page also dismisses it, but only after a 5s grace period
(`EFFECT_GRACE_MS`) so a single accidental click right after the effect
lands can't kill help the shopper hasn't seen yet. Dismiss buttons (chip
`×`, message `×`) are unaffected — they call the clear function directly
and always work immediately.

Also: the trace panel could look frozen for the whole 15-20s of a live
decision (quiet ticks collapse into one row). Both panels now show
"thinking · Ns" once it's been >3s since the last `{kind:"trace"}` frame
while the socket is open, clearing on the next trace
(`web/components/AgentWidget.tsx`'s `thinkingSeconds` state;
`server/public/agent.js`'s `panelEls.thinkingRow`, built via the existing
`el()` helper so it auto-carries `data-agx-ui`).

Docs updated: `web/README.md` ("User stays in control" / "What the shopper
sees"), `server/POLICY.md` (new "Effect duration" section — durations
weren't previously documented there at all).

### 2026-09-11 — Round 3 live free-browsing defects: gate/tick reasoned over event counts, not state/time windows

Observed on a live `AGENT_MODE=llm` free-browsing pass (real shopper, real
dwell heartbeats at ~1 event/s):

- `gate.js`'s checkout rule looked at `session.events.slice(-3)` for
  `rage_click`/`back_nav`. At 1 event/s that's ~1-3s of history — a real
  `back_nav` from 40s earlier was buried under 40 dwell heartbeats and never
  seen: `gated: checkout page with no rage_click/back_nav in last 3 events`
  while the shopper was actually on `/cart` having just bounced back from
  checkout.
- `gate.js`'s dwell rule checked the TRIGGERING event's own subject dwell
  (`dwellMs < 5000`), not the shopper's overall situation. A page-level
  heartbeat carrying only 4s of its own dwell gated out an unrelated element
  ("size-picker") sitting at 48s of real accumulated attention right there in
  `state.dwell.perTarget`: `gated: target dwell < 5s, too early for a dwell
  signal` alongside `attention size-picker 48s (hover 48s, 2 clicks)` in the
  same state.
- `prompts/decide.md`'s page-scoping paragraph ("dwell.perTarget describes
  the CURRENT page only") over-generalized into the model discarding a
  genuine cross-visit PATTERN: a shopper who returned to the same product a
  second time and re-hovered the size guide got `noop — wait for
  current-page interaction 95%: past sizing hesitation visible in history but
  doesn't carry to current view`. The rule was meant to stop the model
  quoting a stale NUMBER from a page the shopper left, not to make it treat a
  repeated visit as irrelevant history.

**Fix (category: gate/tick reasoning over event counts instead of
accumulated state + real time windows).** `server/gate.js` rewritten as
`computeSignals(state, session, now)` (shared with `tick.js`, so the two
can't drift on what a signal means) evaluating six state/time-window rules,
all computed from `state` + `session.events` timestamps vs. `now =
event.ts ?? Date.now()`, never from array position/count:

| # | Signal | Window | Pass reason (example) |
|---|---|---|---|
| 1 | element attention | any `state.dwell.perTarget` target ≥5000ms, current page visit | `element attention: size-picker 48.0s >= 5s on current page` |
| 2 | return visit + attention | path viewed ≥2x (any time) AND max attention ≥3000ms now | `return visit: /product/x viewed 2x, attention size-guide 3.0s >= 3s` |
| 3 | navigation friction | `back_nav` in last 60s, OR page_view sequence cart→checkout→cart / product→cart→product within 60s | `navigation friction: back_nav 41.0s ago (< 60s)` |
| 4 | rage click | `rage_click` in last 30s | `rage click 12.0s ago (< 30s)` |
| 5 | cart friction | cart total present, gap to free-delivery threshold >0 and ≤10% of threshold, on `/cart` or `/checkout`, page dwell ≥8000ms | `cart friction: gap ৳50 <= 10% of ৳2000 on /cart, page dwell 10.0s >= 8s` |
| 6 | search friction | zero-result search, or same query repeated, within last 60s | `search friction: repeated search "sari red" (2x) within 60s` |

Cooldown pre-filter kept (now phrased `cooldown: non-noop intervention Ns
ago (< 30s)`). Everything else gates with a window-named reason, e.g. `no
friction signal in last 60s: max attention 0.0s, no back_nav, cart none`.
Every "last N events" check is gone.

`tick.js` rewritten to call the decider when: (a) a `page_view` is the
FIRST visit to that path this session; (b) a `cart_view`/`cart_update`
actually changes `cart.total` (kept separate from cart-friction flipping
true/false, since crossing the threshold going the OTHER way — e.g.
৳1,950→৳2,050 — is itself worth a look, not a false→true flip); (c) a
per-ELEMENT dwell (never page-level — page dwell alone is never a signal,
per decide.md) crosses a `bucketAttention()` boundary (3/5/10/20s, new in
`buckets.js`, deliberately different from `bucketDwell`'s 5/20/60s used by
`decide/llm.js`'s fingerprint cache — left untouched so that cache doesn't
drift); (d) any of `computeSignals()`'s six flags newly turns false→true
since the last check. `session.lastDwellBuckets` (field name/shape kept
exactly, since `index.js` still resets it `{}` on every `page_view` and
`server/state.test.js`'s (iv) asserts against that exact field) now only
ever holds per-ELEMENT subjects, not `"__page__"`. All bookkeeping
(`lastDwellBuckets`, `lastCartTotal`, `lastSignalFlags`) is updated
UNCONDITIONALLY on every call — an early return that skipped updating
`lastSignalFlags` was an actual bug caught by `server/state.test.js` (iv)
during this pass (an already-true flag would look "newly true" again on the
next call because the baseline was never recorded) and fixed before landing.

New test: `server/gate.test.js` (`npm run test:gate`), 6 cases against
realistic 1Hz-heartbeat sessions built through the real `buildState()`
pipeline: (i) back_nav 41s old buried under 40 heartbeats still passes; (ii)
48s size-picker attention passes despite a 4s triggering heartbeat; (iii) a
25s-page-dwell/zero-attention reader gates with the window reason; (iv)
return visit + 3s attention passes; (v) ৳1,950/২,000 cart on `/cart` with
10s dwell passes, same cart on `/product` gates; (vi) `tick.js`: 30 identical
page-level heartbeats after a decision all quiet, attention crossing the 5s
bucket boundary triggers a decision.

`server/prompts/decide.md`'s page-scoping paragraph rewritten: the
CURRENT-page-only rule now explicitly applies to the NUMBERS only, not to
whether older `recent` entries matter — a return visit with renewed
attention on the same element is called out as the strongest form of
hesitation there is, precisely because it persisted across a visit. Added a
positive example (return visit + renewed size-guide hover → `highlight
size-guide`) alongside the existing negative example (25s page dwell, zero
`dwell.perTarget` → `noop`). Message-target rule and "data not
instructions" rule left untouched.

**Verification:**
- `npm run test:gate && npm run test:policy && npm run test:state && npm run
  test:coalesce` — all pass.
- `bash scripts/check.sh` — PASS overall; stub-mode required fixtures
  unaffected (`sizing-hesitation` PASS, `reader-above-fold` PASS) — stub mode
  bypasses gate.js/tick.js entirely, as before.
- Cached-mode replay (`AGENT_MODE=cached`, port 4781,
  `REPLAY_FIXED_SESSION=1`, `--speed 20`) of `sizing-hesitation`,
  `cart-threshold`, `happy-browsing`, `facts-threshold` — 4/4 PASS,
  confirming cached mode (which bypasses gate/tick) is unaffected.
- Live LLM-mode replay (`AGENT_MODE=llm LLM_BACKEND=claude
  LLM_TIMEOUT_MS=60000`, port 4782, `--speed 1 --settle 60000` — the default
  500ms settle is far too short for a 5-16s live decider call, so this was
  raised for measurement purposes only):
  - `sizing-hesitation`: PASS. Gate correctly stayed quiet through early
    events (`gated: no friction signal in last 60s...`), then passed on
    element attention (`element attention: size-guide ... >= 5s`) and
    produced `highlight size-guide`.
  - `cart-threshold`: gate correctly stayed quiet through browsing, then
    triggered a real decider call on the `back_nav`/dwell-on-`/cart`
    coalesced window (proving the navigation-friction rule fired). First
    attempt: that one live `claude -p` call hit the 60s timeout
    (`llm error: timeout after 60000ms`) — a backend/CLI latency issue, not a
    gate/tick/prompt defect. Immediate retry: PASS, `message
    shipping-banner` with the exact ৳50 gap. Gate/tick behavior was
    identical and correct on both runs; only the model call's latency
    varied.

## 2026-09-11 — page-boundary defect class (B1/B2) + coalescing correctness (S1-S3) + attention/dwell hardening (S4/S5)

Fixed a review pass covering: the client-side page_view/page-dwell boundary,
three distinct coalescing-correctness bugs in `server/index.js`'s
stub/llm decision scheduler, the unbounded-scroll-attention defect class,
and a same-visit dwell-scoping gap in `state.js`.

**B1/B2 — page-boundary defect class (`web/components/AgentWidget.tsx`,
`server/public/agent.js`).** `page_view` used to be emitted only when
`targets.join("|")` changed (`rescan()`'s own gate). Every product page
shares the identical `data-agent-target` set (`ProductClient.tsx`), so a
product->product navigation never changed that key at all — the page_view
was silently dropped, the server never saw the page boundary
(`state.js`'s `lastPageView`-scoped dwell math, `index.js`'s
`lastDwellBuckets` reset on `page_view`), and per-target dwell/buckets
leaked across the navigation (the saree false-positive). Fix: the route-change
effect (`AgentWidget.tsx`'s `[pathname]` effect) now emits `page_view`
UNCONDITIONALLY — key is pathname+targets, not targets alone — and also
resets a new `pageStartRef` (B2: page-level dwell clock was previously a
`const pageStart` captured once at mount and never reset, so the FIRST
heartbeat on a newly-navigated page could report dwell since the widget
originally mounted). `rescan()` itself is UNCHANGED and still conditional —
it's called from the MutationObserver path (same-page DOM changes, e.g. a
modal), which is not a page boundary and must not spam page_view on every
DOM tweak. `server/public/agent.js`'s `onRouteChange()` already did both of
these correctly (unconditional `sendPageView()` + `pageStart = Date.now()`)
— confirmed, no change needed there.

*Per-site audit — every place either client decides "the page changed":*

| Site | Client | Emits page_view unconditionally on route change? | Resets page-dwell clock? | Verdict |
|---|---|---|---|---|
| `[pathname]` effect | AgentWidget.tsx | Was: no (via `rescan()`, target-set-gated) → **now: yes** | Was: no → **now: yes** (`pageStartRef`) | **fixed (B1+B2)** |
| Mount effect's initial page_view | AgentWidget.tsx | N/A — deferred to the `[pathname]` effect, which also fires once on mount | `pageStartRef` initialized at declaration + set again by the pathname effect on its first run | fixed (folded into the same code path) |
| `rescan()` (MutationObserver-driven, same-page target-set changes) | AgentWidget.tsx | No — intentionally still gated on target-set change (not a page boundary) | N/A | correct as-is, unchanged |
| `onRouteChange()` (pushState/replaceState monkeypatch + popstate) | agent.js | Yes — direct `sendPageView()` call, bypasses the 5s rate limiter | Yes — `pageStart = Date.now()` | already correct, confirmed |
| `sendPageViewIfChanged()` (facts/target rescan, same-page) | agent.js | No — intentionally rate-limited/key-gated (not a page boundary) | N/A | correct as-is, unchanged |
| `server/state.js` `buildState()`'s `lastPageView` scoping | server | N/A (consumes the boundary, doesn't decide it) | N/A | unaffected, still correct once page_view actually arrives |

**S1 — replay coalescing (`server/index.js`).** `x-agent-replay: 1` requests
(server/replay.js, used against stub AND llm mode for the day-of tuning
loop) now take the strict-serial path in EVERY `AGENT_MODE`, not just
cached/`AGENT_RECORD`. Initially routed this by calling
`processEventCore()` eagerly (as the coalesced branch does) and only
serializing the *decision* — this reproduced a SECOND bug under a slow
decider: since `processEventCore` (the event push) ran outside the serial
chain, a burst of replayed events posted faster than the decider responds
raced ahead of the decision queue, so by the time event 3's decision
finally ran it saw event 11's accumulated state instead of event 3's own
(`decide/stub.js`'s "current event" check, `decide/cached.js`'s index, both
silently decide against the wrong event). Fixed by routing replay-tagged
requests through the EXISTING `processEventSerial()` helper (previously
demo-player-only) unchanged — it pushes the event into session state
*inside* the same chained task as its decision, so event N's own state
update literally cannot happen until event N-1's full decision cycle has
finished. New metric: `serialEvents`. Verified:
`PORT=4791 AGENT_MODE=stub AGENT_STUB_DELAY_MS=15000 node index.js` +
`node replay.js sessions/sizing-hesitation.json --speed 1 --base
http://localhost:4791` → **PASS** (`highlight size-guide`, correctly
attributed to the size-guide dwell event that actually crossed the
threshold, not swallowed/misattributed). Note for future reruns: the
default `--settle 500` is far too short to observe the verdict against a
15s-per-event serial chain (11 events × 15s ≈ 165s worst case) — use
`--settle 170000` (or similar) when testing with an artificially slow
stub/live decider; this is a property of the verification setup, not a
defect in the fix itself (matches the existing project convention of
raising `--settle` for slow live-decider replay runs, see the LLM-mode
verification note above this section).

**S2 — coalescing swallows non-dwell triggers (`server/index.js`).**
`pendingEv` used to keep whichever event arrived LAST while a decision was
in flight — a `rage_click`/`back_nav`/etc. folded in behind a burst of dwell
heartbeats could get silently displaced by a later, lower-priority dwell
tick. Fixed: `pendingEv` now keeps the HIGHEST-PRIORITY event seen
(`EVENT_PRIORITY_ORDER`: `rage_click > back_nav > cart_update > search >
cart_view > page_view > scroll_depth > dwell`; ties keep latest), plus a
`sawTrigger` flag (any non-dwell event folded in) that forces the pending
run's `callDecider` past `tick.js`'s quiet-tick class-change check in llm
mode (`decideAndBroadcast`'s new `opts.forceDecide`) — needed because
`tick.js` was rewritten (this same day, gate/tick pass) to require a
newly-true friction signal even for some non-dwell events, not "any
non-dwell event is automatically worth a call" as it used to be; without
`forceDecide`, a genuine trigger folded in behind a same-priority dwell tick
could still read as "no new signal" once bucketed. Extended
`server/coalesce.test.js` (S2 block): dwell → dwell → rage_click → dwell,
asserts the pending run's logged `event` is `rage_click`, not the later
dwell.

**S3 — reset-mid-flight coalesce corruption (`server/index.js`).**
`resetSessionFully()` used to unconditionally `sessionCoalesce.delete(id)`
even when a decision loop was actively in flight (using that exact record)
— a new event arriving immediately after would create a FRESH record and
start a SECOND concurrent `runCoalescedLoop` for the same session; loop A's
own terminal delete would then remove loop B's record (not its own),
regardless of which loop actually finished last. Fixed: `resetSessionFully()`
now cancels an in-flight record IN PLACE (clears `pending`/`pendingEv`/
`sawTrigger`, sets `cancelled = true`) instead of deleting it; the running
loop notices `cancelled` right after its current (uncancelable) decision
finishes and exits WITHOUT a pending run, then deletes the record itself,
identity-guarded (`if (sessionCoalesce.get(id) === s)`) so it can never
remove a record it doesn't own. Also added a structural tripwire —
`activeDecisionSessions` (a `Set`, wrapping the whole body of
`decideAndBroadcast`) — that counts an `overlappingDecisions` metric and
logs an error if two decision cycles for the same session are ever actually
executing concurrently, plus an `inFlightSessions` gauge (new `metrics.js`
`setGauge`/gauges support) exposing its live size on `/metrics`. Extended
`server/coalesce.test.js` (S3 block): event → `DELETE /session/:id`
mid-flight → two more events, asserts `overlappingDecisions` delta is 0 and
`inFlightSessions` settles back to 0.

**Nit — `runCoalescedLoop` re-fetches the session.** Each loop iteration now
calls `getSession(ev.session)` fresh instead of reusing the session object
the loop was started with, so a pending run decides against the CURRENT
session object (relevant if the session was evicted/reset and recreated
mid-loop), not a detached snapshot.

**Nit — overload-wait deadline.** `decideAndBroadcast`'s in-flight-cap wait
loop previously blocked forever; now bounded by `AGENT_OVERLOAD_WAIT_MS`
(default 30000) — past the deadline, falls back to the quiet-tick trace with
reason `"overloaded"` (new `deriveReason()` case, new `overloadTimeouts`
metric) instead of hanging the whole decision cycle indefinitely.

**Nit — state built after the overload wait.** `buildState()` is now
recomputed immediately before the actual `decide()` call (not reused from
before the up-to-30s overload wait), so a slow-to-clear backpressure window
can't hand the decider stale state from before events that landed during the
wait.

**S4 — unbounded scroll-into-view attention (`web/components/AgentWidget.tsx`,
`server/public/agent.js`, `server/decide/stub.js`).** Scroll-into-view
visibility used to grant attention for as long as an element stayed on
screen — a defect relocated below the fold (or just a long page scrolled
past) could accrue "attention" indefinitely with zero actual engagement.
Fixed in both clients: a one-shot credit of at most `SCROLL_CREDIT_MS`
(5000ms) total, ever, per target, from scroll-into-view visibility alone —
tracked as an independent open/close window (`scrollVisibleSince`/
`scrollCreditMs`) inside the existing `syncAttention()` checkpoint; once
spent, only hover/focus/click can still grant attention (and, per the
brief, this also bounds event volume — a visible-but-untouched target emits
no more element-dwell heartbeats once its bucket stops advancing).
`decide/stub.js`'s highlight-on-attention threshold raised 5000ms →
**6000ms** (not the cap lowered) — chosen so the credit cap (5000ms) and the
firing threshold (6000ms) have a real margin between them, so a
below-the-fold reader can never flakily trip the highlight. New fixture
`server/sessions/reader-below-fold.json` (page dwell 25s, size-guide
scrolled into view at ~5s and stays visible thereafter, never
hovered/focused/clicked → `dwell.perTarget["size-guide"]` flatlines at the
5000ms cap) expects `noop`; added to `scripts/check.sh`'s
`REQUIRED_STUB_FIXTURES`. (First draft of this fixture accidentally left
`decide/stub.js`'s threshold at its old 5000ms value — comment updated but
the actual comparison wasn't — caught immediately by `scripts/check.sh`
FAILing the new required fixture; fixed before landing.)

**Nit — `modalUntil` zeroing on another target (both clients).**
`syncAttention()`'s own documented contract ("call after any mutation to
the fields `isTargetActive()` reads") applies to `modalUntil` too. The
click handler's "cancel every OTHER target's modal-heuristic window" loop
used to set `modalUntil = 0` without calling `syncAttention()` — a target
whose active window was open only because of its own modal heuristic
stayed open (in `activeSince` bookkeeping) until the next periodic
dwell-tick sync, over-counting up to one tick interval of attention past
the moment a different target's click actually ended it. Fixed in both
`AgentWidget.tsx` and `agent.js`: `syncAttention(s, now)` called
immediately after zeroing `modalUntil`.

**S5 — same-visit dwell false-negative (`server/state.js`).**
`buildState()`'s per-target dwell cross-check accepted a dwell event only
if its target was in the LATEST `page_view`'s own `visibleTargets` — but
B1's fix now makes a page_view legitimately re-fire on the SAME path (a
modal opening/closing new targets, or a rescan), and a target visible under
an EARLIER page_view of the same path/visit (but not the latest one) was
being dropped as if it were a leak from a different page entirely — a
false NEGATIVE in the same defect class the existing page-scoping guard
targets (see `server/state.test.js`'s (i)-(iii), which reproduce the
false-POSITIVE direction). Fixed: dwell is now accepted if the target
appeared under ANY `page_view` for the CURRENT page path in this visit
(scanned backward from the latest `page_view` until a page_view for a
DIFFERENT path is hit — the actual visit boundary), and
`metrics.inc("dwellDroppedOffPage")` is bumped whenever a dwell is still
genuinely dropped (never appeared under any page_view of this visit) — this
defect class previously failed silently with no observable signal at all.
New `server/state.test.js` case (vii) covers both directions: a target from
an earlier same-path page_view is accepted; a target that never appeared
under any page_view of this visit is still dropped and counted.

**Nits — small cleanups.** `scripts/check.sh`'s stale required-fixtures
comment updated for the new 3-fixture list (was written for 2).
`policy.js`'s `duration_ms` clamp ceiling lowered 30000 → 25000 — it must
stay strictly BELOW `COOLDOWN_MS` (also 30000 by default), otherwise an
effect could be allowed to run exactly as long as the cooldown window,
overlapping the moment a new intervention becomes eligible instead of
always finishing with room to spare (`probe-policy.test.js`'s clamp-range
assertion updated to match). Added a short "IO config drift" comment at
each client's `IntersectionObserver` construction — the two clients use
genuinely different threshold configs (`{threshold: 0.5}` +
`entry.isIntersecting` vs. `{threshold: [0,0.5,1]}` +
`intersectionRatio >= 0.5`) that are semantically equivalent but not meant
to be "aligned" into each other. `.gitignore`: added `server/*.log` (a
stray `server/.cached-server.log` from ad-hoc manual server runs was
present and untracked; deleted).

**Verification:**
- `cd server && npm run test:policy && npm run test:coalesce && npm run
  test:state` — all pass (including the new S2/S3/S5 cases).
- `node --check` on every touched/all `server/**/*.js` — clean.
- `bash scripts/check.sh` — PASS: `sizing-hesitation`, `reader-above-fold`,
  `reader-below-fold` all PASS in stub mode (all three now required).
- S1 command (`AGENT_MODE=stub AGENT_STUB_DELAY_MS=15000` +
  `replay.js sessions/sizing-hesitation.json --speed 1 --settle 170000`) →
  PASS (was FAIL before this pass; see the `--settle` note in the S1
  writeup above for why the default 500ms doesn't show the verdict at all
  under an artificially slow decider, independent of the fix itself).
- Cached-mode replay (`AGENT_MODE=cached`, `REPLAY_FIXED_SESSION=1`,
  `--speed 10`) of the 4 recorded fixtures (`sizing-hesitation`,
  `cart-threshold`, `facts-threshold`, `happy-browsing`) — 4/4 PASS.
- `cd web && npx tsc --noEmit && npm run build` — both clean.

**Not done / left for a follow-up:** did not add a standalone unit test for
`shouldEmitPageView`-style pure logic on the client side, since B1's actual
fix collapsed to "always emit, keyed by pathname" (no conditional helper
worth unit-testing in isolation) — the meaningful regression coverage for
B1/B2 is the manual browser check below, and S1-S5/nits already have
automated coverage (`coalesce.test.js`, `state.test.js`,
`probe-policy.test.js`, `scripts/check.sh`'s new fixture).

**Manual browser check for B1/B2 (ready for browser verification):**
1. Start `server` (any mode) and `web` (`npm run dev` both).
2. Open a product page, note the trace panel's dwell numbers, then navigate
   to a DIFFERENT product page via an in-page link (client-side route
   change, not a full reload).
3. Confirm a fresh `page_view` is sent immediately (Network tab: POST
   `/event` with `type: "page_view"` right after the navigation, even
   though the new page's `data-agent-target` set is identical to the old
   one's).
4. Confirm the first `dwell` heartbeat on the new page (within ~5s) reports
   a small `ms` value (seconds since landing on the NEW page), not a large
   one carried over from time spent on the previous page(s).
5. Repeat once more navigating to a THIRD product page to confirm this
   holds across more than one hop, not just the first.

## 2026-09-11 — research loop: why and how

**Why:** the team needs to research which shopper behaviours actually mean
"stuck" and what help works — that requires being able to look back at real
sessions (not just the 7 hand-authored fixtures), not just watch them live.

**What was added** (see `server/RESEARCH.md` for the full API/file-format
writeup and a curl walkthrough):

- `live-record.js` — records every live session's events and decisions to
  `sessions/live/<sessionId>.json`, gated on `AGENT_LIVE_RECORD=1` OR
  `AGENT_DEBUG=1` (off by default). Hooked into `processEventCore()` (one
  event per call) and `decideAndBroadcast()` (one decision per call,
  regardless of which scheduling path — coalesced or strict-serial —
  produced it). `fx_*` (demo-player fixture sessions) and `rp_*` (this
  pass's own shadow-replay sessions, see below) are never recorded — both
  are synthetic re-runs of already-scripted/already-recorded material, not
  real shopper sessions. Debounced write (≤1/s per session), flushed
  immediately on a decision. 500-file cap, oldest by `lastAt` evicted first.
- `research-routes.js` — `GET /sessions`, `GET /sessions/:id`,
  `POST`/`DELETE /sessions/:id/labels[/:index]`, `GET /sessions/:id/fixture`
  (exports a `replay.js`-compatible fixture), `POST /sessions/:id/replay` +
  `GET /sessions/:id/replay/:job` (replays a recorded session's non-replay
  events into a fresh shadow session `rp_<hash8>` through the CURRENT
  prompt/rules, via the same `processEventSerial()` cached-mode/tuning-tool
  playback already uses), `POST /session/:id/decide` (forces a decision now
  for a live session, bypassing tick.js/gate.js but NOT policy/cooldown).
  All of it lives behind `AGENT_DEBUG=1` — plain 404 otherwise, same
  treatment as `/logs/recent` and `DELETE /session/:id`. Same
  factory-router pattern as `health.js`'s `createHealthRouter()`: index.js
  passes in its own closures (`broadcast`, `decideAndBroadcast`,
  `processEventSerial`, `getSession`/`peekSession`, an in-flight check)
  rather than this module reaching into index.js's module state directly.
- `index.js` changes: `processEventCore(ev, opts)` and
  `processEventSerial(ev, opts)` now thread an `opts.replay` flag through
  (from `POST /event`'s existing `x-agent-replay` header check) so
  live-record.js can tag which recorded events came from a live browser tab
  vs. `replay.js` driving that same (non-fixture) session id — a day-of
  tuning-loop scenario, distinct from this pass's own `rp_*` shadow
  sessions. `decideAndBroadcast()` gained `opts.force` (bypass tick/gate,
  keep policy/cooldown — the forced-decide route) and `opts.reasonLabel`
  (override the derived log/record reason, used to stamp a forced decision
  `"forced"` instead of `"llm"/"stub"`), and now RETURNS
  `{action, trace, reason, ms}` (previously void) so both the forced-decide
  route and the replay-job loop can report exactly what a normal caller
  only sees via broadcast + the log line.

**Known limitation (documented, not fixed — same category as
`decide/cached.js`'s own cooldown caveat):** `POST /sessions/:id/replay`
preserves each event's ORIGINAL recorded `ts` (tick.js/gate.js's time-window
rules key off `event.ts`, not wall-clock spacing between POSTs) but runs the
events back to back with no real-time delay. `policy.js`'s 30s cooldown
check IS wall-clock (`Date.now() - session.lastInterventionAt`), so a
session whose real decisions were minutes apart can, replayed instantly,
see a later proposal wrongly denied by cooldown even though the original
wasn't. Unlike cached-mode fixture playback, this replay path does NOT set
`skipCooldown` — the brief calls for "tick/gate/policy apply" unmodified, so
a shadow replay's cooldown-denied noop is itself informative (current rules
would have gone quiet here) rather than a bug to mask.

**Verification:** `node --check` on every touched/new file;
`npm run test:policy && npm run test:coalesce && npm run test:state &&
npm run test:gate` all pass; `bash scripts/check.sh` PASS; new
`npm run test:research` (`server/research.test.js`) passes 15/15 assertions
across three short-lived servers (stub+debug driving a real hesitation
session through every research endpoint including the fixture-export →
`replay.js` round trip; plain stub confirming every research route 404s
without `AGENT_DEBUG`; cached+debug confirming `POST /session/:id/decide`
and `POST /sessions/:id/replay` both 409 and the 4 recorded fixtures still
go 4/4). `coalesce.test.js` picked up a small cleanup for the sessions/live/
files its own `AGENT_DEBUG:"1"` env now causes live-record.js to write (a
side effect of this pass, not a defect in that test).

## 2026-09-11 — Store-knowledge layer: catalog/promos/policies → offers (business context)

Added `server/store/` — the merchant's business context as files
(`catalog.json`, `promos.json`, `policies.json`), loaded/hot-reloaded (mtime
check, no restart) by `server/store/index.js`, which is the ONLY place that
reads them. Two things flow from it into `buildState()` (`server/state.js`):
`business` (compact `{delivery, returns, payment}` from policies.json — the
prompt now quotes this instead of a hardcoded ৳2,000 free-delivery number)
and `offers` (`missed_discount`, `auto_discount_active`, `similar_on_promo`,
`delivery_gap` — see `server/store/README.md` for the full contract and how
a merchant edits these files).

`server/gate.js` gained two more friction signals (now eight total, was six)
sharing the same `computeSignals()` both gate.js and tick.js already use:
`promoMissed` (a `missed_discount` offer + hesitation on cart/checkout —
dwell ≥ `PROMO_CART_DWELL_MS` or a cart↔checkout bounce) and `similarPromo`
(a `similar_on_promo` offer + the SAME elementAttention/returnVisit evidence
rules 1/2 already compute, deliberately reused rather than re-implemented so
"what counts as attention" can't drift between rules). `CART_GAP_PCT` is now
exported from gate.js so `computeOffers()`'s `delivery_gap` offer reuses the
exact same 10% band as the existing cart-friction rule instead of a second
hardcoded copy.

`decide/stub.js` got two more deterministic rules (after the existing
highlight rule, before the noop fallback) mirroring the same gating gate.js
uses, for `server/sessions/missed-promo.json` and
`server/sessions/similar-on-promo.json` — both pass in stub mode and are now
in `scripts/check.sh`'s `REQUIRED_STUB_FIXTURES`.

**Catalog note:** `catalog.json`'s `similar` field is an explicit merchant
list, not a computed heuristic. `leather-mojari-sandals` (no promo of its
own) lists `nakshi-kantha-scarf` (has an evergreen auto-apply promo) as
`similar` specifically so `similar-on-promo.json` has a real fixture to
exercise — jacket and saree both carry their OWN active promos in the
current `promos.json`, so neither can stand in as "the product with no
promo of its own" for this scenario.

**Known gap (not fixed, scoped out):** `computeOffers()`'s `similar_on_promo`
/ "is the current product itself on promo" check does not run `min_cart`
against a hypothetical cart (buying just that one item) — a promo with
`min_cart` attached to the CURRENT product page counts as "on promo" (or
not) independent of whether browsing alone would actually clear that floor.
Doesn't affect the current promos.json (`SAREE200`'s `min_cart` 1500 ≤ its
own ৳1,950 price, so it's realistically always clearable), but a future
promo with `min_cart` > its own product's price would misreport. Whoever
touches `min_cart` next should audit this.

**Verification:** `node --check` on every touched/new file; `npm run
test:store` (new, 10/10 assertions), `npm run test:gate` (9/9, was 6/6),
`npm run test:state` (unchanged, still passing) all pass; `node
web/scripts/check-store-mirror.mjs` (a parallel worker's script, diffs
web/lib/{products,promos}.ts against server/store/{catalog,promos}.json)
passes — the promo ids/values in `server/store/promos.json` and
`web/lib/promos.ts` were designed independently by two workers in parallel
and matched exactly. `bash scripts/check.sh` PASS (5/5 required stub
fixtures, including the two new ones; `cart-threshold`/`facts-threshold`
remain informational-only failures in stub mode, same as before this pass —
the stub decider has never had a free-delivery-message rule, only
LLM mode does).

## Zero-result search card + delivery-gap-over-promo priority (2026-09-12)

Two live LLM-decider gaps fixed at the source, not patched in the prompt
alone: (1) `state.js`'s `search` field + `store/index.js`'s new
`searchCandidates()`/`search_help` offer give the model a REAL fuzzy-matched
candidate (token-overlap + edit-distance against catalog name/category/tags,
threshold 0.55, empty when nothing real matches — never fabricates) for a
zero-result search, so `prompts/decide.md`'s "Failed search" recipe now has
something concrete to build a `cta.kind:"search"` card on instead of always
noop-ing. (2) A new prompt priority rule: checkout→cart back-nav/bounce with
a `delivery_gap` offer outranks a same-moment generic promo
(`missed_discount`/`auto_discount_active`/`similar_on_promo`) card. Along
the way found and fixed a THIRD, broader defect: the prompt never told the
model to set a card's `target` to its grounding offer's own `target_hint`
(`store/index.js` computes it, but nothing said to use it) — the model was
picking plausible-looking-but-wrong elements (`cart-link`, `place-order`)
for `delivery_gap`/`missed_discount` cards even after choosing the right
offer. Fixed with an explicit target_hint→target rule in "Rules". New
fixtures `sessions/zero-result-search.json` / `sessions/gap-over-promo.json`
(NOT in check.sh's stub-required list — need the real LLM loop), each PASSED
live 2/2 (`AGENT_MODE=llm LLM_BACKEND=claude LLM_MODEL=sonnet`, `LLM_CACHE=0`
to force genuine calls, not the fingerprint cache) and are recorded for
cached playback (`sessions/recorded/fx_zero_result_search.json`,
`fx_gap_over_promo.json`). Recording `gap-over-promo` took 3 attempts:
`AGENT_RECORD=1` bypasses gate.js/tick.js entirely (by design — a recording
needs exactly one entry per event), which asks the model at every quiet
tick too, not just gate-worthy moments, and it was noticeably more
trigger-happy under that regime than in normal gated live traffic (which
never showed this in 2/2 clean runs). Also reset the session
(`DELETE /session/:id`, needs `AGENT_DEBUG=1`) between recording attempts —
state.js's cooldown/actedTargets/nudgeCount otherwise leak across repeated
`REPLAY_FIXED_SESSION=1` runs against the same long-lived server and
contaminate the next attempt's proposals. `search` meta's optional
`results: number` field added to `contracts.js`/`contracts.ts`
(`META_SHAPES`) — lenient/optional, matches the existing `search_help`
requirement that it be EXACTLY 0, never an absent/guessed 0. `node --test
server/*.test.js` 7/7, `bash scripts/check.sh` PASS. **Not built**: the web
search box (`web/components/Nav.tsx`) is decorative — it never computes
`meta.results`, so this whole chain is currently unreachable from a real
browser session until the client gets an actual product search (see
this doc).

## 2026-09-12 — card templates + stale-response guard

**Card templates** ("notifications won't be random; the model decides
which, the merchant owns the words"): new `server/prompts/templates.json`,
8 recipes (`size_help`, `missed_discount`, `auto_discount_active`,
`similar_on_promo`, `delivery_gap`, `search_help`, `stuck_checkout`,
`low_stock`), each `{when, title, body, cta.kind, slots: {name: {max_len}},
tone}`. Decider output (`prompts/schema.json`) now accepts `card.template` +
`card.slots` INSTEAD of free `title`/`body` (both now nullable in the
schema, `template`/`slots`/`title`/`body` all `required` so strict
JSON-schema backends still see a fixed key set — whichever pair is unused
is `null`); free-text stays accepted for back-compat. `server/templates.js`
(`renderCard(card, state)`) is the ONE place that turns `{template, slots}`
into `{title, body}`: unknown template id, a missing/oversized slot, or a
slot value not traceable to a real fact in `state.offers`/`product`/
`business`/`facts` (an array's own length also counts as a real fact — e.g.
`search_help`'s candidate count) all fail closed to a `template ...` policy
violation, same "deny down to noop" path as every other card guard.
`server/policy.js`'s `applyPolicy()` calls `renderCard()` right after
`normalize()`, before `checkViolation()` — so every downstream guard (cta
realness, length caps) sees a plain rendered card exactly like the
free-text form always produced. `prompts/decide.md` lists all 8 recipes'
`when`/slots and tells the model to prefer template+slots, copying values
verbatim from state, never rewording/rounding.

Found and fixed live (not caught by unit tests — only by live 8-run
verification): `normalizeAction()`'s pre-existing "a card missing title/
body/cta.label is meaningless, force noop" guard ran BEFORE renderCard()
ever gets a chance to fill them in, so every template card (whose title/
body are legitimately null until rendered) was silently downgraded to noop
at normalize time — no guard reason recorded (trace stayed exactly as the
model wrote it, since this path bypasses `checkViolation`/`denied()`
entirely). Fixed by teaching that guard about `card.template`: a card with
a template id (regardless of empty title/body) or a free title+body passes
through; only a card with neither is nuked early. `server/policy.js` ~200.

**Stale-response guard** (category: a decision computed against a snapshot
10-20s old — real LLM latency — must never render against a changed
shopper context; Guard A already re-checked target liveness, nothing else
was covered). New `server/stale.js`: `computeContextFingerprint(session)` →
`{page, productSlug, cartHash, lastEventId, lastEventTs}`, captured in
`index.js`'s `decideAndBroadcast()` right before the `decide()` call (the
same point state is finalized for that call).
`classifyStaleContext(fingerprint, session, actionTarget)` re-derives live
from `session.events` (same scan-backward idiom as Guard A's
`currentVisibleTargets`/`currentPage`, never a `buildState()` recompute) and
classifies drift: `product_changed` (live productSlug differs) >
`cart_changed` (live cart ids+qty+promo hash differs) > `moved_on` (page
changed, OR ≥3 new hesitation-class events — rage_click / attention-kind
dwell — landed on a DIFFERENT target than the decision's own while the
decider was thinking). `policy.js`'s `checkViolation()` runs this as the
FIRST check on any non-noop proposal (`opts.contextFingerprint`, wired from
`index.js`); a hit denies with `stale_context:<class>`, fail closed, same
`denied()` path as every other guard. `noop` is exempt by construction
(the existing `if (action.action === "noop") return null;` runs first).
Missing `opts.contextFingerprint` (an older call site, a test) is "no
opinion, don't deny" — same carve-out Guard A uses for an empty
`liveTargets`.

Coalescing already does the "re-decide" half for free: a stale drop never
itself schedules an extra `decide()` call — if new events arrived during
the in-flight decide() (the ones that made the fingerprint stale), the
coalescing scheduler's own `pending` flag was ALREADY set by
`scheduleCoalescedDecision()`, so `runCoalescedLoop()` runs exactly one more
round against fresh state regardless of whether this guard exists.
Confirmed by `server/stale-coalesce.test.js` (spawns a real server,
`AGENT_STUB_DELAY_MS`-slowed stub decider, asserts `decisionsStarted`
matches exactly the expected count — no double model call from the stale
drop itself).

Also closed the audit finding at `policy.js` ~349: `pick_size`'s CTA guard
validated `value` against `state.product.sizes` — the PRE-decide snapshot —
so a decision resolving after the shopper navigated to a different product
could validate a size against the WRONG catalog entry. Fixed with
`stale.js`'s `liveProduct(session)`, re-derived from the session's live
latest `page_view`; falls back to the snapshot only when there's no live
`page_view` at all yet (same "no opinion" carve-out). `add_to_cart`/
`open_product`'s cta guard was already live (validates against
`loadStore().catalog`, not `state`) — no change needed there.

Stale drops are recorded in the live-record trace (`trace.why` carries the
`stale_context:<class>` reason via the normal `denied()` annotation — no
new recording plumbing needed) and surfaced in
`GET /sessions/stats`' new `staleDrops: {product_changed, cart_changed,
moved_on}` breakdown (`research-routes.js`, parsed from `trace.why`), so the
research page shows WHY nothing appeared instead of a session just looking
quiet.

**Verification:**
- `node --test server/*.test.js` (run individually — `node --test`'s
  default concurrency causes port collisions between the several test files
  that each spawn their own server; sequential `node <file>.test.js` is the
  reliable way to run this suite, same as `npm run test:*` always was)
  11/11 PASS: `coalesce`, `gate`, `outcome`, `probe-policy`, `research`,
  `sites`, `state`, `store`, plus new `templates.test.js` (9 assertions),
  `stale.test.js` (12 assertions: each drift class, missing-fingerprint
  back-compat, noop exemption, the pick_size live-product fix), and
  `stale-coalesce.test.js` (the coalesce-path re-decide-exactly-once check).
  `coalesce.test.js` re-run 3x standalone with no flake.
- `bash scripts/check.sh` — PASS (all 5 required stub fixtures pass;
  optional `facts-threshold`/`gap-over-promo`/`zero-result-search` fail in
  stub mode as documented — need the real LLM loop, unchanged from before
  this pass).
- Live `AGENT_MODE=llm LLM_BACKEND=claude LLM_MODEL=sonnet LLM_CACHE=0` runs
  via `replay.js`, 2 runs each: `sizing-hesitation` 2/2 PASS, `cart-threshold`
  2/2 PASS, `zero-result-search` 2/2 PASS, `gap-over-promo` 2/2 PASS — 8/8,
  all delivering template-rendered cards (confirmed via server logs, e.g.
  `decided":"card size-guide"`). One transient guard denial during
  `cart-threshold` run 1's first decide() call (a cooldown-class guard, not
  a template/stale-guard reason) self-resolved via the coalesced re-decide,
  same pattern as the pre-existing `LLM_TIMEOUT_MS` retry documented above.
- Re-recorded `sessions/recorded/fx_{sizing_hesitation,cart_threshold,
  zero_result_search,gap_over_promo}.json` (`AGENT_MODE=llm AGENT_RECORD=1`,
  session reset between each) now that live passed — `gap-over-promo`
  needed a second recording attempt (same documented AGENT_RECORD=1
  trigger-happiness as above, not a regression from this pass). All 4 replay
  correctly in `AGENT_MODE=cached` (`research.test.js`'s "4/4 recorded
  fixtures pass in cached mode" assertion, plus a direct `replay.js`
  `--speed 20` run against a fresh cached-mode server).

**Not built**: `web/lib/contracts.ts`'s `AgentCard` wire type is
deliberately UNCHANGED — templating resolves to plain `{title, body, cta}`
entirely server-side before broadcast, so the widget never needs to know
templates exist. NOTES.md updated.

## 2026-09-12: shopper-pattern signals (me_1 defect class)

**Symptom** (owner, live): "impossible to trigger... no way a user will sit
there for 3 hours." Real session `me_1` — a genuine ~3-minute shopper visit,
not a scripted fixture — dumped via `curl localhost:4000/sessions/me_1`,
saved as `server/sessions/samples/me_1.json` (332 raw events; the earlier
`server/sessions/samples/me_1-events.json`/`me_1-state-before.json` were a
separate, already-in-repo capture from a prior session id reuse — left
untouched). Path sequence: `/product/khadi-field-jacket` → `/` →
`/product/leather-mojari-sandals` → `/` → `/product/nakshi-kantha-scarf` →
`/` → `/cart` → `/` → `/product/khadi-field-jacket` → `/` →
`/product/nakshi-kantha-scarf` → `/`, with a sandals add-to-cart along the
way. 252 decisions logged: 239 `quiet` (tick.js), 9 `gate` (gate.js denied),
only 4 reached the model — 3 `noop`, 1 `highlight` (the session's only
intervention, at ~217s in).

### Diagnosis table — the 4 real model calls

| # | ts (rel) | trigger | gate.js state model saw | decision | why noop/highlight |
|---|---|---|---|---|---|
| 1 | ~55s | `back_nav` | pageMs~45s on jacket but `dwell.perTarget` empty (no element attention accumulated — only page-level heartbeats); no size-guide/size-picker interaction; cart has an unrelated item | `noop` (conf 0.70) | "pageMs alone without perTarget attention isn't hesitation per policy" — correct call given the actual signals, but nothing else in gate.js gave the model a REASON to be asked again for 65s |
| 2 | ~65s | `search` | cart already above free-delivery threshold; offers empty; dwell.perTarget empty on current page (scarf) | `noop` (conf 0.85) | no offer/attention signal tied to this page — correct given inputs |
| 3 | ~77s | `back_nav` | cart above threshold; offers empty; brief 3.3s hover on scarf card; past long jacket dwell, now on home | `noop` (conf 0.75) | "brief hover alone isn't strong hesitation" — the FIRST of 3 growing hover samples on the scarf card (3.3s→6.3s→9.3s across visits), each one individually below the old 5s `ELEMENT_ATTENTION_MS` |
| 4 | ~90s | `dwell` (scarf card) | hover_ms grown 3291→6293→9291ms across visits; zero clicks; cart above threshold; no offers | `highlight product-card-nakshi-kantha-scarf` (conf 0.55) | the ONLY signal that ever crossed a threshold in the whole session — element attention finally hit the old 5000ms bar on the 3rd visit |

**Root cause, stated as a category**: `gate.js`'s eight signals + `tick.js`'s
trigger reason over a SINGLE element's accumulated dwell within ONE page
visit, or a single page-level friction pattern (back_nav, bounce, cart
dwell). A real shopper's friction shows up ACROSS visits and across pages —
returning to a product after browsing elsewhere, glancing at cart and
leaving without checking out, coming back to something after visiting cart,
browsing several things without ever committing — and none of rules 1-8
name that shape. me_1's real per-element attention samples never got
"stuck" past 3-9s on any one visit (a real shopper doesn't hover 8+ seconds
like a scripted fixture); the SEQUENCE across visits was the real signal,
and nothing was looking at sequences.

### Fix — `gate.js` rules 9-12 (new signals), `tick.js` wiring, retuned thresholds

- **Re-tuned existing thresholds** (`server/gate.js`) against me_1's measured
  real-attention distribution — per-ELEMENT (non-page) dwell samples this
  session: `[3218, 3291, 3900, 3901, 6293, 6900, 9291]`ms, p50≈3901ms,
  p60≈5336ms. `ELEMENT_ATTENTION_MS` 5000→4000ms (~p50, since p60 barely
  differs from the old value and still misses most real bursts),
  `RETURN_VISIT_ATTENTION_MS` 3000→2000ms, `CART_DWELL_MS` 8000→4000ms
  (me_1's real cart-page glance before leaving was 4600ms, under the old
  8s floor — the cart friction rule never got a chance to fire on that
  visit even though the free-delivery gap math would have qualified it, had
  the cart total been below threshold).
- **New signals** (rules 9-12, `computeSignals()`/`gate()` in `gate.js`,
  wired into `tick.js`'s `flags` object so a newly-true flag triggers a
  decider call even with the dwell bucket unchanged):
  - `pingPong` — same product path viewed twice with >=1 other page_view in
    between, within 90s.
  - `breadthNoCommit` — >=3 distinct products viewed this session, zero
    add-to-cart (`cart_update` with `target: "cart-add"`) ever.
  - `cartLeave` — cart page_view followed by navigation to a non-checkout
    page, within 60s (checkout as the next page does NOT count as "leave").
  - `returnAfterCart` — a product seen before the most recent cart visit is
    seen again after it, within 90s.
- **`AGENT_SENSITIVITY=normal|demo`** (`server/policy-config.js`,
  `getSensitivityMultiplier()`) — `demo` (×0.6) scales every ms
  threshold/window above plus `buckets.js`'s `bucketAttention()` boundaries
  (which drive `tick.js`'s dwell-bucket trigger) and floors
  `BREADTH_MIN_PRODUCTS` at `Math.max(2, round(3*mult))`. Exposed in
  `GET /health`'s `policy` block via `describePolicyConfig()`; passed
  through `.env.example` and `docker-compose.yml`.

### Cost check — `server/replay-count.test.js`

Replays me_1's raw events through the real `buildState`/`shouldCallDecider`/
`gate` pipeline with **no model call**, counting would-call decisions:

| Sensitivity | Would-call decisions | Session length | Calls/minute |
|---|---|---|---|
| (old code, measured from me_1's actual production decisions) | 4 | 3.1min | ~1.3 |
| `normal` (new code, default) | 7 | 3.1min | 2.27 |
| `demo` (new code, `AGENT_SENSITIVITY=demo`) | 14 | 3.1min | 4.53 |

Both new numbers land inside this fix's targets (2-4/min normal, 4-8/min
demo). New would-call reasons on me_1 include `cart visit and leave`,
`product ping-pong` (jacket and scarf both), `return to product after
cart`, and the two original rules (element attention, return visit) now
firing sooner off the retuned thresholds.

### Live check

`AGENT_MODE=llm LLM_BACKEND=claude LLM_MODEL=sonnet AGENT_SENSITIVITY=demo`
on port 4806 (never 4000/3000/3800/3801/8081), me_1 replayed via
`replay.js` at `--speed 5`: the model correctly proposed
`card size-guide` (the `size_help` template) off real size-picker attention
(hover+focus+click, 3901ms) early in the replay — a decision the ORIGINAL
pipeline never produced for this session at all (its only real
intervention was a late `highlight`, not a card). Two real llm decisions in
the first pass (`page_view` → noop, `dwell` → card size-guide); a repeat run
against the same still-warm process hit `decide/llm.js`'s in-memory
fingerprint cache (`reason: "cache"`) rather than re-calling the model —
expected behavior of that unrelated cache layer, not a re-test bug. No
prompt changes made or needed here — the model responded correctly once
gate.js actually asked it.

### Known duplication (flagged by the templates worker, 2026-09-12)

`server/state.js` is being rewritten by another worker to expose a
`patterns` field (`pingPong`, `breadthNoCommit`, `cartVisitedThenLeft`,
`returnedAfterCart`, ...) computed from session events — the same shopper
shapes as `gate.js`'s new rules 9-12 above, computed independently and
under different names/field shapes. Left as two separate implementations
for now per instruction (don't touch files another worker owns mid-change);
whoever picks this up next should unify them into one shared computation
(most likely folded into `gate.js`'s `computeSignals()`, the existing
"one place defines a signal" pattern this file already uses for
`isPageDwellTarget`/`bucketAttention`) so `state.js` and `gate.js` can't
drift on what "cart-visit-and-leave" or "ping-pong" mean.

### state.js rewrite — shopper narrative, not raw event tails (2026-09-12)

`buildState()` used to hand the model almost nothing useful for a real
multi-page session: `visibleTargets`/`product` went null the moment a
session lost its page snapshot, and `recent` (last 20 raw events) filled up
entirely with near-identical dwell heartbeats for a long page visit,
crowding out anything the shopper actually DID. Fixed by adding
`journey` (collapsed page-visit list + pagesVisited/distinctProducts/
returnsToSameProduct/cartVisits/checkoutReached/sessionSeconds), `focus`
(top 6 attention targets session-wide + `focusNow`), `patterns` (see
"Known duplication" above — this is the state.js half of that same
computation), `needsResnapshot` (true when a session has events but has
never seen a page_view), and rewriting `recent` to only ever include
MEANINGFUL events (page_view, cart_update/cart_view, search, back_nav,
rage_click, first attention-dwell crossing per target per visit) — never a
raw heartbeat tick. All existing fields (`page`, `visibleTargets`, `cart`,
`promo`, `search`, `facts`, `business`, `offers`, `product`, `dwell`,
`lastIntervention`) are unchanged in shape; every consumer (gate.js,
tick.js, policy.js, decide/*.js) keeps working untouched. Tests:
`server/state.test.js` (fixture-based, see below).

**me_1 fixture provenance — READ BEFORE re-using this session as evidence of
anything about real shopper behavior.** `server/sessions/samples/
me_1-events.json` (pulled live via `curl localhost:4000/sessions/me_1`,
2026-09-12) contains 371 events, EVERY ONE of them `dwell`, on only two
targets (`/` and `/product/khadi-field-jacket`) — zero page_view, click,
cart_update, or search ever recorded for this session. **This is not a real
"6 minutes on 2 pages" browsing session** — me_1's actual page_views lived
only in the in-memory `session.events` ring (state.js's module comment) and
were lost when the server container was recreated at ~02:20 that
session's early activity (whatever pages it actually visited) went with
it; every event recorded from that point on is a post-restart dwell
heartbeat with no page_view ever re-arriving. It's kept in the test suite
specifically AS a regression fixture for that failure mode
(`needsResnapshot: true`, product resolved via the dwell-target fallback
path, `recent` empty since no element-attention dwell exists in it) — not
as a representative "real shopper journey" fixture. `server/sessions/
samples/s_kmtgye1g-events.json` (also pulled live, same date) is used for
that instead: 593 events, real page_view/cart_update/cart_view sequence,
12 collapsed visits, 4 distinct products, 3 cart visits, checkout reached.

## 2026-09-12: consult floor + page moment + cost cap (model-only-on-signal-edge defect class)

**Live finding.** Owner testing Acme, session `you_2` (`curl -s
localhost:4000/sessions/you_2`): 47 events, 31 decision cycles, **0 model
calls** — every single decision skipped as a `tick.js` quiet tick or a
`gate.js` gate, including every `page_view` (landing page → `/shop` → a
product page → home). The shopper-pattern signals added earlier the same
day (rules 9-12) need a return visit or several distinct products; a first
minute of ordinary browsing trips none of the twelve `gate.js` signals, so
the model never even gets asked. **Category: the model is only ever
consulted on a signal EDGE (a bucket crossing, a flag flipping true) — there
was no floor.**

### Fix

Two new fallback trigger reasons, both pure functions in `gate.js`
(exported for `tick.js` to reuse, same "one place defines the window"
principle `computeSignals()` already follows):

- `consultFloorCheck(state, session, event, now, floorMs)` — hit when the
  shopper is active (`>=1` non-heartbeat event — anything except a
  page-level dwell heartbeat, `isHeartbeatEvent()` reuses `buckets.js`'s
  `isPageDwellTarget()` — in the last 20s) AND it's been `>= floorMs`
  (`AGENT_CONSULT_FLOOR_MS`, sensitivity-aware default 30000/20000
  normal/demo, new `getConsultFloorMs()` in `policy-config.js`) since the
  last model call. Baselines to `session.lastDeciderAt` when the model has
  already been called this session, else to the session's own FIRST event
  — NOT epoch 0, otherwise a brand-new session would read as "overdue"
  from the moment it started (caught by `gate.test.js` (iii) regressing
  when this was first built with the naive `now - (session.lastDeciderAt ||
  0)` baseline: a 1-second-old session with a 25s plain dwell heartbeat
  started passing via `floor` instead of staying gated, since `now - 0` is
  always enormous against a real epoch timestamp).
- `pageMomentCheck(state, session, event, now)` — hit when `event` is a
  `page_view` landing on a product/cart/checkout page (`classifyPath()`,
  the same one every other rule in this file already uses) AND the shopper
  has `>=2` OTHER page_view events already this session.

**Ordering matters.** Both were originally wired in at the TOP of `gate()`
(right after the cooldown/cap hard guards, before `computeSignals()` ran at
all) per a literal reading of "regardless of buckets/signals" — this broke
~10 of the 13 pre-existing `gate.test.js` cases, because with
`session.lastDeciderAt` starting at 0, `floor.hit` was true from the very
first qualifying event in almost every synthetic test session, masking
every specific-signal reason (`element attention`, `navigation friction`,
etc.) with the generic `floor` reason instead. Moved both to the BOTTOM of
`gate()`, checked only after all twelve `sig.*` checks already had their
turn and none hit — `floor`/`page_moment` are a fallback for "nothing else
justified a call", never a priority override of an actual signal. This is
what "the gate must not veto floor/page_moment unless a hard guard applies"
in the fix brief actually meant: bypass the FINAL "no friction signal" fail
path, not jump the queue ahead of rules 1-12.

**Cost cap.** `AGENT_MAX_MODEL_CALLS_PER_MIN` (default 6, exported from
`gate.js`) is a hard per-session ceiling checked in `gate()` right after the
cooldown guard (before `computeSignals()`, before floor/page_moment) — it
applies to EVERY reason, not just floor, via `session.modelCallTimestamps`
(a rolling-60s-window array, pruned on every `gate()` call, the same kind of
session-scoped memoization `tick.js` already uses for `lastCartTotal`/
`lastSignalFlags` — not initialized in `state.js`'s `getSession()`, added
lazily here). Recorded on every `pass:true` return via a shared
`recordModelCall()` helper (all ~13 return sites call it). Deliberately kept
OUT of `policy-config.js`'s validated-singleton loader — the fix brief
scoped that module to exactly one new knob (`AGENT_CONSULT_FLOOR_MS`, which
needs `AGENT_SENSITIVITY`-aware defaults); `AGENT_MAX_MODEL_CALLS_PER_MIN`
is a single simple positive-integer env var with no sensitivity coupling,
parsed inline in `gate.js` with the same warn-and-fallback shape.
Cap-trim logging is deduped to at most once per rolling 60s per session
(`session.lastRateCapWarnAt`) — without this, a busy session sitting at the
cap logs `[gate] rate cap trimmed a floor call` on literally every
subsequent qualifying event for as long as the shopper stays active, since
`floor.hit` doesn't clear until a real call actually gets through.

### Measured before/after (`server/replay-count.test.js`)

Replays raw events through `buildState()`/`shouldCallDecider()`/`gate()`
with no model call. "Before" = temporarily reverting `gate.js`/`tick.js` to
their pre-fix content and re-running the same replay (no git in this repo,
so this was a literal file-swap-and-rerun, not a `git stash` diff):

| Fixture | Before | After |
|---|---|---|
| `me_1` (3.1min, 332 events) | 2.27 calls/min (7 calls) | 3.89 calls/min (12 calls) |
| `final_tm_242431` (7.8min, 239 events, saved via `curl -s localhost:4000/sessions/final_tm_242431 > server/sessions/samples/final_tm_242431.json` — the session that surfaced this defect) | 5.89 calls/min (46 calls) | 5.76 calls/min (45 calls), max 6 in any rolling 60s window (at the cap) |

`final_tm_242431`'s before-number is already reasonably high because it
already carries heavy rule-1-12 signal coverage from the earlier
shopper-pattern fix (2026-09-12, above) — this fixture's actual value here
is qualitative, not the headline number: the floor closes exactly the
pre-signal opening-minute gap `you_2` exposed live (see
`replay-count.test.js`'s console output — `floor`-reason calls cluster at
indices 19-24, 131-137, 201-238, i.e. every stretch where the shopper is
browsing/dwelling on a product with no signal yet crossed), while the cap
keeps the session from running away past 6/min once real signals start
firing densely later on.

### Known replay-harness limitation

`replayCount()` never calls the real `decide()`, so `session.lastDeciderAt`
(which only advances inside index.js's `decideAndBroadcast`, on an ACTUAL
decider call) stays 0 for the entire replay — `consultFloorCheck()`'s
baseline pins to the session's first event throughout, meaning `floor.hit`
stays eligible on every qualifying active event for the rest of the replay
once the initial `floorMs` grace period elapses, rather than resetting
after each real call the way it would in production. This makes the harness
a pessimistic (upper-bound) count of floor-driven calls — acceptable for a
cost check (the cap still holds in the worst case) but not a faithful
simulation of the floor's own per-call reset cadence; `gate.test.js`
(xiv)/(xv)/(xvii) test that directly against `consultFloorCheck()` instead.

Tests: `server/gate.test.js` (xiv) floor fires on an active signal-free
session, (xv) floor does NOT fire without a recent non-heartbeat event,
(xvi)/(xvi.b) page_moment fires on a product/cart/checkout page after >=2
prior page views but not before, (xvii) cost cap trims floor calls at
exactly `MAX_MODEL_CALLS_PER_MIN`/rolling-60s. `server/replay-count.test.js`
extended with the `final_tm_242431` fixture, asserting both an overall
per-minute band and a hard per-rolling-60s-window cap check (re-reading
event timestamps by index rather than trusting the aggregate average alone,
since a burst under the average could still spike over the cap).
`bash scripts/check.sh` PASS (stub mode bypasses tick.js/gate.js entirely,
so this fix touches none of check.sh's fixture-replay assertions); every
`*.test.js` run individually, all pass.

Files touched: `server/gate.js`, `server/tick.js`, `server/policy-config.js`
(one new knob, `getConsultFloorMs()`), `server/gate.test.js`,
`server/replay-count.test.js`, `.env.example`, `docker-compose.yml`,
`server/POLICY.md`, this section. **Not browser-verified**
— ready for browser verification, needs a server image rebuild first.

## Restraint-over-acting / structurally-impossible cards / missing moments (2026-09-12)

**Root cause table.** Live finding, Acme session `final_tm_242431`
(4-minute real journey, 99 decisions, 9 real LLM calls, **0 interventions**)
plus a NextCart live pass (session prefix `final_nc_`):

| Category | Root cause | Fix |
|---|---|---|
| (a) prompt over-weights restraint | `prompts/decide.md` demanded a "strong" hesitation signal even when `patterns` already said hesitation was real, and had no `checkoutBounce`-shaped flag to check at all | New "Deciding whether to act — moments first" section: default flips to ACT once any `patterns.*` flag is true or a moment happened; restraint numbers stay in `policy.js`'s guard chain, not model judgement. New `patterns.checkoutBounce` (`state.js`'s `buildPatterns()`) |
| (b) cards structurally impossible off-page | `policy.js` required `target === visibleTargets` with no fallback; `promo-code`/`shipping-banner`/`similar-products` only render on cart/checkout/product pages, never on /shop, home, category pages, or NextCart's differently-named search box (`search-input`, not `search`) | Anchor fallback: `templates.json` per-template `anchor: [natural target_hint, ...fallbacks]`; `policy.js`'s `applyPolicy()` rewrites `action.target` to the first entry present in `effectiveVisibleTargets()` (intersection of the snapshot + live re-check, so a picked fallback is guaranteed to actually pass both downstream guards) and notes `anchor_fallback <from>-><to>` in `trace.signals`. Skipped for `pick_size`/`size_help` (no `anchor` key declared, plus an explicit `cta.kind !== "pick_size"` guard) — no safe fallback for "pick a size" off the size picker |
| (c) no template for the two biggest real moments | no template existed for a checkout bounce (login wall / back-nav away from checkout) or a cart stuck under the free-delivery threshold while just browsing | Two new templates: `checkout_bounce` (cta `apply_code`/`open_product`/`none` depending on what's real; no slots, fixed reassuring copy) and `cart_under_threshold` (same slots as `delivery_gap`, gated to non-cart/checkout pages in the prompt). New offer kind `cart_under_threshold` (`store/index.js`, computed whenever `cart.total > 0` and under `free_over`, independent of `delivery_gap`'s existing 10%-band gate — `store.test.js` (vi)/(vii) unaffected) |

**checkoutBounce definition — one real regression found and fixed while
building this.** First draft: "reached checkout, next visit isn't checkout"
— this also matched a plain checkout→cart back-nav, which is the
PRE-EXISTING "delivery gap over generic promo, on checkout↔cart friction"
priority rule's own shape. Conflating the two caused a live regression on
`sessions/gap-over-promo.json` (the model started firing `checkout_bounce`
instead of `delivery_gap`, then — after a prompt-wording pass that still
used "bounce" for both concepts — started skipping `delivery_gap`
ENTIRELY, reasoning "no checkout-bounce friction" because
`patterns.checkoutBounce` was correctly `false` for a checkout→cart shape,
not realizing the existing priority rule is unconditional and separate).
Fixed by (1) excluding a bounce back to `/cart` specifically from
`checkoutBounce`'s definition (`state.js`) — `checkoutBounce` is now ONLY
true for a walk-away to somewhere that is neither checkout nor cart (login
wall, home, shop, a product) — and (2) rewording `decide.md`'s priority
rules to explicitly state the two are independent, differently-scoped
rules. Verified with a direct `buildState()` unit check (both shapes) plus
3 live re-runs of `gap-over-promo` after the fix, all 3 correctly chose
`delivery_gap` over `missed_discount` again.

**Route classification (per-site) — separate defect class, folded into this
pass per a mid-task scope addition.** A NextCart live pass found `product`
resolution failing entirely: NextCart's product route is `/p/<slug>`
(default store `/product/<slug>`, Acme `/products/<slug>`) — a third
hardcoded regex shape the old `productSlugFromPage()` never covered, which
cascaded into `distinctProducts`/`returnsToSameProduct` stuck at 0 and
`checkoutReached` false despite real `/checkout/address` visits (NextCart's
checkout is a sub-route, not the bare `/checkout` literal the old
`=== "/checkout"` comparisons required). Fixed with a per-site
`routes: {product, cart, checkout, search}` config
(`store/index.js`'s `DEFAULT_ROUTES`/`getRoutes()`, each a prefix list
checked with `path.startsWith()` so `/checkout/address` matches a
`/checkout` prefix) — a site's own `policies.json` may override any key;
anything it omits falls back to `DEFAULT_ROUTES` for that key alone (covers
the union of all three known sites). `classifyPath(path, store)` is the new
single source of truth `state.js`'s `buildJourney()`/`buildPatterns()`
(`cartVisits`, `checkoutReached`, `cartVisitedThenLeft`, `returnedAfterCart`,
`checkoutStall`, `checkoutBounce`) all read through instead of a bare
`=== "/cart"`/`=== "/checkout"` literal; `productSlugFromPage(page, store)`
same idiom for the product-slug regex. `stale.js`'s `liveProduct()`/
`computeContextFingerprint()` updated to pass `store` through too (same
defect class, would have silently mis-validated a `pick_size` cta on
NextCart otherwise). Added `routes` blocks to all three sites'
`policies.json` for documentation (functionally already covered by
`DEFAULT_ROUTES`, since it's the union of all three). **Out of scope, left
as-is**: `gate.js` has its OWN separate hardcoded copies of this exact
classification (`=== "/cart"`, `=== "/checkout"`, `startsWith("/product/")`)
— `state.js`'s own module comment already documents gate.js as owned by
another workstream; flagging here as a known duplicate for whoever picks
that file up next.

**search_help candidate-count CTA + grammar (NextCart session
`final_nc_1219732343`).** Live: a `search_help` card with 3 real candidates
correctly fired (`cta.kind: "search"`, value the top candidate's full
name), but the shopper tapping it re-ran NextCart's OWN search with that
full product name as the literal query and got **31 results** — a
long/generic-word-laden name is a bad query against this store's fuzzy
matcher, not a narrow one. Also a grammar bug: the card's body read "Found
3 match for Pulsegear...". Fixed: (1) `prompts/decide.md`'s "Failed search"
recipe is now candidate-count aware — exactly 1 candidate →
`cta.kind: "open_product"` with the real slug (deep-link, skip the search
round-trip entirely); 2-3 candidates → `cta.kind: "search"` (unchanged,
still the right call when genuinely ambiguous). `search_help`'s
`cta.kind` list is now `["open_product", "search"]`. (2) `templates.js`'s
`fill()` gained a generic `{name|singular|plural}` placeholder form (picks
one of two literal words by whether `Number(resolved[name]) === 1` — never
free interpolation, still a fixed merchant-authored skeleton) — used in
`search_help`'s body: `"Found {count} {count|match|matches} for {name}."`.
This also flips `sessions/zero-result-search.json`'s expected `cta.kind`
(unchanged `target`) — see that fixture's updated description — since its
query now resolves to exactly 1 real candidate. New fixture
`sessions/search-open-product.json` exercises the 1-candidate→open_product
branch on the default store (`"mojari sandles"` → exactly one fuzzy match,
verified via `searchCandidates()` directly). `templates.test.js` (x)/(xi)
and `probe-policy.test.js` (xxxv)-(xxxvii) cover the pluralization and
anchor-fallback mechanics respectively; `store.test.js` (xx) covers the new
route classification.

**Fixtures.**
- `server/sessions/acme-journey.json` (new) — condensed from
  `server/sessions/samples/final_tm_242431.json` (the real dump, saved
  verbatim via `curl localhost:4000/sessions/final_tm_242431`). Live
  (2026-09-12, `AGENT_MODE=llm LLM_BACKEND=claude LLM_MODEL=sonnet
  LLM_CACHE=0 AGENT_SENSITIVITY=demo`, port 4810, never 3000/4000/3800/
  3801/8081): **2/2 PASS** — the model correctly treats the open,
  under-threshold cart as a moment to act on WHILE BROWSING (no separate
  hesitation signal required), firing `card cart_under_threshold
  shipping-banner` (its own real `target_hint`, legitimately visible on
  this store's product pages — no anchor rewrite needed for this specific
  case; see `nextcart-search-fix.json` for a fixture that DOES exercise the
  rewrite). **Open item, reported honestly**: across 3 live attempts this
  fixture's compressed ~2-minute replay window only ever produced 2 actual
  LLM calls (real CLI backend latency ~11-20s/call + decision coalescing,
  max 1 in-flight + 1 pending per session, vs. the 9 calls the real
  4-minute session got) and never independently fired `checkout_bounce`
  within that budget — by the time the 2nd call resolves, the shopper has
  moved 2-3 pages past the bounce and the model judges the fresher
  `cart_under_threshold` signal as more actionable. Directly verified
  `patterns.checkoutBounce` itself computes correctly to `true` at the
  right instant via a standalone `buildState()` script (not just inferred
  from a live call) — this is a live-latency/prompt-salience tuning gap,
  not a code defect. `decide.md` now explicitly tells the model to check
  `patterns.checkoutBounce` by name first; a lower-latency backend (API key
  instead of CLI shell-out) would very likely close this (see git history for prior notes)
  by letting more real calls land in the same wall-clock window.
- `server/sessions/nextcart-search-fix.json` (new) — condensed from
  `server/sessions/samples/final_nc_1219732343.json`, a POSITIVE case (the
  coordinator's own instruction — the model DID fire a correct card here
  live, at ~200s). Live: **2/2 PASS**, `card search_help` anchored to
  `cart-link` (NextCart's real search box id is `search-input`, not
  `search` — the offer's hardcoded `target_hint` of `"search"` is never
  actually a real NextCart target; the anchor-fallback fix makes this
  deterministic instead of relying on the live model's own lucky pick of a
  lookalike visible id, which is what actually happened in the ORIGINAL
  live session and was never policy-validated against `target_hint` at
  all).
- `server/sessions/search-open-product.json` (new) — synthetic, default
  store, exercises the 1-candidate→`open_product` branch. Live: **1/1
  PASS**, `card search_help open_product leather-mojari-sandals`.
- `server/sessions/gap-over-promo.json` (existing) — `expect` relaxed from
  `{action:"card",target:"shipping-banner"}` to `{action:"card"}` (see the
  checkoutBounce-regression note above for why `target` alone is no longer
  a reliable proxy once anchor-fallback exists: a decide() call that
  resolves while still on `/checkout`, whose own target list in this
  fixture never lists `shipping-banner`, now correctly anchors to
  `cart-link` instead of failing closed — both are correct outcomes of the
  same priority decision). Live (2026-09-12, same run params): **5/5
  PASS** across the debugging+verification passes, always choosing
  `delivery_gap` over `missed_discount`.
- 4 pre-existing live fixtures re-verified for regression, 2 runs each:
  `sizing-hesitation` 2/2 PASS, `cart-threshold` 2/2 PASS,
  `zero-result-search` 2/2 PASS, `gap-over-promo` — see above (multiple
  runs during the checkoutBounce-regression fix+re-verify cycle, final
  state 3/3 PASS post-fix).

Files touched: `server/prompts/decide.md`, `server/prompts/templates.json`,
`server/templates.js`, `server/policy.js`, `server/state.js`,
`server/store/index.js`, `server/stale.js` (narrow, 2-line: pass `store`
through to `productSlugFromPage()`, same defect class), `server/store/
policies.json`, `server/store/acme/policies.json`, `server/store/
nextcart/policies.json` (new `routes` blocks), `server/templates.test.js`,
`server/probe-policy.test.js`, `server/state.test.js`, `server/store.test.js`,
`server/sessions/acme-journey.json` (new),
`server/sessions/nextcart-search-fix.json` (new),
`server/sessions/search-open-product.json` (new),
`server/sessions/gap-over-promo.json`,
`server/sessions/zero-result-search.json` (description only),
`server/sessions/samples/final_tm_242431.json` (new, raw dump),
`server/sessions/samples/final_nc_1219732343.json` (new, raw dump),
**Not browser-verified** — ready for browser
verification, needs a server image rebuild first (this pass only ran
against a bare `node index.js` on port 4810, never Docker/3000/4000/3800/
3801/8081).
