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
  return values;
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

  for (const name of Object.keys(slotSpecs)) {
    const spec = slotSpecs[name] || {};
    const raw = slotsIn[name];
    if (raw === undefined || raw === null || raw === "") {
      return { ok: false, reason: `template ${templateId} missing slot "${name}"` };
    }
    const value = String(raw).trim();
    const maxLen = Number.isFinite(spec.max_len) ? spec.max_len : DEFAULT_SLOT_MAX;
    if (value.length > maxLen) {
      return { ok: false, reason: `template ${templateId} slot "${name}" exceeds ${maxLen} chars` };
    }
    if (!grounded.has(value)) {
      return { ok: false, reason: `template ${templateId} slot "${name}" value not grounded in store facts` };
    }
    resolved[name] = value;
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

  return { ok: true, title, body };
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
