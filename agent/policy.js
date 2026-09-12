// Deterministic guards applied to ANY decider output (stub, cached, or LLM).
// Never trust the decider — this is the last line of defense before broadcast.
//
// normalize() is the untrusted-input boundary: a decider (stub, cached replay,
// or an LLM) can hand back ANY shape — wrong types, extra keys, bad casing,
// out-of-range numbers, oversized strings. normalize() rebuilds both the
// action and trace objects to EXACTLY the contract fields, coercing/clamping
// every value, before any guard runs and on every return path (allow, deny,
// throw). Nothing downstream (index.js, the widget) should ever see a
// decider-shaped object directly.
//
// Merchant policy: every guard constant below is sourced from
// server/policy-config.js (env-driven, validated, frozen). The env-loaded
// singleton is the default; callers (tests) may pass opts.config to run
// against a scoped config instead. See server/POLICY.md.

import { ACTIONS } from "./contracts.js";
import { summarize } from "./state.js";
import { policyConfig as defaultPolicyConfig } from "./policy-config.js";
import { loadStore, activePromos } from "./store/index.js";
import { renderCard, anchorChain } from "./templates.js";
import { classifyStaleContext, liveProduct } from "./stale.js";

// Named export kept for compatibility with anything importing the old
// constant directly. Sourced from the env-loaded singleton at import time —
// NOT a fixed literal anymore. Guards themselves read opts.config (which may
// differ, e.g. in tests), not this export.
export const COOLDOWN_MS = defaultPolicyConfig.cooldownMs;

const STYLES = new Set(["pulse", "outline"]);

// Guard B (same-CTA-already-offered) time window — see the guard's own
// comment below. 10 minutes: long enough that a rapid repeat proposal
// (the actual defect this guard exists for) is still caught, short enough
// that a shopper who comes back to the same product later in a long
// session can be re-offered the same real fact instead of being silently
// blocked for the rest of the session.
const RECENT_CTA_WINDOW_MS = 10 * 60 * 1000;
// Fixed-short-effect-lifetime defect class: a live decider takes 15-22s
// (claude CLI); the old 8000/8000/10000ms defaults could expire entirely
// inside a shopper's wait for the effect to even land, making the
// intervention invisible. CLAUDE.md's contract does not fix these numbers
// (only the action/trace shapes and the 30s cooldown/never-same-target
// rules) — durations are ours to tune. 20s comfortably outlasts a live
// decision; the 30s clampNumber ceiling below is the hard merchant/decider
// ceiling regardless of what a proposal asks for.
const DEFAULT_DURATION = { highlight: 20000, spotlight: 20000, message: 20000, card: 20000 };

// card cta shape guards — see server/contracts.js's `card` doc comment and
// server/POLICY.md "card guards" for the full rationale. Lengths are the
// fixed contract ceilings; kind is the fixed cta vocabulary.
const CARD_TITLE_MAX = 60;
const CARD_BODY_MAX = 200;
const CARD_CTA_LABEL_MAX = 28;
const CTA_KINDS = new Set(["pick_size", "add_to_cart", "apply_code", "open_product", "search", "none"]);

