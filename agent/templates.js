// Card templates — "notifications won't be random; the model decides which,
// the merchant owns the words." A decider proposes a `card` by NAME
// (card.template, one of server/prompts/templates.json's ids) plus `slots`
// (short values it read off state), instead of writing free title/body
// prose itself. This module is the ONLY place that turns {template, slots}
// into the actual {title, body} text a shopper sees — one render path, so
// every card's copy is provably built from a merchant-authored skeleton
// plus grounded facts, never free-invented model prose.
//
// The free-text {title, body} form (no template) is still accepted for
// backward compat with existing recorded fixtures/tests — see
// server/policy.js's applyPolicy(), which only calls renderCard() when
// normalized.action.card.template is present, and leaves a free-text card
// untouched otherwise.
//
// Fail closed: any problem here (unknown template id, a missing/oversized
// slot, a slot value not traceable to a real state fact, or a rendered
// title/body over the contract's length ceiling) returns { ok: false,
// reason } — server/policy.js turns that into a policy violation
// ("template ...") and the whole action is denied down to noop, same as
// every other card guard.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_PATH = path.join(__dirname, "prompts", "templates.json");

// Mirrors the fixed contract ceilings enforced on the free-text card form
// (server/policy.js's CARD_TITLE_MAX/CARD_BODY_MAX, server/contracts.js's
// card doc comment) — a template-rendered card must respect the exact same
// limits the widget/contract expect, regardless of which form produced it.
const TITLE_MAX = 60;
const BODY_MAX = 200;
// A single slot is a short fact (a name, a code, a ৳ amount, a day count) —
// never a whole sentence. Templates may set a tighter per-slot max_len in
// templates.json; this is the fallback ceiling for any slot that doesn't.
const DEFAULT_SLOT_MAX = 80;

let cachedTemplates = null;
let cachedMtimeMs = null;

/** loadTemplates() — hot-reloadable like server/store/index.js's
 * catalog/promos/policies (mtime-checked, no restart needed to pick up a
 * merchant's edited templates.json). Throws only if the file is missing or
 * not valid JSON — callers (renderCard) let that surface as a template
 * lookup failure ("unknown id"), never a crashed request. */
function loadTemplates() {
  const stat = fs.statSync(TEMPLATES_PATH);
  if (cachedTemplates && cachedMtimeMs === stat.mtimeMs) return cachedTemplates;
  const raw = fs.readFileSync(TEMPLATES_PATH, "utf8");
  cachedTemplates = JSON.parse(raw);
  cachedMtimeMs = stat.mtimeMs;
  return cachedTemplates;
}

/**
 * collectGroundedValues(state) -> Set<string> of every primitive value (and
 * every array's own length, as a string) reachable from state.offers,
 * state.product, state.business, and state.facts — the ONLY fields a
 * template slot is allowed to quote from (mirrors prompts/decide.md's
 * "Store facts" / "Page facts" sections: these are computed by the store,
 * never by the model). A slot value that doesn't appear here has no
 * traceable source and is treated as fabricated, even if it "looks"
 * plausible (a rounded price, a guessed day count, an invented match
 * count) — see server/NOTES.md "Card templates" for the defect class this
 * closes (a free-text card could always have invented a number; a
 * templated one no longer can).
 */
function collectGroundedValues(state) {
  const values = new Set();
  const visit = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) {
      // The array's own length is itself a real, derivable fact (e.g. a
      // search_help offer's candidate count, a size list's length) — not
      // invented just because no single field spells it out as a number.
      values.add(String(v.length));
      v.forEach(visit);
      return;
    }
    if (typeof v === "object") {
      Object.values(v).forEach(visit);
      return;
    }
    values.add(String(v).trim());
  };
  visit(state?.offers);
  visit(state?.product);
  visit(state?.business);
  visit(state?.facts);
  // Page-context scan facts (2026-09-12 brief) — page_context/comparison/
  // cart_economics are computed server-side (state.js/store/index.js) from
  // the widget's DOM scan, same "store/state computes it, model only
  // quotes it" contract as offers/product/business/facts above.
  visit(state?.page_context);
  visit(state?.comparison);
  visit(state?.cart_economics);
  visit(state?.spec_diff);
  return values;
}

