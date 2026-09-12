// Merchant-facing policy knobs — env-driven, validated once at import, and
// consumed by policy.js (the last line of defense) as the source of truth
// for every guard constant that used to be hardcoded there.
//
// loadPolicyConfig(env) is pure (given an env object) so tests can build
// scoped configs without touching process.env. The module also loads a
// singleton (`policyConfig`) from process.env at import time — that's what
// the running server actually uses.

import { ACTIONS } from "./contracts.js";

// Fixed contract floor (CLAUDE.md's ground rule 3: "max one intervention per
// 30s per session") — AGENT_COOLDOWN_MS may only TIGHTEN this, never loosen
// it, so its accepted range's minimum is 30s, not 0.
const MIN_COOLDOWN_MS = 30_000;

const DEFAULTS = Object.freeze({
  cooldownMs: MIN_COOLDOWN_MS,
  maxNudgesPerSession: 3,
  allowedActions: ACTIONS.slice(),
  denyTargets: [],
  maxMessageChars: 140,
  minConfidence: 0,
  sensitivity: "normal",
});

// AGENT_SENSITIVITY — gate.js/tick.js knob, not a policy.js guard: how
// readily the pre-model layer (gate.js's eight-plus signals, tick.js's
// decision trigger) asks the model for a decision. "normal" is the tuned
// default for a real shopper session (see server/NOTES.md, me_1 numbers);
// "demo" multiplies every gate.js dwell/window threshold by
// SENSITIVITY_MULTIPLIERS.demo (0.6 — fire sooner) and shrinks the
// buckets.js attention-bucket boundaries tick.js uses for its dwell-bucket
// trigger by the same factor, so a live demo doesn't require sitting through
// the full normal thresholds to see an intervention. Enum knob (like
// AGENT_ALLOWED_ACTIONS) — an invalid value falls back to the default
// ("normal"), not the more permissive one, since "normal" is already the
// least aggressive setting.
export const SENSITIVITY_MULTIPLIERS = Object.freeze({ normal: 1, demo: 0.6 });

function parseSensitivity(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "normal" || v === "demo") return v;
  warn("AGENT_SENSITIVITY", raw, 'must be "normal" or "demo"', fallback);
  return fallback;
}

function warn(varName, raw, reason, fallback) {
  console.warn(`[policy-config] ${varName}=${JSON.stringify(raw)} ${reason} — using default (${fallback})`);
}

function parseIntEnv(varName, raw, { min, max, fallback }) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    warn(varName, raw, "is not an integer", fallback);
    return fallback;
  }
  if (n < min || (max != null && n > max)) {
    warn(varName, raw, `is out of range [${min}, ${max}]`, fallback);
    return fallback;
  }
  return n;
}

function parseFloatEnv(varName, raw, { min, max, fallback }) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    warn(varName, raw, "is not a number", fallback);
    return fallback;
  }
  if (n < min || n > max) {
    warn(varName, raw, `is out of range [${min}, ${max}]`, fallback);
    return fallback;
  }
  return n;
}