function clampNumber(n, min, max, fallback) {
  const num = Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function toTrimmedString(v, maxLen) {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (maxLen != null && trimmed.length > maxLen) return trimmed.slice(0, maxLen);
  return trimmed;
}

const TEMPLATE_ID_MAX = 40;
const SLOT_NAME_MAX = 40;
const SLOT_VALUE_MAX = 200; // generous; server/templates.js enforces each template's own tighter per-slot max_len
const MAX_SLOTS = 12;

/**
 * normalizeCard(raw) → { template, slots, title, body, cta: { kind, label, value } }
 * Rebuilds the untrusted `card` sub-object to exact shape: strings
 * trimmed/truncated to the contract's length ceilings, cta.kind forced into
 * the fixed vocabulary (falls back to "none"), cta.value trimmed or null.
 * This only reshapes/truncates — it does NOT check cta.value is a REAL
 * slug/code/size (that's checkViolation's job, since it needs live store
 * state normalize() doesn't have access to), and it does NOT validate
 * template/slots (that's server/templates.js's renderCard(), called from
 * applyPolicy() below once state is in scope).
 *
 * `template` (string|null) + `slots` (plain object, string-coerced values,
 * capped at MAX_SLOTS keys) is the preferred card form — see
 * server/prompts/templates.json / decide.md "Card recipes". The free-text
 * `title`/`body` form is still accepted (both may be "" when a template is
 * used instead) for backward compat with existing recorded fixtures/tests.
 */
function normalizeCard(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const title = toTrimmedString(c.title, CARD_TITLE_MAX) || "";
  const body = toTrimmedString(c.body, CARD_BODY_MAX) || "";
  const template = toTrimmedString(c.template, TEMPLATE_ID_MAX) || null;
  let slots = null;
  if (c.slots && typeof c.slots === "object" && !Array.isArray(c.slots)) {
    slots = {};
    let n = 0;
    for (const [k, v] of Object.entries(c.slots)) {
      if (n >= MAX_SLOTS) break;
      if (typeof k !== "string" || !k) continue;
      const key = k.slice(0, SLOT_NAME_MAX);
      if (v == null) continue;
      const value = toTrimmedString(String(v), SLOT_VALUE_MAX);
      if (value) slots[key] = value;
      n++;
    }
  }
  const ctaRaw = c.cta && typeof c.cta === "object" ? c.cta : {};
  const kind = CTA_KINDS.has(ctaRaw.kind) ? ctaRaw.kind : "none";
  const label = toTrimmedString(ctaRaw.label, CARD_CTA_LABEL_MAX) || "";
  let value = toTrimmedString(ctaRaw.value, 60);
  if (value === "") value = null;
  return { template, slots, title, body, cta: { kind, label, value } };
}

/**
 * normalizeAction(raw, maxMessageChars) → { action, target, style, duration_ms, message, card }
 * `card` is null for every action except "card" (see normalizeCard above);
 * shape-only — it does NOT verify cta.value is a real slug/code/size, that
 * happens in checkViolation() below where live store state is available.
 * `action` must be an exact (case-sensitive) match in ACTIONS, else the
 * whole action is forced to a noop (no casing tolerance).
 * maxMessageChars — merchant-configured message cap (server/policy-config.js
 * AGENT_MAX_MESSAGE_CHARS), defaults to the contract max of 140. Messages
 * longer than the cap are truncated here, not denied — see server/POLICY.md.
 */
// Fixed-short-effect-lifetime's sibling defect class: a live decider takes
// 15-22s (claude CLI) to return a proposal that was decided against a
// SNAPSHOT of the shopper's page. By the time it broadcasts, the shopper may
// have navigated on — the snapshot (state.visibleTargets) says nothing about
// where they are NOW. currentVisibleTargets()/currentPage() re-derive that
// live, from session.events, using the exact same rule server/state.js's
// buildState() uses to build the snapshot in the first place (last
// page_view's meta.targets / target). Found live 2026-09-11 (session
// s_kmtgye1g): a `card promo-code` decided on /cart broadcast onto
// /checkout, where promo-code was never a target.
export function currentVisibleTargets(session) {
  const events = session?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "page_view") {
      return Array.isArray(events[i].meta?.targets) ? events[i].meta.targets : [];
    }
  }
  return [];
}

function currentPage(session) {
  const events = session?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "page_view") return events[i].target ?? null;
  }
  return null;
}

/**
 * effectiveVisibleTargets(state, session) -> string[] — the exact set of
 * target ids a proposed target must belong to in order to pass BOTH of
 * checkViolation()'s target guards below (the state.visibleTargets snapshot
 * check, and Guard A's live currentVisibleTargets() re-check): when both
 * lists are non-empty, their intersection (a target must be in both to
 * pass); when either is empty, "no opinion" from that side, same carve-out
 * checkViolation already applies, so the other (non-empty) list alone
 * decides. Used ONLY by the anchor-fallback rewrite above, so a fallback
 * target it picks is guaranteed to actually clear both guards afterward —
 * never a target that merely LOOKS safe from one side.
 */
