// Real LLM decider. Backend selectable via LLM_BACKEND: "codex" (default,
// local codex CLI), "claude" (local `claude -p` headless CLI), "openai"
// (plain fetch to a chat-completions endpoint — OpenAI, OpenRouter, or a
// local Ollama server, selected via OPENAI_BASE_URL), "anthropic" (official
// @anthropic-ai/sdk), or "gemini" (official @google/genai SDK).
// decide(state, session) -> Promise<{ action, trace }>. Never throws — any
// failure resolves to a noop proposal with a diagnostic trace.why.
//
// This module keeps: prompt building, the fingerprint cache, the in-flight
// guard + concurrency queue, validateProposalShape, and metrics wiring. Each
// backend's actual call mechanics live in decide/backends/*.js (see
// server/NOTES.md "LLM decider" for the backends/ split rationale).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bucketCart, bucketDwell } from "../buckets.js";
import { ACTIONS } from "../contracts.js";
import * as metrics from "../metrics.js";
import { run as runCodex } from "./backends/codex.js";
import { run as runClaude } from "./backends/claude.js";
import { run as runOpenAI } from "./backends/openai.js";
import { run as runAnthropic } from "./backends/anthropic.js";
import { run as runGemini } from "./backends/gemini.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LLM_BACKEND = process.env.LLM_BACKEND || "codex";
const LLM_TIMEOUT_MS_ENV = Number(process.env.LLM_TIMEOUT_MS) || null;
const LLM_MAX_CONCURRENT = Number(process.env.LLM_MAX_CONCURRENT) || 2;
const LLM_CACHE_TTL_MS = Number(process.env.LLM_CACHE_TTL_MS) || 10 * 60_000;
const LLM_MODEL_ENV = process.env.LLM_MODEL || null;
// LLM_CACHE=0 disables the fingerprint cache entirely — used for the
// cache-off cost-comparison run. Default: enabled.
const LLM_CACHE_ENABLED = process.env.LLM_CACHE !== "0";

const PROMPTS_DIR = path.join(__dirname, "..", "prompts");
const SYSTEM_PROMPT = fs.readFileSync(path.join(PROMPTS_DIR, "decide.md"), "utf8");
const SCHEMA_SRC = path.join(PROMPTS_DIR, "schema.json");
const SCHEMA_JSON = JSON.parse(fs.readFileSync(SCHEMA_SRC, "utf8"));

// ---- backend registry -------------------------------------------------
// Each backend's default timeout and default model. LLM_TIMEOUT_MS/LLM_MODEL
// env vars, when set, override these for whichever backend is selected.
const BACKEND_DEFAULTS = {
  codex: { timeoutMs: 20_000, model: null },
  claude: { timeoutMs: 30_000, model: "haiku" },
  openai: { timeoutMs: 20_000, model: "gpt-4o-mini" },
  anthropic: { timeoutMs: 20_000, model: "claude-haiku-4-5" },
  gemini: { timeoutMs: 20_000, model: "gemini-2.5-flash-lite" },
};

const BACKEND_RUNNERS = {
  codex: (prompt, ctx) => runCodex(prompt, { ...ctx, schemaPath: SCHEMA_SRC }),
  claude: (prompt, ctx) => runClaude(prompt, ctx),
  openai: (prompt, ctx) => runOpenAI(prompt, ctx),
  anthropic: (prompt, ctx) => runAnthropic(prompt, ctx),
  gemini: (prompt, ctx) => runGemini(prompt, ctx),
};

const backendDefaults = BACKEND_DEFAULTS[LLM_BACKEND] || BACKEND_DEFAULTS.codex;
const LLM_TIMEOUT_MS = LLM_TIMEOUT_MS_ENV || backendDefaults.timeoutMs;
const LLM_MODEL = LLM_MODEL_ENV || backendDefaults.model;
const backendRun = BACKEND_RUNNERS[LLM_BACKEND] || BACKEND_RUNNERS.codex;

const NOOP_PROPOSAL = (why, confidence = 0) => ({
  action: { action: "noop", target: null, style: null, duration_ms: 0, message: null },
  trace: {
    ts: Date.now(),
    signals: [],
    hypothesis: "",
    decision: "noop",
    confidence,
    why,
  },
});