function parseListEnv(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Fail-closed, not fail-open: an enum/list knob whose value parses to no
// valid entries falls back to the MOST RESTRICTIVE value ("noop" only), not
// the permissive default (all actions). A merchant who set this var clearly
// meant to restrict the agent — silently re-enabling every action on a typo
// would be the opposite of what they configured, and worse, invisible.
const FAIL_CLOSED_ACTIONS = Object.freeze(["noop"]);

function parseAllowedActions(varName, raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback.slice();
  const requested = parseListEnv(raw);
  if (requested.length === 0) {
    // Non-empty raw value but no usable tokens (e.g. just commas/whitespace)
    // — treat the same as "every requested action was invalid" below.
    warn(varName, raw, "resolved to no valid actions", `noop-only (fail-closed)`);
    return FAIL_CLOSED_ACTIONS.slice();
  }
  const valid = [];
  const invalid = [];
  for (const item of requested) {
    if (ACTIONS.includes(item)) valid.push(item);
    else invalid.push(item);
  }
  if (invalid.length > 0) {
    console.warn(
      `[policy-config] ${varName} contains unknown action(s) ${JSON.stringify(invalid)} — dropped (valid: ${ACTIONS.join(", ")})`
    );
  }
  if (valid.length === 0) {
    // Every requested action was invalid — fail closed to noop-only rather
    // than falling back to the permissive default.
    warn(varName, raw, "resolved to no valid actions", `noop-only (fail-closed)`);
    return FAIL_CLOSED_ACTIONS.slice();
  }
  // "noop" is always allowed regardless of merchant config.
  if (!valid.includes("noop")) valid.push("noop");
  return valid;
}

/**
 * loadPolicyConfig(env = process.env) → frozen config object:
 * { cooldownMs, maxNudgesPerSession, allowedActions: string[],
 *   denyTargets: string[], maxMessageChars, minConfidence }
 * All fields optional in `env`; invalid/out-of-range values fall back to
 * the documented default with a console.warn (see server/POLICY.md).
 */
export function loadPolicyConfig(env = process.env) {
  const cooldownMs = parseIntEnv("AGENT_COOLDOWN_MS", env.AGENT_COOLDOWN_MS, {
    min: MIN_COOLDOWN_MS,
    max: 600_000,
    fallback: DEFAULTS.cooldownMs,
  });

  // -1 = unlimited nudges, 0 = zero nudges (agent stays silent all session),
  // >=1 = that many. Numeric-but-invalid input (non-integer, out of range)
  // falls back to the default (3) — a plain number knob, not an enum, so a
  // typo falling back to a middle-ground default rather than the most
  // restrictive value (0) is acceptable here (see policy-config audit note
  // in POLICY.md / the fail-closed guard on AGENT_ALLOWED_ACTIONS above,
  // which IS an enum knob).
  const maxNudgesPerSession = parseIntEnv("AGENT_MAX_NUDGES_PER_SESSION", env.AGENT_MAX_NUDGES_PER_SESSION, {
    min: -1,
    max: Number.MAX_SAFE_INTEGER,
    fallback: DEFAULTS.maxNudgesPerSession,
  });

  const allowedActions = parseAllowedActions("AGENT_ALLOWED_ACTIONS", env.AGENT_ALLOWED_ACTIONS, DEFAULTS.allowedActions);

  const denyTargets = env.AGENT_DENY_TARGETS !== undefined ? parseListEnv(env.AGENT_DENY_TARGETS) : DEFAULTS.denyTargets.slice();

  const maxMessageChars = parseIntEnv("AGENT_MAX_MESSAGE_CHARS", env.AGENT_MAX_MESSAGE_CHARS, {
    min: 1,
    max: 140,
    fallback: DEFAULTS.maxMessageChars,
  });

  const minConfidence = parseFloatEnv("AGENT_MIN_CONFIDENCE", env.AGENT_MIN_CONFIDENCE, {
    min: 0,
    max: 1,
    fallback: DEFAULTS.minConfidence,
  });

  const sensitivity = parseSensitivity(env.AGENT_SENSITIVITY, DEFAULTS.sensitivity);

  return Object.freeze({
    cooldownMs,
    maxNudgesPerSession,
    allowedActions: Object.freeze(allowedActions),
    denyTargets: Object.freeze(denyTargets),
    maxMessageChars,
    minConfidence,
    sensitivity,
  });
}

/** Module-level singleton, loaded once at import from process.env. */
export const policyConfig = loadPolicyConfig();

/**
 * describePolicyConfig(config = policyConfig) → plain JSON-serializable
 * object, for observability (e.g. GET /health). Arrays, not frozen/Set —
 * safe to JSON.stringify or spread as-is.
 */
export function describePolicyConfig(config = policyConfig) {
  return {
    cooldownMs: config.cooldownMs,
    maxNudgesPerSession: config.maxNudgesPerSession,
    allowedActions: [...config.allowedActions],
    denyTargets: [...config.denyTargets],
    maxMessageChars: config.maxMessageChars,
    minConfidence: config.minConfidence,
    sensitivity: config.sensitivity,
  };
}

/**
 * getSensitivityMultiplier(config = policyConfig) → 1 (normal) or 0.6 (demo).
 * Consumed by gate.js (scales every dwell/window threshold constant) and
 * tick.js/buckets.js (scales the attention-bucket boundaries the dwell
 * trigger uses) so a "demo" session fires the same signals sooner without
 * duplicating the enum→number mapping in either module.
 */
export function getSensitivityMultiplier(config = policyConfig) {
  return SENSITIVITY_MULTIPLIERS[config.sensitivity] ?? 1;
}

// AGENT_CONSULT_FLOOR_MS — gate.js's consult-floor knob (server/NOTES.md,
// "model only consulted on signal edges, no floor" defect found live
// 2026-09-12 on session you_2: 47 events/31 decisions/0 model calls, every
// decision skipped because ordinary first-minute browsing trips none of the
// twelve friction signals). Not a policy.js guard — same category as
// AGENT_SENSITIVITY above: how readily the pre-model layer asks the model
// for a decision, this time on a floor/timeout basis rather than a
// signal-edge basis. Sensitivity-aware default (not multiplied by
// SENSITIVITY_MULTIPLIERS like gate.js's ms constants — the two demo/normal
// values aren't a clean 0.6x of each other: 20000 vs 30000) so a "demo"
// session's floor fires sooner without a merchant having to also set this
// var by hand. AGENT_CONSULT_FLOOR_MS, if set, overrides the sensitivity
// default outright.
const CONSULT_FLOOR_DEFAULTS = Object.freeze({ normal: 30_000, demo: 20_000 });

/**
 * getConsultFloorMs(config = policyConfig) → ms. AGENT_CONSULT_FLOOR_MS env
 * override (validated once here, same parseIntEnv as every other numeric
 * knob — invalid/out-of-range falls back to the sensitivity default with a
 * console.warn) takes precedence over the normal/demo default derived from
 * config.sensitivity.
 */
export function getConsultFloorMs(config = policyConfig) {
  const fallback = CONSULT_FLOOR_DEFAULTS[config.sensitivity] ?? CONSULT_FLOOR_DEFAULTS.normal;
  return parseIntEnv("AGENT_CONSULT_FLOOR_MS", process.env.AGENT_CONSULT_FLOOR_MS, {
    min: 1_000,
    max: 600_000,
    fallback,
  });
}