function effectiveVisibleTargets(state, session) {
  const snapshot = Array.isArray(state?.visibleTargets) ? state.visibleTargets : [];
  const live = currentVisibleTargets(session);
  if (snapshot.length === 0) return live;
  if (live.length === 0) return snapshot;
  return snapshot.filter((t) => live.includes(t));
}

// Guard C (on-screen quiet period) knob. This belongs conceptually next to
// cooldownMs in server/policy-config.js, but that file is outside this
// change's edit boundary (see brief) — read process.env directly here
// instead. -1 disables the guard; any other non-negative integer is
// honoured; anything missing/invalid/negative-but-not--1 falls back to the
// 90s default. TODO(server/policy-config.js owner): move this into
// defaultPolicyConfig alongside cooldownMs so it's env-validated once at
// import time like every other knob, instead of re-read per call.
const DEFAULT_ON_SCREEN_QUIET_MS = 90000;
function getOnScreenQuietMs() {
  const raw = process.env.AGENT_ON_SCREEN_QUIET_MS;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_ON_SCREEN_QUIET_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return DEFAULT_ON_SCREEN_QUIET_MS;
  if (n === -1) return -1;
  if (n < 0) return DEFAULT_ON_SCREEN_QUIET_MS;
  return n;
}

export function normalizeAction(raw, maxMessageChars = 140) {
  const r = raw && typeof raw === "object" ? raw : {};
  const actionType = typeof r.action === "string" && ACTIONS.includes(r.action) ? r.action : "noop";

  const target = typeof r.target === "string" && r.target.length > 0 ? r.target : null;
  const style = STYLES.has(r.style) ? r.style : null;

  const defaultDuration = DEFAULT_DURATION[actionType] ?? 0;
  // Ceiling raised 15000 -> 25000 alongside the DEFAULT_DURATION bump above —
  // a decider-proposed duration_ms below the new 20000 default would
  // otherwise still get clamped down by the old 15000 ceiling. Capped at
  // 25000, not 30000: the ceiling must stay strictly BELOW COOLDOWN_MS
  // (also 30000 by default) — an effect allowed to run exactly as long as
  // the cooldown window would let its own still-visible duration overlap
  // the moment the cooldown lifts, instead of always finishing with room to
  // spare before another intervention becomes eligible.
  // Floor at the default for every real effect: deciders copy the contract
  // example (8000) or pick 5000, and a highlight that ends before the shopper
  // looks up is help nobody saw (found live 2026-09-11). The decider may only
  // lengthen an effect, never shorten it below the merchant default.
  const duration_ms = actionType === "noop" ? 0 : clampNumber(r.duration_ms, defaultDuration, 25000, defaultDuration);

  let message = toTrimmedString(r.message, maxMessageChars);
  if (message === "" || message === null) message = null;
  // Contract: a card carries its own text — message is always null for it,
  // regardless of what a decider mistakenly put there.
  if (actionType === "card") message = null;

  // A message action with an empty/missing message is meaningless — deny it
  // by forcing noop rather than shipping a blank bubble.
  if (actionType === "message" && !message) {
    return { action: "noop", target: null, style: null, duration_ms: 0, message: null, card: null };
  }

  let card = null;
  if (actionType === "card") {
    card = normalizeCard(r.card);
    // A card with no cta.label, and NEITHER a template id NOR a free
    // title+body, is meaningless — deny it by forcing noop, same rationale
    // as the empty-message guard above. A template card legitimately has
    // empty title/body here (server/templates.js's renderCard() fills them
    // in later, in applyPolicy(), once state is in scope) — only reject it
    // this early when it has no template id to fall back to either.
    const hasTemplate = Boolean(card.template);
    const hasFreeText = Boolean(card.title) && Boolean(card.body);
    if (!card.cta.label || (!hasTemplate && !hasFreeText)) {
      return { action: "noop", target: null, style: null, duration_ms: 0, message: null, card: null };
    }
  }

  return { action: actionType, target, style, duration_ms, message, card };
}

/**
 * normalizeTrace(raw, session) → { ts, signals, hypothesis, decision, confidence, why }
 */