// Fact-slot fuzzy grounding + autofill (2026-09-12 live-run fix — see
// server/NOTES.md/POLICY.md: a live run showed 0 cards in 14 minutes
// because the model PARAPHRASES free-text facts ("free delivery (fee 0,
// threshold 0)") instead of copying a store string verbatim, and strict
// exact-match grounding denied every one of them). A slot marked
// `kind: "fact"` in templates.json (a whole-sentence reassurance/breakdown,
// never a code/price/slug) now gets three chances, in order:
//   1. exact match (same as before — still the common case for a model
//      that DOES copy verbatim).
//   2. fuzzy match: the value shares a real NUMBER or a >=4-char keyword
//      with some grounded fact string (case/punctuation-insensitive) — a
//      paraphrase of a real fact still passes, an invented one still can't
//      (no grounded string shares any of its numbers/keywords).
//   3. autofill: if neither matches, the slot's declared `source` (a path
//      into `state`, e.g. "business.delivery", "offers[0]",
//      "product.fit_notes", "page.stock") is resolved directly and used
//      instead of the model's text — reported back as `autofilled` so
//      callers can mark the trace (`slot_autofilled:<name>`).
// A slot with no `kind` (or `kind !== "fact"`) keeps the original strict
// exact-match-only contract unchanged — codes/prices/slugs/sizes must
// still be copied verbatim, never paraphrased or autofilled.
function normalizeFactText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^\w\s.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function factTokens(s) {
  return normalizeFactText(s).split(" ").filter(Boolean);
}

/**
 * factFuzzyMatch(value, groundedValues) -> boolean — true if `value` shares
 * at least one real number token OR one >=4-char keyword token with ANY
 * string in `groundedValues` (the same Set collectGroundedValues() already
 * builds for exact matching).
 */
function factFuzzyMatch(value, groundedValues) {
  const valueTokens = factTokens(value);
  const numbers = new Set(valueTokens.filter((t) => /^\d+(\.\d+)?$/.test(t)));
  const keywords = new Set(valueTokens.filter((t) => t.length >= 4 && !/^\d+$/.test(t)));
  if (numbers.size === 0 && keywords.size === 0) return false;
  for (const g of groundedValues) {
    for (const t of factTokens(g)) {
      if (numbers.has(t) || keywords.has(t)) return true;
    }
  }
  return false;
}

/**
 * resolveFactSource(source, state) -> string | null — canonical fact text
 * for a `slots.<name>.source` declared in templates.json. Only a small,
 * known set of source paths is supported (deliberately not a generic JSON-
 * path evaluator — every source is merchant/template-authored, never model
 * input, so a hardcoded lookup is safer than an expression evaluator).
 */
function resolveFactSource(source, state) {
  if (!source || typeof source !== "string") return null;
  const currency = state?.business?.currency?.symbol ?? "৳";
  if (source === "business.delivery") {
    const d = state?.business?.delivery;
    if (!d) return null;
    if (d.free_over) return `Free delivery over ${currency}${d.free_over}`;
    if (d.days) return `Delivery in ${d.days} days`;
    return null;
  }
  if (source === "business.returns") {
    const r = state?.business?.returns;
    return r?.window_days ? `Returns accepted within ${r.window_days} days` : null;
  }
  if (source === "product.fit_notes") return state?.product?.fit_notes ?? null;
  if (source === "product.price") {
    const p = state?.product;
    return p?.price != null ? `${currency}${p.price}` : null;
  }
  if (source === "page.stock") return state?.page_context?.stock?.text ?? null;
  if (source === "page.delivery") return state?.page_context?.delivery?.text ?? null;
  const offerMatch = /^offers\[(\d+)\]$/.exec(source);
  if (offerMatch) {
    const offer = (state?.offers || [])[Number(offerMatch[1])];
    return offer?.label ?? null;
  }
  return null;
}

/**
 * renderCard(card, state) -> { ok: true, title, body } | { ok: false, reason }
 *
 * `card` is the ALREADY-shape-normalized card object (server/policy.js's
 * normalizeCard()) carrying `template` (string|null) and `slots`
 * (object|null). Does not touch `card.cta` at all — cta.value's realness
 * (a real slug/code/size) is validated downstream in policy.js's existing
 * checkViolation card guard, unchanged by templating.
 */
