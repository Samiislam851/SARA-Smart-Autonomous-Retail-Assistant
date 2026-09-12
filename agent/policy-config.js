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
// 30s per session") for a NORMAL session — AGENT_COOLDOWN_MS may only
// TIGHTEN this, never loosen it. "demo" sensitivity gets its own, looser
// floor (2026-09-12 "trigger pops a little more frequently" brief,
// explicit owner request + .env's AGENT_COOLDOWN_MS=15000 under
// AGENT_SENSITIVITY=demo) — a live demo audience deliberately trades the
// real-shopper-fatigue floor for more visible cards across pages; this is a
// documented, sensitivity-scoped exception to ground rule 3, not a general
// loosening (a "normal" session keeps the full 30s floor, unchanged).
const MIN_COOLDOWN_MS_BY_SENSITIVITY = Object.freeze({ normal: 30_000, demo: 15_000 });
const MIN_COOLDOWN_MS = MIN_COOLDOWN_MS_BY_SENSITIVITY.normal;
// Matching sensitivity-aware DEFAULT (was a flat MIN_COOLDOWN_MS for both) —
// same shape as MAX_NUDGES_DEFAULTS/CONSULT_FLOOR_DEFAULTS below.
const COOLDOWN_DEFAULTS = Object.freeze({ normal: 30_000, demo: 15_000 });

const DEFAULTS = Object.freeze({
  cooldownMs: MIN_COOLDOWN_MS,
  maxNudgesPerSession: 3,
  allowedActions: ACTIONS.slice(),
  denyTargets: [],
  maxMessageChars: 140,
  minConfidence: 0,
  sensitivity: "normal",
});

// Frequency & fatigue knobs (docs/BEHAVIOR-MATRIX.md "Frequency & fatigue" +
// server brief 2026-09-12). Sensitivity-aware defaults follow the same
// pattern as CONSULT_FLOOR_DEFAULTS below: a "demo" session gets a looser
// (not identical-ratio) default so a live demo can show several cards
// across pages without sitting through the full normal-session budget.
//
// AGENT_MAX_NUDGES_PER_SESSION's own default now depends on sensitivity too
// (was a flat 3) — raised per owner request ("several meaningful cards
// across pages"). maxNudgesPerSession keeps its existing -1=unlimited /
// 0=silent / N contract; only the fallback-when-unset value changed.
const MAX_NUDGES_DEFAULTS = Object.freeze({ normal: 4, demo: 6 });

// AGENT_MAX_CARDS_PER_PAGEVIEW: per-pageview cap on non-noop actions
// (docs/BEHAVIOR-MATRIX.md "Per-page cap: 1 card per page view"). Enforced
// in policy.js against session.actionsThisPageview (reset on every
// page_view, see state.js pushEvent()). -1 = unlimited.
const MAX_CARDS_PER_PAGEVIEW_DEFAULTS = Object.freeze({ normal: 1, demo: 2 });

// AGENT_MIN_GAP_MS: NOT a second timer — docs/BEHAVIOR-MATRIX.md is explicit
// ("reuse, don't add a second timer"). This is purely an observability
// alias for cooldownMs, exposed in describePolicyConfig()/GET /health under
// its own name because the brief calls it out as a distinct knob name. It
// is NOT sensitivity-scaled: cooldownMs's floor (MIN_COOLDOWN_MS, 30s) is a
// FIXED CONTRACT ceiling from CLAUDE.md ground rule 3 ("max one
// intervention per 30s per session") — AGENT_COOLDOWN_MS may only tighten
// it, never loosen it, in EITHER sensitivity mode. A "demo" default of
// 15000 (as this brief's knob table originally proposed) would violate that
// floor, so demo does not get a shorter min-gap than normal; see
// server/POLICY.md "Frequency" section for this explicit deviation.

// AGENT_SUPPRESS_AFTER_DISMISS: same card TEMPLATE not re-shown after the
// shopper dismissed it, for the rest of the session (docs/BEHAVIOR-MATRIX.md
// "Suppress-after-dismiss"). Boolean, default true in both sensitivities.
const DEFAULT_SUPPRESS_AFTER_DISMISS = true;

