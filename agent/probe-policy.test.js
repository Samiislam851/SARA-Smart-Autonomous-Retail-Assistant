// Direct probe of policy.js's untrusted-decider-output normalization + guards.
// Plain node asserts — run with `npm run test:policy` (node probe-policy.test.js).

import assert from "node:assert/strict";
import { applyPolicy } from "./policy.js";
import { loadPolicyConfig, describePolicyConfig } from "./policy-config.js";

function fakeSession(overrides = {}) {
  return {
    id: "probe_session",
    events: [],
    lastInterventionAt: 0,
    lastInterventionTarget: null,
    actedTargets: new Set(),
    lastDeciderAt: 0,
    lastTrace: null,
    nudgeCount: 0,
    ...overrides,
  };
}

function fakeState(visibleTargets = ["size-guide", "cart-add"]) {
  return { page: "/p", visibleTargets, cart: null, recent: [], dwell: { pageMs: 0, perTarget: {} }, lastIntervention: null };
}

// (i) Garbage/decider-controlled action object → normalized to exactly the
// contract's 6 keys, bad style dropped, duration clamped, no `kind` leaks in.
{
  const session = fakeSession();
  const state = fakeState();
  const proposed = {
    action: { kind: "trace", action: "highlight", target: "size-guide", js: "x", style: "evil", duration_ms: "9e9" },
    trace: { ts: Date.now(), signals: ["s"], hypothesis: "h", decision: "highlight size-guide", confidence: 0.9, why: "w" },
  };
  const { action } = applyPolicy(session, state, proposed);
  const keys = Object.keys(action).sort();
  assert.deepEqual(keys, ["action", "card", "duration_ms", "message", "style", "target"]);
  assert.equal(action.card, null, "card is null for a non-card action");
  assert.equal(action.style, null);
  assert.ok(action.duration_ms >= 0 && action.duration_ms <= 25000, "duration_ms clamped into range");
  assert.equal("kind" in action, false, "normalized action never carries kind");
  console.log("(i) ok — garbage action normalized:", action);
}

// (ii) Garbage trace ("boom") → normalized to the fixed six-field shape with
// an array `signals`.
{
  const session = fakeSession();
  const state = fakeState();
  const proposed = { action: { action: "noop" }, trace: "boom" };
  const { trace } = applyPolicy(session, state, proposed);
  assert.deepEqual(Object.keys(trace).sort(), ["confidence", "decision", "hypothesis", "signals", "ts", "why"].sort());
  assert.ok(Array.isArray(trace.signals), "signals is always an array");
  console.log("(ii) ok — garbage trace normalized:", trace);
}

// (iii) Casing must be exact — "HIGHLIGHT" is not "highlight" → denied to noop.
{
  const session = fakeSession();
  const state = fakeState();
  const proposed = {
    action: { action: "HIGHLIGHT", target: "size-guide" },
    trace: { decision: "HIGHLIGHT size-guide" },
  };
  const { action } = applyPolicy(session, state, proposed);
  assert.equal(action.action, "noop", "no casing tolerance on action type");
  console.log("(iii) ok — casing mismatch denied");
}

// (iv) message action with a target that isn't visible → denied.
{
  const session = fakeSession();
  const state = fakeState(["size-guide"]);
  const proposed = {
    action: { action: "message", target: "not-a-real-target", message: "hi there" },
    trace: { decision: "message" },
  };
  const { action } = applyPolicy(session, state, proposed);
  assert.equal(action.action, "noop", "message target must be visible");
  console.log("(iv) ok — message with invisible target denied");
}

// (v) message action with null target → allowed, actedTargets unchanged.
{
  const session = fakeSession();
  const state = fakeState(["size-guide"]);
  const proposed = {
    action: { action: "message", target: null, message: "free delivery is ৳50 away" },
    trace: { decision: "message" },
  };
  const { action } = applyPolicy(session, state, proposed);
  assert.equal(action.action, "message");
  assert.equal(session.actedTargets.size, 0, "null-target action must not populate actedTargets");
  console.log("(v) ok — message with null target allowed, actedTargets untouched");
}

// (vi) A denied proposal must not touch lastInterventionAt.
{
  const session = fakeSession({ lastInterventionAt: 0 });
  const state = fakeState(["size-guide"]);
  const proposed = {
    action: { action: "highlight", target: "not-visible" },
    trace: { decision: "highlight not-visible" },
  };
  const before = session.lastInterventionAt;
  const { action } = applyPolicy(session, state, proposed);
  assert.equal(action.action, "noop");
  assert.equal(session.lastInterventionAt, before, "denied proposal must not update lastInterventionAt");
  console.log("(vi) ok — denied proposal leaves lastInterventionAt untouched");
}

