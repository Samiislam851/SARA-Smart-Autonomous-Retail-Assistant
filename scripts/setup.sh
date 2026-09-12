#!/usr/bin/env bash
# One-time (idempotent) setup: checks toolchain, installs deps, seeds env files.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found. Install Node >=18: https://nodejs.org/en/download" >&2
  exit 1
fi

NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Node >=18 required, found $(node -v). Install a newer Node: https://nodejs.org/en/download" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm not found. It ships with Node.js: https://nodejs.org/en/download" >&2
  exit 1
fi

install_deps() {
  local dir="$1"
  echo "==> Installing deps in ${dir}..."
  if [[ -f "${dir}/package-lock.json" ]]; then
    (cd "${dir}" && npm ci)
  else
    (cd "${dir}" && npm i)
  fi
}

install_deps agent
install_deps demo-store

if [[ ! -f demo-store/.env.local ]]; then
  cp demo-store/.env.local.example demo-store/.env.local
  echo "==> Wrote demo-store/.env.local (from demo-store/.env.local.example)"
else
  echo "==> demo-store/.env.local already exists, leaving it alone"
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "==> Wrote .env (from .env.example)"
else
  echo "==> .env already exists, leaving it alone"
fi

# The `claude`/`codex` CLI backends (decide/backends/claude.js, codex.js) shell
# out to a locally-installed CLI that reads/writes ~/.claude.json for its own
# config/session bookkeeping. On a fresh machine that's never run `claude`
# interactively, that file doesn't exist yet — some CLI versions error rather
# than creating it themselves on first run under a non-interactive `-p` call
# (this is a headless dev-server setup, not an interactive terminal). An empty
# file is enough to unblock that; the CLI fills it in properly on its own
# first real interactive run.
if [[ ! -f "$HOME/.claude.json" ]]; then
  touch "$HOME/.claude.json"
  echo "==> Created empty ~/.claude.json (claude CLI backend expects it to exist)"
fi

echo
echo "==> Setup done. Next:"
echo "    make dev        # stub decider, no LLM/API key needed"
echo "    make dev-llm    # real LLM decider (needs a backend configured in .env)"
echo "    make check       # sanity check before pushing"