export function normalizeTrace(raw, session) {
  const r = raw && typeof raw === "object" ? raw : {};

  const ts = Number.isFinite(Number(r.ts)) ? Number(r.ts) : Date.now();

  let signals;
  if (Array.isArray(r.signals) && r.signals.length <= 8 && r.signals.every((s) => typeof s === "string")) {
    signals = r.signals;
  } else {
    signals = session ? summarize(session.events) : [];
  }

  const hypothesis = typeof r.hypothesis === "string" ? r.hypothesis : "";
  const decision = typeof r.decision === "string" && r.decision.length > 0 ? r.decision : "noop";
  const confidence = clampNumber(r.confidence, 0, 1, 0.5);
  const why = typeof r.why === "string" ? r.why : "";

  return { ts, signals, hypothesis, decision, confidence, why };
}

/**
 * normalize(proposed, session, config) → { action, trace } rebuilt to exact
 * contract shape. Applied before any guard, on every path. `config` supplies
 * the merchant's AGENT_MAX_MESSAGE_CHARS (defaults to the env-loaded
 * singleton, i.e. the contract's 140 unless lowered).
 */
export function normalize(proposed, session, config = defaultPolicyConfig) {
  const p = proposed && typeof proposed === "object" ? proposed : {};
  return {
    action: normalizeAction(p.action, config.maxMessageChars),
    trace: normalizeTrace(p.trace, session),
  };
}

/**
 * applyPolicy(session, state, proposed, opts) → { action, trace }
 * On any violation or thrown error, returns a noop with a trace explaining why.
 * On an allowed non-noop action, records lastInterventionAt/actedTargets and
 * increments session.nudgeCount.
 *
 * opts.skipCooldown — cached-mode playback only: timing on a `--speed`d
 * replay is not the timing that produced the recording, so the wall-clock
 * cooldown is skipped. Allow-list/target/shape guards, the no-repeat-target
 * guard, and the nudge budget still apply (a merchant's "at most N nudges"
 * promise must hold even during cached replay).
 *
 * opts.config — merchant policy config (server/policy-config.js). Defaults
 * to the env-loaded singleton; tests pass a scoped loadPolicyConfig({...})
 * override here.
 */