// --- merchant policy config (server/policy-config.js) -----------------

function actionProposal(overrides = {}) {
  return {
    action: { action: "highlight", target: "size-guide", ...overrides.action },
    trace: { decision: "highlight size-guide", confidence: 0.9, ...overrides.trace },
  };
}

// (vii) Default config behaviour unchanged: allowed action on a visible
// target goes through with no explicit config override.
{
  const session = fakeSession();
  const state = fakeState(["size-guide"]);
  const { action } = applyPolicy(session, state, actionProposal());
  assert.equal(action.action, "highlight", "default config still allows a normal highlight");
  assert.equal(session.nudgeCount, 1, "nudgeCount increments on an allowed non-noop action");
  console.log("(vii) ok — default config unchanged behaviour");
}

// (viii) AGENT_COOLDOWN_MS is tighten-only: the fixed contract floor (30s,
// CLAUDE.md ground rule "max one intervention per 30s per session") is the
// MINIMUM accepted value, not 0. 30000 (the floor) vs 120000 (tightened)
// both deny an immediate second action on a different target — the cooldown
// can never be loosed below 30s — and a request BELOW the floor falls back
// to the 30s default rather than being honoured.
{
  const config30 = loadPolicyConfig({ AGENT_COOLDOWN_MS: "30000" });
  const config120 = loadPolicyConfig({ AGENT_COOLDOWN_MS: "120000" });
  const state = fakeState(["size-guide", "cart-add"]);

  const s30 = fakeSession();
  const r1_30 = applyPolicy(s30, state, actionProposal({ action: { target: "size-guide" } }), { config: config30 });
  const r2_30 = applyPolicy(s30, state, actionProposal({ action: { target: "cart-add" } }), { config: config30 });
  assert.equal(r1_30.action.action, "highlight");
  assert.equal(r2_30.action.action, "noop", "30s floor still denies an immediate second action on a different target");
  assert.match(r2_30.trace.why, /cooldown active \(30s\)/);

  const s120 = fakeSession();
  const r1_120 = applyPolicy(s120, state, actionProposal({ action: { target: "size-guide" } }), { config: config120 });
  const r2_120 = applyPolicy(s120, state, actionProposal({ action: { target: "cart-add" } }), { config: config120 });
  assert.equal(r1_120.action.action, "highlight");
  assert.equal(r2_120.action.action, "noop");
  assert.match(r2_120.trace.why, /cooldown active \(120s\)/);

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  let belowFloor;
  try {
    belowFloor = loadPolicyConfig({ AGENT_COOLDOWN_MS: "10000" });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(belowFloor.cooldownMs, 30_000, "below the 30s floor falls back to the default (tighten-only, never loosens)");
  assert.ok(warnings.length > 0, "below-floor cooldown produces a console.warn");

  console.log("(viii) ok — AGENT_COOLDOWN_MS is tighten-only with a 30s floor");
}

// (ix) nudge budget: maxNudgesPerSession=1 denies the second non-noop
// action even to a different target, with the documented reason text.
{
  // skipCooldown isolates the nudge-budget guard from the (now tighten-only,
  // 30s-floor) cooldown guard — see (viii).
  const config = loadPolicyConfig({ AGENT_MAX_NUDGES_PER_SESSION: "1" });
  const session = fakeSession();
  const state = fakeState(["size-guide", "cart-add"]);
  const r1 = applyPolicy(session, state, actionProposal({ action: { target: "size-guide" } }), { config, skipCooldown: true });
  const r2 = applyPolicy(session, state, actionProposal({ action: { target: "cart-add" } }), { config, skipCooldown: true });
  assert.equal(r1.action.action, "highlight");
  assert.equal(r2.action.action, "noop");
  assert.match(r2.trace.why, /session nudge budget spent \(1\)/);
  console.log("(ix) ok — nudge budget denies the second action:", r2.trace.why);
}

// (x) nudge budget applies even under opts.skipCooldown (cached replay).
{
  const config = loadPolicyConfig({ AGENT_MAX_NUDGES_PER_SESSION: "1" });
  const session = fakeSession();
  const state = fakeState(["size-guide", "cart-add"]);
  const r1 = applyPolicy(session, state, actionProposal({ action: { target: "size-guide" } }), { config, skipCooldown: true });
  const r2 = applyPolicy(session, state, actionProposal({ action: { target: "cart-add" } }), { config, skipCooldown: true });
  assert.equal(r1.action.action, "highlight");
  assert.equal(r2.action.action, "noop", "nudge budget is NOT bypassed by skipCooldown");
  assert.match(r2.trace.why, /session nudge budget spent \(1\)/);
  console.log("(x) ok — nudge budget applies under skipCooldown");
}

// (xi) disabled action: merchant's AGENT_ALLOWED_ACTIONS excludes it.
{
  const config = loadPolicyConfig({ AGENT_ALLOWED_ACTIONS: "message,scroll_to" });
  const session = fakeSession();
  const state = fakeState(["size-guide"]);
  const { action, trace } = applyPolicy(session, state, actionProposal(), { config });
  assert.equal(action.action, "noop");
  assert.match(trace.why, /action "highlight" disabled by merchant/);
  console.log("(xi) ok — disabled action denied:", trace.why);
}

// (xii) denied target: merchant's AGENT_DENY_TARGETS blocks a specific id.
{
  const config = loadPolicyConfig({ AGENT_DENY_TARGETS: "checkout-button, size-guide" });
  const session = fakeSession();
  const state = fakeState(["size-guide"]);
  const { action, trace } = applyPolicy(session, state, actionProposal(), { config });
  assert.equal(action.action, "noop");
  assert.match(trace.why, /target "size-guide" denied by merchant/);
  console.log("(xii) ok — denied target denied:", trace.why);
}

// (xiii) min confidence: below floor denied, exactly at floor allowed.
{
  const config = loadPolicyConfig({ AGENT_MIN_CONFIDENCE: "0.6" });
  const state = fakeState(["size-guide"]);

  const below = fakeSession();
  const rBelow = applyPolicy(below, state, actionProposal({ trace: { confidence: 0.41 } }), { config });
  assert.equal(rBelow.action.action, "noop");
  assert.match(rBelow.trace.why, /confidence 0\.41 below merchant floor 0\.6/);

  const atFloor = fakeSession();
  const rAt = applyPolicy(atFloor, state, actionProposal({ trace: { confidence: 0.6 } }), { config });
  assert.equal(rAt.action.action, "highlight", "confidence exactly at the floor is allowed");
  console.log("(xiii) ok — min confidence denied below floor, allowed at floor:", rBelow.trace.why);
}

// (xiv) message cap lowered to 60: normalize CLAMPS to the cap (truncates),
// it does not deny the action — a 100-char message becomes a 60-char one.
{
  const config = loadPolicyConfig({ AGENT_MAX_MESSAGE_CHARS: "60" });
  const session = fakeSession();
  const state = fakeState(["size-guide"]);
  const longMessage = "x".repeat(100);
  const proposed = {
    action: { action: "message", target: "size-guide", message: longMessage },
    trace: { decision: "message", confidence: 0.9 },
  };
  const { action } = applyPolicy(session, state, proposed, { config });
  assert.equal(action.action, "message", "message action allowed, not denied, when over the lowered cap");
  assert.equal(action.message.length, 60, "message truncated to the configured cap");
  console.log("(xiv) ok — message clamped to lowered AGENT_MAX_MESSAGE_CHARS, not denied");
}

// (xv) invalid env values fall back to defaults, with a console.warn.
{
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  let config;
  try {
    config = loadPolicyConfig({
      AGENT_COOLDOWN_MS: "not-a-number",
      AGENT_MAX_NUDGES_PER_SESSION: "-5",
      AGENT_ALLOWED_ACTIONS: "spotlight,teleport",
      AGENT_MAX_MESSAGE_CHARS: "9999",
      AGENT_MIN_CONFIDENCE: "5",
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(config.cooldownMs, 30_000, "invalid cooldown falls back to default");
  assert.equal(config.maxNudgesPerSession, 3, "out-of-range nudge budget falls back to default");
  assert.deepEqual([...config.allowedActions].sort(), ["noop", "spotlight"], "unknown action names dropped, valid ones kept, noop always present");
  assert.equal(config.maxMessageChars, 140, "out-of-range message cap falls back to default");
  assert.equal(config.minConfidence, 0, "out-of-range confidence floor falls back to default");
  assert.ok(warnings.length > 0, "invalid values produce at least one console.warn");
  console.log(`(xv) ok — invalid env falls back to defaults with ${warnings.length} warning(s)`);
}

// (xvi) describePolicyConfig() shape — plain, JSON-serializable object.
{
  const config = loadPolicyConfig({ AGENT_COOLDOWN_MS: "45000", AGENT_DENY_TARGETS: "a,b" });
  const described = describePolicyConfig(config);
  assert.deepEqual(Object.keys(described).sort(), [
    "allowedActions",
    "cooldownMs",
    "denyTargets",
    "maxMessageChars",
    "maxNudgesPerSession",
    "minConfidence",
    "sensitivity",
  ]);
  assert.equal(described.cooldownMs, 45000);
  assert.deepEqual(described.denyTargets, ["a", "b"]);
  assert.doesNotThrow(() => JSON.stringify(described), "describePolicyConfig() output must be JSON-serializable");
  console.log("(xvi) ok — describePolicyConfig() shape:", described);
}

// (xvii) AGENT_MAX_NUDGES_PER_SESSION=0: zero nudges ever, agent silent —
// even the FIRST non-noop action is denied.
{
  const config = loadPolicyConfig({ AGENT_MAX_NUDGES_PER_SESSION: "0" });
  const session = fakeSession();
  const state = fakeState(["size-guide"]);
  const { action, trace } = applyPolicy(session, state, actionProposal(), { config });
  assert.equal(action.action, "noop", "maxNudgesPerSession=0 denies even the first non-noop action");
  assert.match(trace.why, /session nudge budget spent \(0\)/);
  console.log("(xvii) ok — maxNudgesPerSession=0 keeps the agent silent:", trace.why);
}

// (xviii) AGENT_MAX_NUDGES_PER_SESSION=-1: unlimited — many non-noop actions
// in a row are all allowed (distinct targets, cooldown disabled via a low
// nudge-unrelated concern is out of scope here — use skipCooldown so only
// the nudge-budget guard is under test).
{
  const config = loadPolicyConfig({ AGENT_MAX_NUDGES_PER_SESSION: "-1" });
  const session = fakeSession();
  const state = fakeState(["size-guide", "cart-add", "shipping-banner"]);
  const r1 = applyPolicy(session, state, actionProposal({ action: { target: "size-guide" } }), { config, skipCooldown: true });
  const r2 = applyPolicy(session, state, actionProposal({ action: { target: "cart-add" } }), { config, skipCooldown: true });
  const r3 = applyPolicy(session, state, actionProposal({ action: { target: "shipping-banner" } }), { config, skipCooldown: true });
  assert.equal(r1.action.action, "highlight");
  assert.equal(r2.action.action, "highlight");
  assert.equal(r3.action.action, "highlight", "maxNudgesPerSession=-1 never spends the budget");
  assert.equal(session.nudgeCount, 3);
  console.log("(xviii) ok — maxNudgesPerSession=-1 is unlimited");
}

// (xix) fail-closed category: AGENT_ALLOWED_ACTIONS resolving to NO valid
// action at all falls back to noop-only (the MOST RESTRICTIVE value), not
// the permissive "all actions" default — a merchant who set this var meant
// to restrict the agent, so a typo should never silently re-open every
// action.
{
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  let config;
  try {
    config = loadPolicyConfig({ AGENT_ALLOWED_ACTIONS: "teleport,fly" });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual([...config.allowedActions], ["noop"], "all-invalid AGENT_ALLOWED_ACTIONS fails closed to noop-only");
  assert.ok(warnings.length > 0, "fail-closed fallback produces a console.warn");

  const session = fakeSession();
  const state = fakeState(["size-guide"]);
  const { action, trace } = applyPolicy(session, state, actionProposal(), { config });
  assert.equal(action.action, "noop");
  assert.match(trace.why, /action "highlight" disabled by merchant/);
  console.log("(xix) ok — AGENT_ALLOWED_ACTIONS all-invalid fails closed to noop-only:", trace.why);
}

// ---- card guards: cta.value must be REAL, or the card is downgraded to
// noop (fail closed, same shape as every other guard in this file). Uses
// the real server/store/catalog.json / promos.json files (loadStore()'s
// default) since policy.js's card guard isn't given a scoped store — these
// values (slug "khadi-field-jacket", code "JACKET10") are the actual
// merchant data, not test fixtures, so a catalog/promo edit that renames
// them would (correctly) need this test updated too.
function cardProposal(card, overrides = {}) {
  return {
    action: {
      action: "card",
      target: "size-guide",
      style: null,
      duration_ms: 20000,
      message: null,
      card,
      ...overrides,
    },
    trace: { ts: Date.now(), signals: ["s"], hypothesis: "h", decision: "card", confidence: 0.9, why: "w" },
  };
}

// (xx) add_to_cart with a REAL catalog slug is allowed.
{
  const session = fakeSession();
  const state = fakeState(["size-guide"]);
  const card = { title: "Add for free delivery", body: "Add the jacket.", cta: { kind: "add_to_cart", label: "Add jacket", value: "khadi-field-jacket" } };
  const { action } = applyPolicy(session, state, cardProposal(card));
  assert.equal(action.action, "card");
  assert.equal(action.card.cta.value, "khadi-field-jacket");
  console.log("(xx) ok — card add_to_cart with a real slug allowed");
}

// (xxi) add_to_cart with a FAKE slug is downgraded to noop.
{
  const session = fakeSession();
  const state = fakeState(["size-guide"]);
  const card = { title: "Add for free delivery", body: "Add the thing.", cta: { kind: "add_to_cart", label: "Add it", value: "not-a-real-product" } };
  const { action, trace } = applyPolicy(session, state, cardProposal(card));
  assert.equal(action.action, "noop");
  assert.match(trace.why, /not a real product slug/);
  console.log("(xxi) ok — card add_to_cart with a fake slug downgraded to noop:", trace.why);
}

// (xxii) apply_code with a REAL active promo code is allowed.
{
  const session = fakeSession();
  const state = fakeState(["promo-code"]);
  const card = { title: "You have a code", body: "Use JACKET10.", cta: { kind: "apply_code", label: "Apply JACKET10", value: "JACKET10" } };
  const { action } = applyPolicy(session, state, cardProposal(card, { target: "promo-code" }));
  assert.equal(action.action, "card");
  console.log("(xxii) ok — card apply_code with a real active code allowed");
}

// (xxiii) apply_code with a FAKE code is downgraded to noop — the
// acceptance-criteria demo case (a card can't hand the shopper a code that
// does nothing when they type it in).
{
  const session = fakeSession();
  const state = fakeState(["promo-code"]);
  const card = { title: "You have a code", body: "Use VITAMINC.", cta: { kind: "apply_code", label: "Apply VITAMINC", value: "VITAMINC" } };
  const { action, trace } = applyPolicy(session, state, cardProposal(card, { target: "promo-code" }));
  assert.equal(action.action, "noop");
  assert.match(trace.why, /not an active promo code/);
  console.log("(xxiii) ok — card apply_code with a fake code downgraded to noop:", trace.why);
}

// (xxiv) pick_size validates against state.product.sizes (the CURRENT
// product page), not just any string.
{
  const session = fakeSession();
  const state = { ...fakeState(["size-guide"]), product: { slug: "khadi-field-jacket", name: "Khadi Field Jacket", price: 3450, sizes: ["S", "M", "L", "XL"], fit_notes: "x" } };
  const goodCard = { title: "Between sizes?", body: "Take the larger.", cta: { kind: "pick_size", label: "Try size XL", value: "XL" } };
  const { action: good } = applyPolicy(session, state, cardProposal(goodCard));
  assert.equal(good.action, "card");

  const session2 = fakeSession();
  const badCard = { title: "Between sizes?", body: "Take the larger.", cta: { kind: "pick_size", label: "Try size XXL", value: "XXL" } };
  const { action: bad, trace: badTrace } = applyPolicy(session2, state, cardProposal(badCard));
  assert.equal(bad.action, "noop");
  assert.match(badTrace.why, /not a valid size/);
  console.log("(xxiv) ok — card pick_size validated against state.product.sizes:", badTrace.why);
}

// (xxv) pick_size with no state.product (not on a product page) is denied.
{
  const session = fakeSession();
  const state = fakeState(["size-guide"]); // no .product
  const card = { title: "Between sizes?", body: "Take the larger.", cta: { kind: "pick_size", label: "Try size M", value: "M" } };
  const { action, trace } = applyPolicy(session, state, cardProposal(card));
  assert.equal(action.action, "noop");
  assert.match(trace.why, /not a valid size/);
  console.log("(xxv) ok — card pick_size off a product page (no state.product) denied:", trace.why);
}

// (xxvi) cta.kind "none" needs no value; an empty/missing card is denied.
{
  const session = fakeSession();
  const state = fakeState(["size-guide"]);
  const card = { title: "Free delivery in Dhaka", body: "1-2 days.", cta: { kind: "none", label: "Got it", value: null } };
  const { action } = applyPolicy(session, state, cardProposal(card));
  assert.equal(action.action, "card");

  const session2 = fakeSession();
  const emptyCard = { title: "", body: "", cta: { kind: "none", label: "", value: null } };
  const { action: denied } = applyPolicy(session2, state, cardProposal(emptyCard));
  assert.equal(denied.action, "noop", "a card with no title/body/cta.label is meaningless — normalize() forces noop");
  console.log("(xxvi) ok — cta.kind none allowed with no value; empty card denied");
}

// --- stale-snapshot / same-nudge defect class (found live 2026-09-11, session
// s_kmtgye1g) ------------------------------------------------------------
//
// Two failures observed in the same live session:
//   1. A `card promo-code` was decided from a state snapshot taken on /cart;
//      by the time the (slow, 15s) decider returned, the shopper was on
//      /checkout, where promo-code isn't a target — checkViolation only
//      compared against the snapshot (state.visibleTargets), never the
//      session's CURRENT page.
//   2. Two cards 44s apart for the same hesitation (`card size-guide` then
//      `card size-picker`, both {kind:"pick_size", value:"L"}) both passed
//      because "never same TARGET" doesn't catch "never same underlying ask"
//      — it burned the whole 3-per-session nudge budget on a repeat.

// (xxvii) Guard A — live current-page recheck: the snapshot
// (state.visibleTargets) still lists the target, but the session's last
// page_view (a DIFFERENT page than the one the snapshot was built for) does
// not → denied, naming the current page.
{
  const session = fakeSession({
    events: [{ type: "page_view", target: "/checkout", meta: { targets: ["shipping-banner"] } }],
  });
  const state = fakeState(["promo-code", "shipping-banner"]); // stale snapshot, taken on /cart
  const proposed = actionProposal({ action: { action: "highlight", target: "promo-code" } });
  const { action, trace } = applyPolicy(session, state, proposed);
  assert.equal(action.action, "noop", "stale-snapshot target denied by live current-page recheck");
  assert.match(trace.why, /target "promo-code" not on the shopper's current page \(\/checkout\)/);
  console.log("(xxvii) ok — stale snapshot target denied by live current-page recheck:", trace.why);
}

// (xxviii) Inverse of (xxvii): target present on BOTH the snapshot and the
// session's live current-page targets → allowed.
{
  const session = fakeSession({
    events: [{ type: "page_view", target: "/cart", meta: { targets: ["promo-code", "shipping-banner"] } }],
  });
  const state = fakeState(["promo-code", "shipping-banner"]);
  const proposed = actionProposal({ action: { action: "highlight", target: "promo-code" } });
  const { action } = applyPolicy(session, state, proposed);
  assert.equal(action.action, "highlight", "target live on the current page is not denied by guard A");
  console.log("(xxviii) ok — target present on snapshot and live current page allowed");
}

// (xxix) Guard B — same-fact block: a second card with the SAME cta.kind +
// cta.value but a DIFFERENT target is denied.
{
  const session = fakeSession();
  const state = {
    ...fakeState(["size-guide", "size-picker"]),
    product: { slug: "x", name: "x", price: 1, sizes: ["S", "M", "L"], fit_notes: "" },
  };
  const card1 = { title: "Between sizes?", body: "Take the larger.", cta: { kind: "pick_size", label: "Try size L", value: "L" } };
  const r1 = applyPolicy(session, state, cardProposal(card1, { target: "size-guide" }), { skipCooldown: true });
  assert.equal(r1.action.action, "card");

  const card2 = { title: "Still deciding?", body: "L runs true to size.", cta: { kind: "pick_size", label: "Try size L", value: "L" } };
  const r2 = applyPolicy(session, state, cardProposal(card2, { target: "size-picker" }), { skipCooldown: true });
  assert.equal(r2.action.action, "noop", "same cta.kind+value on a different target is denied");
  assert.match(r2.trace.why, /same CTA already offered \(pick_size L\)/);
  console.log("(xxix) ok — same-fact block denies a repeat cta on a different target:", r2.trace.why);
}

// (xxx) Guard B, negative case: a second card with a DIFFERENT cta.value is
// NOT blocked by the same-fact guard (cooldown satisfied via skipCooldown).
{
  const session = fakeSession();
  const state = {
    ...fakeState(["size-guide", "size-picker"]),
    product: { slug: "x", name: "x", price: 1, sizes: ["S", "M", "L"], fit_notes: "" },
  };
  const card1 = { title: "Between sizes?", body: "Take the larger.", cta: { kind: "pick_size", label: "Try size L", value: "L" } };
  applyPolicy(session, state, cardProposal(card1, { target: "size-guide" }), { skipCooldown: true });

  const card2 = { title: "Between sizes?", body: "Or maybe M.", cta: { kind: "pick_size", label: "Try size M", value: "M" } };
  const { action } = applyPolicy(session, state, cardProposal(card2, { target: "size-picker" }), { skipCooldown: true });
  assert.equal(action.action, "card", "a different cta.value is not treated as the same fact");
  console.log("(xxx) ok — different cta value passes the same-fact guard");
}

// (xxxi) Guard C — on-screen quiet period: a second card 40s after a
// previous card (past the 30s cooldown floor, inside the 90s default quiet
// period) is denied. lastInterventionAt is rewound directly (same style as
// fakeSession({ lastInterventionAt: 0 }) elsewhere in this file) rather than
// actually sleeping.
{
  const session = fakeSession();
  const state = {
    ...fakeState(["size-guide", "cart-add"]),
    product: { slug: "x", name: "x", price: 1, sizes: ["S", "M", "L"], fit_notes: "" },
  };
  const card1 = { title: "Between sizes?", body: "Take the larger.", cta: { kind: "pick_size", label: "Try size L", value: "L" } };
  const r1 = applyPolicy(session, state, cardProposal(card1, { target: "size-guide" }));
  assert.equal(r1.action.action, "card");
  session.lastInterventionAt -= 40000;

  const card2 = { title: "Add for free delivery", body: "One tap.", cta: { kind: "add_to_cart", label: "Add jacket", value: "khadi-field-jacket" } };
  const { action, trace } = applyPolicy(session, state, cardProposal(card2, { target: "cart-add" }));
  assert.equal(action.action, "noop", "40s after a prior card is still inside the 90s quiet period");
  assert.match(trace.why, /on-screen quiet period active \(90s\)/);
  console.log("(xxxi) ok — second card 40s later denied by on-screen quiet period:", trace.why);
}

// (xxxii) Guard C, negative case: a second card 100s after the previous one
// (past the 90s default quiet period) is allowed.
{
  const session = fakeSession();
  const state = {
    ...fakeState(["size-guide", "cart-add"]),
    product: { slug: "x", name: "x", price: 1, sizes: ["S", "M", "L"], fit_notes: "" },
  };
  const card1 = { title: "Between sizes?", body: "Take the larger.", cta: { kind: "pick_size", label: "Try size L", value: "L" } };
  applyPolicy(session, state, cardProposal(card1, { target: "size-guide" }));
  session.lastInterventionAt -= 100000;

  const card2 = { title: "Add for free delivery", body: "One tap.", cta: { kind: "add_to_cart", label: "Add jacket", value: "khadi-field-jacket" } };
  const { action } = applyPolicy(session, state, cardProposal(card2, { target: "cart-add" }));
  assert.equal(action.action, "card", "100s after a prior card is past the 90s quiet period");
  console.log("(xxxii) ok — second card 100s later allowed, past the quiet period");
}

// (xxxiii) Guard C knob: AGENT_ON_SCREEN_QUIET_MS=-1 disables the guard
// entirely — the same 40s-later case from (xxxi) now passes.
{
  const original = process.env.AGENT_ON_SCREEN_QUIET_MS;
  process.env.AGENT_ON_SCREEN_QUIET_MS = "-1";
  try {
    const session = fakeSession();
    const state = {
      ...fakeState(["size-guide", "cart-add"]),
      product: { slug: "x", name: "x", price: 1, sizes: ["S", "M", "L"], fit_notes: "" },
    };
    const card1 = { title: "Between sizes?", body: "Take the larger.", cta: { kind: "pick_size", label: "Try size L", value: "L" } };
    applyPolicy(session, state, cardProposal(card1, { target: "size-guide" }));
    session.lastInterventionAt -= 40000;

    const card2 = { title: "Add for free delivery", body: "One tap.", cta: { kind: "add_to_cart", label: "Add jacket", value: "khadi-field-jacket" } };
    const { action } = applyPolicy(session, state, cardProposal(card2, { target: "cart-add" }));
    assert.equal(action.action, "card", "AGENT_ON_SCREEN_QUIET_MS=-1 disables guard C");
  } finally {
    if (original === undefined) delete process.env.AGENT_ON_SCREEN_QUIET_MS;
    else process.env.AGENT_ON_SCREEN_QUIET_MS = original;
  }
  console.log("(xxxiii) ok — AGENT_ON_SCREEN_QUIET_MS=-1 disables the on-screen quiet period");
}

// (xxxiv) Guard C only applies when the PREVIOUS non-noop action was a
// card/message (persistent on-screen text) — a prior `highlight` (no text)
// does not trigger the quiet period even well inside the 90s window.
{
  const session = fakeSession({
    lastInterventionAt: Date.now() - 40000,
    lastInterventionAction: "highlight",
  });
  const state = {
    ...fakeState(["size-guide"]),
    product: { slug: "x", name: "x", price: 1, sizes: ["S", "M", "L"], fit_notes: "" },
  };
  const card = { title: "Between sizes?", body: "Take the larger.", cta: { kind: "pick_size", label: "Try size L", value: "L" } };
  const { action } = applyPolicy(session, state, cardProposal(card, { target: "size-guide" }));
  assert.equal(action.action, "card", "a prior highlight (no text) does not trigger the on-screen quiet period");
  console.log("(xxxiv) ok — prior highlight does not trigger the on-screen quiet period");
}

// (xxxv) Anchor fallback — category (b) fix (live finding session
// final_tm_242431): a card grounded by an offers[] entry whose target_hint
// ("promo-code") isn't in the shopper's CURRENT visibleTargets (browsing
// /shop-shaped page, no promo-code element rendered there) gets its target
// rewritten to the template's first available fallback ("cart-link" here,
// present in visibleTargets) instead of being denied outright — trace notes
// `anchor_fallback`.
{
  const session = fakeSession();
  const state = {
    ...fakeState(["cart-link", "search"]), // no "promo-code" on this page
    offers: [{ kind: "missed_discount", code: "JACKET10", saving: 345 }],
  };
  const card = { template: "missed_discount", slots: { code: "JACKET10", saving: "345" }, cta: { kind: "apply_code", label: "Apply JACKET10", value: "JACKET10" } };
  const { action, trace } = applyPolicy(session, state, cardProposal(card, { target: "promo-code" }));
  assert.equal(action.action, "card", "anchor fallback delivers the card instead of denying it");
  assert.equal(action.target, "cart-link", "target rewritten to the chain's first present fallback");
  assert.ok(
    trace.signals.some((s) => s.startsWith("anchor_fallback promo-code->cart-link")),
    `trace.signals should note the anchor_fallback rewrite, got: ${JSON.stringify(trace.signals)}`
  );
  console.log("(xxxv) ok — anchor fallback rewrites promo-code -> cart-link when promo-code isn't visible:", trace.signals.at(-1));
}

// (xxxvi) Anchor fallback never applies to pick_size (size_help) — no safe
// fallback exists for "pick a size" when the shopper isn't on the size
// picker; target not in visibleTargets is denied as before (noop).
{
  const session = fakeSession();
  const state = {
    ...fakeState(["cart-link", "search"]), // no "size-guide" on this page
    product: { slug: "khadi-field-jacket", name: "Khadi Field Jacket", price: 3450, sizes: ["S", "M", "L"], fit_notes: "Runs narrow." },
  };
  const card = { title: "Between sizes?", body: "Take the larger.", cta: { kind: "pick_size", label: "Try size L", value: "L" } };
  const { action } = applyPolicy(session, state, cardProposal(card, { target: "size-guide" }));
  assert.equal(action.action, "noop", "pick_size never gets an anchor fallback — denied when its target isn't visible");
  console.log("(xxxvi) ok — pick_size gets no anchor fallback, denied as before");
}

// (xxxvii) Anchor fallback is a no-op when the natural target IS visible —
// never rewrites a perfectly good target just because a chain exists.
{
  const session = fakeSession();
  const state = {
    ...fakeState(["promo-code", "cart-link"]),
    offers: [{ kind: "missed_discount", code: "JACKET10", saving: 345 }],
  };
  const card = { template: "missed_discount", slots: { code: "JACKET10", saving: "345" }, cta: { kind: "apply_code", label: "Apply JACKET10", value: "JACKET10" } };
  const { action, trace } = applyPolicy(session, state, cardProposal(card, { target: "promo-code" }));
  assert.equal(action.action, "card");
  assert.equal(action.target, "promo-code", "natural target kept untouched when it's already visible");
  assert.ok(!trace.signals.some((s) => s.startsWith("anchor_fallback")), "no anchor_fallback note when no rewrite happened");
  console.log("(xxxvii) ok — anchor fallback leaves an already-visible target untouched");
}

console.log("\nprobe-policy: all assertions passed");