// ---- tiny concurrency queue -------------------------------------------------

let inFlight = 0;
const waiters = [];
/** session id -> true while a call for that session is in flight */
const sessionsInFlight = new Set();

function acquireSlot() {
  if (inFlight < LLM_MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot() {
  inFlight--;
  const next = waiters.shift();
  if (next) {
    inFlight++;
    next();
  }
}

/** clearSessionInflight(id) — drops a session's "decision in progress" flag.
 * Normally self-clearing (decide()'s finally always deletes it), but a dev
 * reset (DELETE /session/:id, index.js) calls this defensively so a retake
 * can never be wedged on a stale flag from a request that never resolved. */
export function clearSessionInflight(sessionId) {
  sessionsInFlight.delete(sessionId);
}

// ---- fingerprint cache -------------------------------------------------

const CACHE_MAX_ENTRIES = 500;
/** fingerprint -> { proposal, expiresAt } */
const cache = new Map();

// Cache key = sha256 of the EXACT prompt string sent to the model (system
// prompt + serialized state), not a hand-picked subset of state fields. See
// server/NOTES.md "Fingerprint cache" for the full rationale.
function fingerprintClass(state) {
  return `${state.page}|cart:${bucketCart(state.cart)}|dwell:${bucketDwell(state.dwell?.pageMs ?? 0)}`;
}

function buildUserMessage(state) {
  return `${JSON.stringify(state)}\nDecide.`;
}

function fingerprint(state) {
  const prompt = buildUserMessage(state);
  return createHash("sha256").update(`${SYSTEM_PROMPT}\n\n---\n\n${prompt}`).digest("hex");
}

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.proposal;
}

function cacheSet(key, proposal) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { proposal, expiresAt: Date.now() + LLM_CACHE_TTL_MS });
}

function logCacheStats(cls) {
  const { cacheHits, cacheMisses } = metrics.snapshot();
  const total = cacheHits + cacheMisses;
  if (total > 0 && total % 20 === 0) {
    console.log(
      `[llm] cache: ${cacheHits} hits / ${cacheMisses} misses (${total} total)${cls ? ` last-class=${cls}` : ""}`
    );
  }
}

metrics.setCacheEnabled(LLM_CACHE_ENABLED);

/** validateProposalShape(parsed) → null if valid, else a short reason string.
 * Mirrors prompts/schema.json's required fields/types/enums. Needed for the
 * openai "object" json mode, where the server does no schema enforcement of
 * its own; also run (cheaply) as defense-in-depth on every other path, since
 * a "successful" schema-enforced call is still untrusted input. */
export function validateProposalShape(parsed) {
  if (!parsed || typeof parsed !== "object") return "response is not an object";
  const { action, trace } = parsed;
  if (!action || typeof action !== "object") return "missing action";
  if (!trace || typeof trace !== "object") return "missing trace";
  // Sourced from server/contracts.js ACTIONS (single source of truth) rather
  // than a second hardcoded list here — a hardcoded duplicate is exactly how
  // "card" (or any future action) would silently fail shape validation while
  // still being schema-valid.
  if (!ACTIONS.includes(action.action)) return `action.action invalid: ${action.action}`;
  if (action.target !== null && typeof action.target !== "string") return "action.target invalid";
  if (![null, "pulse", "outline"].includes(action.style)) return "action.style invalid";
  if (action.duration_ms !== null && typeof action.duration_ms !== "number") return "action.duration_ms invalid";
  if (action.message !== null && typeof action.message !== "string") return "action.message invalid";
  if (action.action === "card") {
    const card = action.card;
    if (!card || typeof card !== "object") return "action.card required for a card action";
    // Two accepted card forms (server/templates.js/prompts/templates.json):
    // template+slots (preferred), or free title+body (back-compat). Shape
    // only here — which template id is real, which slots it requires, and
    // whether a slot value is grounded in store facts are all
    // server/policy.js's job (needs live state this module doesn't build).
    const hasTemplate = card.template !== null && card.template !== undefined;
    if (hasTemplate) {
      if (typeof card.template !== "string" || !card.template) return "action.card.template invalid";
      if (card.slots !== null && card.slots !== undefined && typeof card.slots !== "object") {
        return "action.card.slots invalid";
      }
    } else {
      if (typeof card.title !== "string" || !card.title) return "action.card.title invalid";
      if (typeof card.body !== "string" || !card.body) return "action.card.body invalid";
    }
    const cta = card.cta;
    if (!cta || typeof cta !== "object") return "action.card.cta required";
    const validCtaKinds = ["pick_size", "add_to_cart", "apply_code", "open_product", "search", "none"];
    if (!validCtaKinds.includes(cta.kind)) return `action.card.cta.kind invalid: ${cta.kind}`;
    if (typeof cta.label !== "string") return "action.card.cta.label invalid";
    if (cta.value !== null && typeof cta.value !== "string") return "action.card.cta.value invalid";
  } else if (action.card !== null && action.card !== undefined) {
    return "action.card must be null for a non-card action";
  }
  if (!Array.isArray(trace.signals) || !trace.signals.every((s) => typeof s === "string")) return "trace.signals invalid";
  if (typeof trace.hypothesis !== "string") return "trace.hypothesis invalid";
  if (typeof trace.decision !== "string") return "trace.decision invalid";
  if (typeof trace.confidence !== "number") return "trace.confidence invalid";
  if (typeof trace.why !== "string") return "trace.why invalid";
  return null;
}

