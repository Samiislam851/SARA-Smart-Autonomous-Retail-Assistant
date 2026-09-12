# Ops — deploy, demo, tunnels

## Local run

```
cp .env.example .env   # adjust AGENT_MODE / CODEX_HOME if needed
docker compose up --build
```

- Agent: http://localhost:4000
- Demo store: http://localhost:3000

`docker compose down` to stop.

## Public URL via Cloudflare quick tunnel

```
scripts/tunnel-up.sh
```

Starts `agent`, two `cloudflared` quick tunnels (profile `tunnel`), waits
for both `*.trycloudflare.com` URLs to appear in their logs, then rebuilds
and starts `demo-store` with those URLs baked in as
`NEXT_PUBLIC_AGENT_HTTP` / `NEXT_PUBLIC_AGENT_WS`, and prints the public
demo-store URL.

**Why two tunnels:** a Cloudflare quick tunnel gives exactly one random
public URL for whatever single origin it points at. The browser needs to
reach *two* origins — the demo store itself, and the agent (for
`POST /event` and the WebSocket) — so one tunnel alone isn't enough. This
repo runs a second tunnel pointed at `agent` and rebuilds `demo-store` with
that tunnel's URL baked in at build time. Downside: `demo-store` must be
rebuilt whenever the tunnel URLs change (they're random per run).

To bring tunnels down: `docker compose --profile tunnel down`.

## Codex / Claude CLI auth mounts

`AGENT_MODE=llm` can shell out to the `codex` or `claude` CLI inside the
agent container. `docker-compose.yml` mounts `${CODEX_HOME:-~/.codex}` and
`${CLAUDE_HOME:-~/.claude}` (host) read-write into the container — both
CLIs refresh auth tokens on disk, so a read-only mount would silently break
re-auth after the first token expiry.

**Host uid requirement:** the container runs as the `node` user baked into
`node:20-slim` (uid/gid 1000). If your host uid isn't 1000 (`id -u`),
either `sudo chown -R 1000:1000 ~/.codex ~/.claude`, or run compose with
`UID=$(id -u) GID=$(id -g) docker compose up` after uncommenting the
`user:` line on the `agent` service.

If `~/.claude.json` doesn't exist on your host, the bind mount fails —
create an empty one first (`touch ~/.claude.json`) or run `claude` once
interactively to generate a real one.

**Security note:** this mounts your real, live CLI credentials into the
container. Treat the container the same as your host shell for trust
purposes — credentials are never baked into the image, only mounted at
`docker compose up` time.

## Switching AGENT_MODE / LLM_BACKEND

Set `AGENT_MODE` in `.env` (or inline: `AGENT_MODE=llm docker compose up
agent`). Valid values per `agent/decide/index.js`: `stub` (default,
hardcoded demo policy), `llm` (real decider), `cached` (replays a
pre-recorded decision trace — the on-camera demo fallback).

For `AGENT_MODE=llm`, `LLM_BACKEND` selects the decider backend: `codex`
(local CLI), `claude` (local CLI), `openai` (API key only — also covers
OpenRouter or a local Ollama server via `OPENAI_BASE_URL`), `anthropic`
(`ANTHROPIC_API_KEY`), `gemini` (`GEMINI_API_KEY`/`GOOGLE_API_KEY`). See
`agent/NOTES.md`'s backend table for per-backend latency/auth notes.

Note: `docker compose up -d agent` does NOT recreate the container when
only shell env vars changed — use `--force-recreate` (or
`scripts/tunnel-up.sh`, which rebuilds) whenever `AGENT_MODE`/`LLM_BACKEND`
change.

## Demo — scripted replay (fallback for a live demo)

Pins a browser tab to a recorded session id, then drives the agent with
`replay.js` for that same id — the page's WebSocket shows the recorded
pulse/message/trace live, on the same session number every take.

| # | fixture | pinned URL |
|---|---------|------------|
| 1 | sizing hesitation | `<demo-store>/product/khadi-field-jacket?agent_session=fx_sizing_hesitation` |
| 2 | cart threshold | `<demo-store>/cart?agent_session=fx_cart_threshold` |
| 3 | happy browsing | `<demo-store>/product/khadi-field-jacket?agent_session=fx_happy_browsing` |
| 4 | facts threshold | `<demo-store>/cart?agent_session=fx_facts_threshold` |

```
AGENT_MODE=cached AGENT_DEBUG=1 node agent/index.js   # or the docker/tunnel stack
scripts/demo.sh sizing --base <public-agent-url> --web <public-demo-store-url>
scripts/demo.sh cart   --base <public-agent-url> --web <public-demo-store-url>
scripts/demo.sh happy  --base <public-agent-url> --web <public-demo-store-url>
# or all three in order, paused between:
scripts/demo.sh --all --base <public-agent-url> --web <public-demo-store-url>
```

`--base` and `--web` must be a matching pair — the widget's agent URL is
baked in at build time (`NEXT_PUBLIC_AGENT_HTTP`/`_WS`). `--yes` skips the
Enter prompts (non-interactive verification). `AGENT_DEBUG=1` enables
`DELETE /session/:id`, which `demo.sh` uses before every run so a retake
doesn't inherit the previous take's cooldown/never-same-target memory;
without it, a retake may get denied or altered by policy's guards. Reset
only, no replay: `scripts/demo.sh --reset-only sizing --base <url>`.

## Demo — no-terminal, in-page player

A judge or presenter can run the whole demo from inside the page — no
terminal. Same fixtures/recordings as above, driven by two endpoints (see
`agent/OPS.md`'s endpoint table for the full contract):

- `GET /demo/fixtures` — lists fixtures with a verified recording. Always
  registered; returns `200 []` unless the agent has both `AGENT_DEBUG=1`
  and `AGENT_MODE=cached`.
- `POST /demo/play/:fixture` — replays one at fixture timing / `?speed=`
  through the normal event path, resetting that fixture's session first.
  Only registered when `AGENT_DEBUG=1`; needs `AGENT_MODE=cached` to
  actually play (`409` otherwise).

Start the agent with both on: `AGENT_MODE=cached AGENT_DEBUG=1 node
agent/index.js`. Open the demo store on any page — the trace panel shows a
"Demo" row with one button per fixture. Shareable direct links (no
clicking through), landing on the fixture's own recorded page:

```
<demo-store>/product/khadi-field-jacket?agent_session=fx_sizing_hesitation&agent_demo=sizing-hesitation
<demo-store>/cart?agent_session=fx_cart_threshold&agent_demo=cart-threshold
<demo-store>/product/khadi-field-jacket?agent_session=fx_happy_browsing&agent_demo=happy-browsing
<demo-store>/cart?agent_session=fx_facts_threshold&agent_demo=facts-threshold
```

The same mechanism works through an `agent.js` embed on any other site
(`data-panel="true"`); an embed has no route of its own to navigate to, so
it re-pins the current page instead of jumping to the fixture's page.

## Re-recording fixtures after a prompt change

```
AGENT_MODE=llm LLM_BACKEND=<backend> AGENT_RECORD=1 node agent/index.js
REPLAY_FIXED_SESSION=1 node agent/replay.js agent/sessions/sizing-hesitation.json
REPLAY_FIXED_SESSION=1 node agent/replay.js agent/sessions/cart-threshold.json
REPLAY_FIXED_SESSION=1 node agent/replay.js agent/sessions/happy-browsing.json
```

Overwrites `agent/sessions/recorded/<fixture-session-id>.json` with a fresh
pre-policy decision trace per event. Switch back to `AGENT_MODE=cached` (no
`AGENT_RECORD`) for the actual demo.

## Fallback if a tunnel dies

Re-run against the local dev stack instead: `--base http://localhost:4000
--web http://localhost:3000` with `scripts/dev.sh --cached` — same
fixtures, same session ids, no camera-visible difference.

## Endpoints

See `agent/OPS.md` for the full endpoint table (`/health`, `/health/agent`,
`/ready`, `/metrics`, `/logs/recent`, `/session/:id`, `/state/:id`,
`/demo/fixtures`, `/demo/play/:fixture`) and `agent/POLICY.md` for every
merchant policy knob.