export function applyPolicy(session, state, proposed, opts = {}) {
  const config = opts.config ?? defaultPolicyConfig;

  let normalized;
  try {
    normalized = normalize(proposed, session, config);
  } catch (err) {
    // normalize() itself should never throw, but guard anyway.
    normalized = normalize({}, session, config);
    return denied(normalized, `threw: ${err.message}`);
  }

  try {
    const { action, trace } = normalized;

    // Anchor fallback (category (b) fix, live finding session
    // final_tm_242431): a card grounded by an offers[] entry whose
    // target_hint isn't rendered on the shopper's CURRENT page (promo-code/
    // shipping-banner/similar-products only exist on cart/checkout/product
    // pages, never on /shop, home, or a category page) used to be
    // structurally impossible — the model correctly reasoned the target
    // wasn't visible and had no choice but noop. Captured BEFORE the
    // template-render step below strips `action.card.template` off the
    // normalized card. Skipped entirely for `pick_size` — never fall back
    // for it, it needs the shopper to actually be on the size picker (see
    // server/templates.js's anchorChain() doc comment); size_help also
    // simply declares no `anchor` chain in templates.json, so this would be
    // a no-op for it anyway, but the explicit cta.kind check stays as
    // defense in depth against a future template mistakenly pairing
    // pick_size with an anchor list.
    const templateIdForAnchor = action.action === "card" ? action.card?.template : null;
    if (templateIdForAnchor && action.target && action.card?.cta?.kind !== "pick_size") {
      const chain = anchorChain(templateIdForAnchor);
      if (chain) {
        const effective = effectiveVisibleTargets(state, session);
        if (effective.length > 0 && !effective.includes(action.target)) {
          const fallback = chain.find((t) => effective.includes(t));
          if (fallback && fallback !== action.target) {
            trace.signals = Array.isArray(trace.signals) ? trace.signals.slice() : [];
            trace.signals.push(`anchor_fallback ${action.target}->${fallback}`);
            action.target = fallback;
          }
        }
      }
    }

    // Suppress-after-dismiss (docs/BEHAVIOR-MATRIX.md, AGENT_SUPPRESS_AFTER_
    // DISMISS): the SAME card template must never re-show once the shopper
    // has dismissed it this session — checked here (before render strips
    // the template id off a fresh proposal, same ordering constraint as the
    // anchor-fallback block above) so a repeat template is denied outright
    // rather than rendered and then denied downstream. session.
    // dismissedTemplates is populated by index.js's handleOutcomeEvent() on
    // an outcome:"dismiss" whose action carried a template id (see
    // contracts.js's agent_outcome.meta.template doc comment).
    if (config.suppressAfterDismiss && templateIdForAnchor && session.dismissedTemplates?.has(templateIdForAnchor)) {
      return denied(normalized, `suppressed:dismissed_template (${templateIdForAnchor})`);
    }

    // Card templates: render {template, slots} into {title, body} BEFORE
    // any other guard runs, so every downstream check (length/shape/cta
    // realness in checkViolation) sees a plain rendered card exactly like
    // the free-text form always produced — templating is purely a text-
    // authoring layer, never a second cta/validity path. A free-text card
    // (no template) passes through untouched. See server/templates.js.
    if (action.action === "card" && action.card?.template) {
      const rendered = renderCard(action.card, state);
      if (!rendered.ok) return denied(normalized, rendered.reason);
      // template id is kept (not just render input) so it can flow out on
      // the wire (index.js's actionMessage()) for the widget to echo back
      // in agent_outcome.meta.template — that's what lets
      // AGENT_SUPPRESS_AFTER_DISMISS (checked above, in the
      // dismissed-template block) suppress the SAME template next time.
      action.card = { title: rendered.title, body: rendered.body, cta: action.card.cta, template: action.card.template };
      // slot_autofilled:<name> (2026-09-12 live-run fix) — a fact slot the
      // model paraphrased past exact/fuzzy grounding got its text replaced
      // by a canonical store fact (templates.js's resolveFactSource());
      // surfaced on the trace so this is observable, not silent.
      if (Array.isArray(rendered.autofilled) && rendered.autofilled.length > 0) {
        trace.signals = Array.isArray(trace.signals) ? trace.signals.slice() : [];
        for (const name of rendered.autofilled) trace.signals.push(`slot_autofilled:${name}`);
      }
    }

    const reason = checkViolation(session, state, action, trace, opts, config);
    if (reason) return denied(normalized, reason);

    if (action.action !== "noop") {
      session.lastInterventionAt = Date.now();
      session.lastInterventionTarget = action.target ?? null;
      // lastInterventionAction: which action TYPE just went out — guard C
      // (on-screen quiet period) only applies while the prior thing on
      // screen actually carries text (card/message); a highlight/spotlight
      // leaves nothing to be redundant with.
      session.lastInterventionAction = action.action;
      if (action.target) session.actedTargets.add(action.target);
      session.nudgeCount = (session.nudgeCount ?? 0) + 1;
      // recentCtas: bounded (max 10) log of every CTA a `card` action has
      // actually offered this session — guard B (same-fact block) reads
      // this to catch two DIFFERENT targets nudging the same underlying
      // fact (e.g. `card size-guide` then `card size-picker`, both
      // {kind:"pick_size", value:"L"}) — "never same TARGET" alone let that
      // through and burned the session's nudge budget on a repeat. Found
      // live 2026-09-11 (session s_kmtgye1g).
      session.actionsThisPageview = (session.actionsThisPageview ?? 0) + 1;
      if (action.action === "card" && action.card?.cta) {
        session.recentCtas = session.recentCtas ?? [];
        session.recentCtas.push({
          kind: action.card.cta.kind,
          value: action.card.cta.value,
          target: action.target ?? null,
          ts: session.lastInterventionAt,
        });
        if (session.recentCtas.length > 10) session.recentCtas.shift();
      }
    }
    return { action, trace };
  } catch (err) {
    return denied(normalized, `threw: ${err.message}`);
  }
}