export function renderCard(card, state) {
  const templateId = typeof card?.template === "string" ? card.template.trim() : "";
  if (!templateId) return { ok: false, reason: "template id missing" };

  let templates;
  try {
    templates = loadTemplates();
  } catch (err) {
    return { ok: false, reason: `template store unreadable: ${err.message}` };
  }

  const tpl = templates[templateId];
  if (!tpl) return { ok: false, reason: `template unknown id "${templateId}"` };

  const slotsIn = card.slots && typeof card.slots === "object" ? card.slots : {};
  const grounded = collectGroundedValues(state);
  const slotSpecs = tpl.slots || {};
  const resolved = {};
  // {currency} is NOT a model-supplied slot — it's the site's own currency
  // symbol (server/store/currency.js), threaded through business.currency
  // by server/state.js/store/index.js. Resolved here, unconditionally,
  // exactly like a slot value, so every template body can say
  // "{currency}{saving}" instead of hardcoding ৳ (category fix — see
  // server/store/currency.js's header comment for the live finding this
  // closes). Defaults to ৳ only if state.business is entirely absent
  // (mirrors currency.js's own default store fallback).
  resolved.currency = state?.business?.currency?.symbol ?? "৳";

  const autofilled = [];
  for (const name of Object.keys(slotSpecs)) {
    const spec = slotSpecs[name] || {};
    const maxLen = Number.isFinite(spec.max_len) ? spec.max_len : DEFAULT_SLOT_MAX;
    const isFactSlot = spec.kind === "fact";
    const raw = slotsIn[name];
    const value = raw === undefined || raw === null ? "" : String(raw).trim();

    if (!isFactSlot) {
      // Unchanged strict contract: codes/prices/slugs/sizes/counts must be
      // copied verbatim from a real fact, never paraphrased or autofilled.
      if (!value) return { ok: false, reason: `template ${templateId} missing slot "${name}"` };
      if (value.length > maxLen) {
        return { ok: false, reason: `template ${templateId} slot "${name}" exceeds ${maxLen} chars` };
      }
      if (!grounded.has(value)) {
        return { ok: false, reason: `template ${templateId} slot "${name}" value not grounded in store facts` };
      }
      resolved[name] = value;
      continue;
    }

    // Fact slot: exact match, then fuzzy match, then autofill from the
    // template's declared `source`, then fail closed.
    if (value && value.length <= maxLen && grounded.has(value)) {
      resolved[name] = value;
      continue;
    }
    if (value && value.length <= maxLen && factFuzzyMatch(value, grounded)) {
      resolved[name] = value;
      continue;
    }
    const autofill = resolveFactSource(spec.source, state);
    if (autofill) {
      resolved[name] = String(autofill).trim().slice(0, maxLen);
      autofilled.push(name);
      continue;
    }
    return {
      ok: false,
      reason: value
        ? `template ${templateId} slot "${name}" not grounded (no matching fact, no fact source available)`
        : `template ${templateId} missing slot "${name}" (no fact source available)`,
    };
  }

  // Only placeholders the template itself declares (its own `slots` keys)
  // are ever interpolated — an extra {word} a model somehow slipped into a
  // skeleton string can't happen (skeletons are merchant-authored, read
  // from templates.json, never model input), but this stays defensive:
  // unknown placeholders are left literal rather than blowing up.
  //
  // Two placeholder forms:
  //   {name}              -> the resolved slot value, verbatim.
  //   {name|singular|plural} -> pick ONE of the two literal words based on
  //     whether Number(resolved[name]) === 1 (never the value itself) —
  //     grammar-fix category (live finding, NextCart session
  //     final_nc_1219732343: "Found 3 match" instead of "3 matches"). A
  //     merchant-authored skeleton, not model text, so this is a fixed
  //     two-way choice, never free interpolation.
  const fill = (skeleton) =>
    String(skeleton).replace(/\{(\w+)(?:\|([^|}]*)\|([^}]*))?\}/g, (whole, name, singular, plural) => {
      if (!Object.prototype.hasOwnProperty.call(resolved, name)) return whole;
      if (singular !== undefined) {
        const n = Number(resolved[name]);
        return Number.isFinite(n) && n === 1 ? singular : plural;
      }
      return resolved[name];
    });

  const title = fill(tpl.title);
  const body = fill(tpl.body);

  if (title.length > TITLE_MAX) {
    return { ok: false, reason: `template ${templateId} rendered title exceeds ${TITLE_MAX} chars` };
  }
  if (body.length > BODY_MAX) {
    return { ok: false, reason: `template ${templateId} rendered body exceeds ${BODY_MAX} chars` };
  }

  return { ok: true, title, body, autofilled };
}

/** listTemplateIds() -> string[] — used by tooling/docs, not the hot path. */
export function listTemplateIds() {
  return Object.keys(loadTemplates());
}

/**
 * anchorChain(templateId) -> string[] | null — the template's ordered
 * fallback-target chain (`anchor` in templates.json: [natural target_hint,
 * ...fallbacks], e.g. `["promo-code", "cart-link", "search",
 * "agent-banner"]`), or null when the template declares none (`size_help`
 * has none on purpose — see server/policy.js's anchor-fallback comment:
 * `pick_size` needs the shopper to actually be on the size picker, so
 * there's no safe fallback target to redirect it to).
 *
 * Used by server/policy.js's applyPolicy() (category (b) fix, live finding
 * session final_tm_242431): a card grounded by an `offers[]` entry whose
 * `target_hint` isn't currently visible (missed_discount/delivery_gap/etc.
 * on a browsing page that never renders `promo-code`/`shipping-banner`) is
 * no longer structurally impossible — policy.js rewrites `action.target` to
 * the first entry of this chain that IS in the shopper's current visible
 * targets, instead of failing the "target not in visibleTargets" guard.
 */
export function anchorChain(templateId) {
  let templates;
  try {
    templates = loadTemplates();
  } catch {
    return null;
  }
  const tpl = templates[templateId];
  const chain = tpl?.anchor;
  return Array.isArray(chain) && chain.every((t) => typeof t === "string" && t) ? chain : null;
}