// ---- main entry -------------------------------------------------

export async function decide(state, session) {
  const key = fingerprint(state);

  // Cache hit/miss counters only mean anything when the cache is actually
  // consulted for a real decision (see server/NOTES.md "Metrics counter
  // accuracy").
  if (LLM_CACHE_ENABLED) {
    const cached = cacheGet(key);
    if (cached) {
      metrics.inc("cacheHits");
      logCacheStats(fingerprintClass(state));
      return {
        action: { ...cached.action },
        trace: { ...cached.trace, ts: Date.now(), why: `(cached) ${cached.trace.why}` },
      };
    }
  }

  const sessionId = session?.id ?? "unknown";
  if (sessionsInFlight.has(sessionId)) {
    return NOOP_PROPOSAL("decision in progress", 0);
  }
  sessionsInFlight.add(sessionId);

  await acquireSlot();
  try {
    if (LLM_CACHE_ENABLED) {
      metrics.inc("cacheMisses");
      logCacheStats(fingerprintClass(state));
    }
    const prompt = buildUserMessage(state);
    let parsed, tokensIn, tokensOut, tokensTotalCodex;
    const t0 = Date.now();
    try {
      ({ parsed, tokensIn, tokensOut, tokensTotalCodex } = await backendRun(prompt, {
        systemPrompt: SYSTEM_PROMPT,
        schema: SCHEMA_JSON,
        model: LLM_MODEL,
        timeoutMs: LLM_TIMEOUT_MS,
      }));
    } catch (err) {
      metrics.inc("llmErrors");
      metrics.inc("llmMsTotal", Date.now() - t0);
      return NOOP_PROPOSAL(`llm error: ${String(err.message).slice(0, 150)}`, 0);
    }
    metrics.inc("llmMsTotal", Date.now() - t0);
    metrics.inc("tokensIn", tokensIn);
    metrics.inc("tokensOut", tokensOut);
    if (tokensTotalCodex) metrics.inc("tokensTotalCodex", tokensTotalCodex);

    const invalidReason = validateProposalShape(parsed);
    if (invalidReason) {
      // Shape-invalid output is an error case — llmCalls counts only
      // successful, usable calls; errors, including a bad shape, are
      // llmErrors only.
      metrics.inc("llmErrors");
      return NOOP_PROPOSAL(`llm error: ${invalidReason}`, 0);
    }

    // Only now is this call countable as a genuine successful llm call.
    metrics.inc("llmCalls");
    const proposal = { action: parsed.action, trace: parsed.trace };
    if (LLM_CACHE_ENABLED) cacheSet(key, proposal);
    return proposal;
  } finally {
    sessionsInFlight.delete(sessionId);
    releaseSlot();
  }
}