// Guard order (merchant policy tightens; never loosens the fixed contract):
//   allow-list → merchant allowed actions → shape → target-in-visibleTargets
//   (snapshot) → target-on-current-page (live re-check, guard A) →
//   deny-targets → min-confidence → cooldown → never-same-target →
//   same-CTA-already-offered (guard B) → on-screen quiet period (guard C)
//   → payment-step suppression → post-cta suppression → per-pageview cap
//   → nudge budget.
// (dismissed-template suppression, guard D, runs earlier in applyPolicy()
// itself — before template render — see the comment there.)
function checkViolation(session, state, action, trace, opts = {}, config = defaultPolicyConfig) {
  if (!action || !ACTIONS.includes(action.action)) {
    return "invalid action type";
  }
  if (action.action === "noop") return null;

  // Stale-response guard — category: a decision computed 10-20s ago (real
  // LLM latency) against a session snapshot must never render against a
  // changed shopper context. opts.contextFingerprint (captured by index.js
  // right before the decide() call) is compared against the LIVE session
  // here, the FIRST check run against any non-noop proposal — before shape/
  // cta/target checks get a chance to approve content built against facts
  // that are no longer current. Missing opts.contextFingerprint (an older
  // call site, or a test that doesn't wire it) is "no opinion, don't deny",
  // same carve-out Guard A uses for an empty liveTargets. See
  // server/stale.js for the fingerprint/classification and
  // server/stale.test.js for coverage of each drift class.
  const stale = classifyStaleContext(opts.contextFingerprint, session, action.target);
  if (stale) return stale.reason;

  if (!config.allowedActions.includes(action.action)) {
    return `action "${action.action}" disabled by merchant`;
  }

  if (action.action === "message") {
    if (!action.message || typeof action.message !== "string" || action.message.length === 0) {
      return "message action requires non-empty message";
    }
    if (action.message.length > config.maxMessageChars) {
      return `message exceeds ${config.maxMessageChars} chars`;
    }
  }

  // card guard — a decider can hand back a cta pointing at ANY string; the
  // one-tap action it triggers (add to cart, apply a code, open a product,
  // pick a size, search) must be REAL or the shopper taps something that
  // does nothing/breaks. Fail closed (downgrade to noop) on any mismatch —
  // see server/POLICY.md "card guards" and server/contracts.js's card doc.
  if (action.action === "card") {
    const card = action.card;
    if (!card || !card.title || !card.body || !card.cta || !card.cta.label) {
      return "card action requires title, body, and cta.label";
    }
    const { kind, value } = card.cta;
    if (!CTA_KINDS.has(kind)) return `card cta.kind invalid: ${kind}`;
    if (kind !== "none") {
      if (!value) return `card cta.value required for cta.kind "${kind}"`;
      if (kind === "add_to_cart" || kind === "open_product") {
        // session.site (server/store/sites.js): validate against the
        // session's OWN store, not always the default — otherwise every
        // Acme card would fail-closed as "not a real product slug"
        // because it isn't in the default catalog.
        const store = loadStore(session.site);
        const knownSlug = store.catalog.some((p) => p.slug === value);
        if (!knownSlug) return `card cta.value "${value}" is not a real product slug`;
      } else if (kind === "apply_code") {
        const store = loadStore(session.site);
        const activeCode = activePromos(store, Date.now()).some((p) => p.code === value);
        if (!activeCode) return `card cta.value "${value}" is not an active promo code`;
      } else if (kind === "pick_size") {
        // Live-re-derive fix (audit finding, ~this line): state.product is
        // the PRE-decide snapshot (buildState() output as of when the
        // decider was called) — a 10-20s decide() call can resolve after
        // the shopper navigated to a DIFFERENT product with different
        // sizes, and state.product.sizes alone would validate the CTA
        // against the wrong catalog entry. Re-derive live from
        // session.events (server/stale.js's liveProduct(), same idiom
        // currentVisibleTargets()/currentPage() above use for Guard A);
        // only fall back to the snapshot when there's no live page_view at
        // all yet (currentPage(session) === null) — same "no opinion,
        // don't deny" carve-out Guard A applies for an empty liveTargets.
        const hasLivePageView = currentPage(session) != null;
        // session.site (server/store/sites.js): liveProduct()'s own
        // `store = loadStore()` default param would silently re-check
        // against the DEFAULT catalog for a Acme session — same
        // cross-site defect class as the add_to_cart/open_product/
        // apply_code branches above, pass the session's own store explicitly.
        const sizes = hasLivePageView
          ? (liveProduct(session, loadStore(session.site))?.sizes ?? [])
          : (state?.product?.sizes ?? []);
        if (!sizes.includes(value)) return `card cta.value "${value}" is not a valid size for the current product`;
      } else if (kind === "search") {
        if (typeof value !== "string" || value.length === 0 || value.length > 60) {
          return "card cta.value invalid search query";
        }
      }
    }
  }

  // Every non-noop action's target (including message, when present) must be
  // one of the page's known targets — a decider can't point the widget at an
  // element it never told us exists.
  if (action.target != null) {
    if (state.visibleTargets.length > 0 && !state.visibleTargets.includes(action.target)) {
      return `target "${action.target}" not in visibleTargets`;
    }
    // Guard A (live re-check) — state.visibleTargets above is a SNAPSHOT
    // taken when the decision was requested; re-derive the CURRENT page's
    // targets from session.events (same rule state.js's buildState() uses)
    // and deny if the shopper has navigated somewhere that target no longer
    // exists. Empty liveTargets means "no page_view yet" — treated the same
    // as the snapshot check treats an empty state.visibleTargets: no
    // opinion, don't deny.
    const liveTargets = currentVisibleTargets(session);
    if (liveTargets.length > 0 && !liveTargets.includes(action.target)) {
      const page = currentPage(session);
      return `target "${action.target}" not on the shopper's current page${page ? ` (${page})` : ""}`;
    }
  } else if (action.action !== "message") {
    return `${action.action} requires a target`;
  }

  if (action.target && config.denyTargets.includes(action.target)) {
    return `target "${action.target}" denied by merchant`;
  }

  const confidence = trace?.confidence ?? 0;
  if (confidence < config.minConfidence) {
    return `confidence ${confidence} below merchant floor ${config.minConfidence}`;
  }

  if (!opts.skipCooldown) {
    const now = Date.now();
    if (now - session.lastInterventionAt < config.cooldownMs) {
      return `cooldown active (${Math.round(config.cooldownMs / 1000)}s)`;
    }
  }
  if (action.target && session.actedTargets.has(action.target)) {
    return `already acted on target "${action.target}"`;
  }

  // Guard B (same-fact block) — "never same TARGET" isn't the same
  // guarantee as "never the same underlying ask": a decider can point a
  // second card at a DIFFERENT target with the identical cta.kind+value
  // (e.g. `card size-guide` then `card size-picker`, both
  // {kind:"pick_size", value:"L"}) and slip past actedTargets entirely.
  // Found live 2026-09-11 (session s_kmtgye1g) — it burned the 3-per-session
  // budget on a repeat, leaving nothing for later. session.recentCtas is
  // populated in applyPolicy() only when a `card` action actually passes
  // (i.e. was actually SHOWN/delivered) — never on a merely-proposed-then-
  // denied card, so this guard was never blocking on a phantom offer.
  //
  // RECENT_CTA_WINDOW_MS (2026-09-12 live-run fix): the original guard had
  // no time bound at all — a CTA shown once, any time earlier in a long
  // session, blocked the exact same offer forever, even minutes/hours
  // later when re-offering it would be entirely reasonable (the promo is
  // still the best one, the shopper came back to the same product). Now
  // only a CTA shown within this window counts as "already offered";
  // recentCtas entries carry their own `ts` already (see the push() above)
  // so this is a pure read-side filter, no new bookkeeping.
  if (action.action === "card" && Array.isArray(session.recentCtas) && action.card?.cta) {
    const { kind, value } = action.card.cta;
    const now = Date.now();
    const dup = session.recentCtas.some(
      (c) => c.kind === kind && c.value === value && now - (c.ts ?? 0) < RECENT_CTA_WINDOW_MS
    );
    if (dup) return `same CTA already offered (${kind} ${value})`;
  }

  // Guard C (on-screen quiet period) — cards/messages no longer auto-expire
  // off screen, so a second nudge while the first is still visible is noise,
  // not help. Applies only when the PREVIOUS non-noop action was a `card` or
  // `message` (the only actions that put persistent text/CTA content on
  // screen — a highlight/spotlight leaves nothing behind to be redundant
  // with). Shares opts.skipCooldown with the cooldown guard above: cached
  // replay timing is not the wall-clock timing that produced the recording,
  // same rationale documented on applyPolicy's opts.skipCooldown doc comment.
  // TODO: once an `agent_outcome` event tells us the prior card/message was
  // actively DISMISSED, shorten/clear this quiet period instead of always
  // waiting out the full floor — for now we can't tell "still on screen"
  // from "just still within the window".
  if (!opts.skipCooldown) {
    const quietMs = getOnScreenQuietMs();
    if (
      quietMs !== -1 &&
      (session.lastInterventionAction === "card" || session.lastInterventionAction === "message") &&
      Date.now() - session.lastInterventionAt < quietMs
    ) {
      return `on-screen quiet period active (${Math.round(quietMs / 1000)}s)`;
    }
  }

  // Payment-step suppression (docs/BEHAVIOR-MATRIX.md "mid checkout on the
  // payment step specifically" — highest-stakes field-abandonment risk per
  // Baymard). The storefront (web/app/checkout/page.tsx) has a single
  // /checkout route with a payment-options section on it, not a distinct
  // /checkout/payment route — so this matches the /checkout page itself
  // (the only page payment happens on) rather than a literal
  // "/checkout/payment" path. Traced the same way stale.js's
  // stale_context:* denials are, as `suppressed:payment_step`.
  const currentPagePath = currentPage(session);
  if (currentPagePath && /^\/checkout(\/|$)/.test(currentPagePath)) {
    return "suppressed:payment_step";
  }

  // Post-cta suppression (docs/BEHAVIOR-MATRIX.md "immediately after a cta
  // outcome — let the resulting action complete first"): session.
  // lastCtaOutcomeAt is set by index.js's handleOutcomeEvent() on an
  // outcome:"cta" report. 3s fixed window (not merchant-configurable — this
  // is a UX debounce, not a policy dial the brief asked to expose).
  const POST_CTA_QUIET_MS = 3000;
  if (session.lastCtaOutcomeAt && Date.now() - session.lastCtaOutcomeAt < POST_CTA_QUIET_MS) {
    return "suppressed:post_cta";
  }

  // Per-pageview cap (docs/BEHAVIOR-MATRIX.md "Per-page cap"):
  // session.actionsThisPageview counts non-noop actions since the last
  // page_view (state.js pushEvent() resets it, applyPolicy() increments it
  // on allow). -1 = unlimited.
  if (
    config.maxCardsPerPageview !== -1 &&
    (session.actionsThisPageview ?? 0) >= config.maxCardsPerPageview
  ) {
    return `suppressed:page_cap (${config.maxCardsPerPageview})`;
  }

  // maxNudgesPerSession: -1 = unlimited (guard never fires); 0 = zero
  // nudges ever (nudgeCount 0 >= 0 is immediately true, so every non-noop
  // action is denied); N>0 = that many allowed.
  if (config.maxNudgesPerSession !== -1 && (session.nudgeCount ?? 0) >= config.maxNudgesPerSession) {
    return `session nudge budget spent (${config.maxNudgesPerSession})`;
  }

  return null;
}

function denied(normalized, reason) {
  const originalDecision = normalized?.trace?.decision ?? "unknown";
  const humanWhy = normalized?.trace?.why || "Intervened recently; interrupting again would annoy.";
  return {
    action: { action: "noop", target: null, style: null, duration_ms: 0, message: null, card: null },
    trace: {
      ...normalized.trace,
      decision: "noop",
      why: `${humanWhy} (guard: ${reason}; proposed ${originalDecision})`,
    },
  };
}
