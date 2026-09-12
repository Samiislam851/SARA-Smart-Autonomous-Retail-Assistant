.PHONY: help setup dev dev-llm check test test-llm cost load docker-up docker-down tunnel logs import-store import-nextcart

help: ## Show this help
	@echo "SARA — Smart Autonomous Retail Assistant — available targets:"
	@grep -E '^[a-zA-Z_-]+:.*## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

setup: ## Install deps + seed .env files (idempotent, run this first)
	scripts/setup.sh

dev: ## Run agent (stub decider) + demo-store together, foreground
	scripts/dev.sh --stub

dev-llm: ## Run agent (real LLM decider) + demo-store together, foreground
	scripts/dev.sh --llm $${LLM_BACKEND:-claude}

check: ## Syntax + policy probe + fixture replay + route checks + demo-store typecheck
	scripts/check.sh

test: ## Run agent's fixture test suite (npm test)
	cd agent && npm test

test-llm: ## Instructions for two-terminal LLM-mode fixture replay
	@echo "Terminal 1: cd agent && AGENT_MODE=llm npm run dev"
	@echo "Terminal 2: cd agent && node replay.js sessions/*.json --speed 10"

cost: ## Compare LLM backend costs (agent/cost-compare.js)
	cd agent && npm run cost

load: ## Run the load test against a running agent (agent/load-test.js)
	cd agent && npm run load

import-store: ## Import a merchant's live storefront API into agent/store/$(SITE) (usage: make import-store SITE=acme API=http://localhost:8081)
	@if [ -z "$(SITE)" ] || [ -z "$(API)" ]; then echo "Usage: make import-store SITE=<name> API=<http://host:port> [OUT=<dir>]"; exit 1; fi
	node agent/scripts/import-store.mjs --site $(SITE) --api $(API) $(if $(OUT),--out $(OUT),)

import-nextcart: ## Import NextCart's catalog from its MongoDB into agent/store/nextcart (usage: make import-nextcart [URI=mongodb://...] [DB=nextcart] [OUT=<dir>])
	node agent/scripts/import-nextcart.mjs $(if $(URI),--uri $(URI),) $(if $(DB),--db $(DB),) $(if $(OUT),--out $(OUT),)

docker-up: ## Build + start agent and demo-store via docker compose
	docker compose up --build -d agent demo-store

docker-down: ## Stop the docker compose stack
	docker compose down

tunnel: ## Bring up a public Cloudflare quick tunnel (see docs/OPS.md)
	scripts/tunnel-up.sh

logs: ## Tail docker compose logs
	docker compose logs -f