// AGENT_CARD_TTL_MS: widget-side auto-collapse-into-tray timer for a shown
// card (server/public/agent.js). Not a policy.js guard (nothing to enforce
// server-side beyond passing the number through) — sent to the widget via
// the action wire message (index.js's actionMessage(), card actions only)
// so the two ends can't drift out of sync on the number. Same 12s default
// in both sensitivities (a demo audience doesn't need shorter/longer
// per-card visibility, just more of them and no repeats).
const DEFAULT_CARD_TTL_MS = 12000;

function parseBoolEnv(varName, raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  warn(varName, raw, 'must be "true" or "false"', fallback);
  return fallback;
}

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
  // Parsed first — MAX_NUDGES_DEFAULTS/MAX_CARDS_PER_PAGEVIEW_DEFAULTS below
  // key off it, same as CONSULT_FLOOR_DEFAULTS already does further down.
  const sensitivity = parseSensitivity(env.AGENT_SENSITIVITY, DEFAULTS.sensitivity);

  const cooldownFloor = MIN_COOLDOWN_MS_BY_SENSITIVITY[sensitivity] ?? MIN_COOLDOWN_MS_BY_SENSITIVITY.normal;
  const cooldownMs = parseIntEnv("AGENT_COOLDOWN_MS", env.AGENT_COOLDOWN_MS, {
    min: cooldownFloor,
    max: 600_000,
    fallback: COOLDOWN_DEFAULTS[sensitivity] ?? COOLDOWN_DEFAULTS.normal,
  });

  // -1 = unlimited nudges, 0 = zero nudges (agent stays silent all session),
  // >=1 = that many. Numeric-but-invalid input (non-integer, out of range)
  // falls back to the sensitivity-aware default (4 normal / 6 demo) — a
  // plain number knob, not an enum, so a typo falling back to a
  // middle-ground default rather than the most restrictive value (0) is
  // acceptable here (see policy-config audit note in POLICY.md / the
  // fail-closed guard on AGENT_ALLOWED_ACTIONS above, which IS an enum
  // knob).
  const maxNudgesPerSession = parseIntEnv("AGENT_MAX_NUDGES_PER_SESSION", env.AGENT_MAX_NUDGES_PER_SESSION, {
    min: -1,
    max: Number.MAX_SAFE_INTEGER,
    fallback: MAX_NUDGES_DEFAULTS[sensitivity] ?? MAX_NUDGES_DEFAULTS.normal,
  });

  // -1 = unlimited cards per pageview. See MAX_CARDS_PER_PAGEVIEW_DEFAULTS
  // above; enforced in policy.js against session.actionsThisPageview.
  const maxCardsPerPageview = parseIntEnv("AGENT_MAX_CARDS_PER_PAGEVIEW", env.AGENT_MAX_CARDS_PER_PAGEVIEW, {
    min: -1,
    max: Number.MAX_SAFE_INTEGER,
    fallback: MAX_CARDS_PER_PAGEVIEW_DEFAULTS[sensitivity] ?? MAX_CARDS_PER_PAGEVIEW_DEFAULTS.normal,
  });

  const suppressAfterDismiss = parseBoolEnv(
    "AGENT_SUPPRESS_AFTER_DISMISS",
    env.AGENT_SUPPRESS_AFTER_DISMISS,
    DEFAULT_SUPPRESS_AFTER_DISMISS
  );

  const cardTtlMs = parseIntEnv("AGENT_CARD_TTL_MS", env.AGENT_CARD_TTL_MS, {
    min: 1000,
    max: 120_000,
    fallback: DEFAULT_CARD_TTL_MS,
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

  return Object.freeze({
    cooldownMs,
    maxNudgesPerSession,
    maxCardsPerPageview,
    suppressAfterDismiss,
    cardTtlMs,
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
    // minGapMs: observability alias for cooldownMs, not a second timer —
    // see the AGENT_MIN_GAP_MS comment above DEFAULT_CARD_TTL_MS.
    minGapMs: config.cooldownMs,
    maxNudgesPerSession: config.maxNudgesPerSession,
    maxCardsPerPageview: config.maxCardsPerPageview,
    suppressAfterDismiss: config.suppressAfterDismiss,
    cardTtlMs: config.cardTtlMs,
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
