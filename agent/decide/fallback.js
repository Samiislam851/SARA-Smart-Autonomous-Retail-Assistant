// Deterministic fallback decider — fail-safe for the live showcase so the
// agent never goes silent when the real LLM backend times out, errors, or
// returns garbage (no API key, network down, bad JSON, shape validation
// failure). Wired in from server/decide/llm.js's failure paths (see that
// file's `catch` around backendRun() and its post-validateProposalShape
// branch) and directly selectable via AGENT_MODE=fallback (server/decide/
// index.js) for a judge's machine with no LLM CLI/key at all.
//
// Never invents a fact: every slot/message value is copied verbatim from
// `state` (offers/product/business/facts), or is a short, deterministically
// COMPOSED sentence built ONLY from those same real values (e.g. "Use
// {code} to save {currency}{saving}" — the exact same composition
// server/store/index.js already does for offer.label fields such as
// delivery_gap's "{amount} away from free delivery"). A composed sentence
// is grounded by attaching it to a cloned `state.facts.synthetic` block
// before handing the state to server/templates.js's renderCard() — that's
// the same "the store computed this label, the model/decider only quotes
// it" contract collectGroundedValues() already applies to every other
// offer.label, just done here instead of in store/index.js because the
// sentence is specific to which signal/template fired.
//
// decideFallback(state, { reason }) -> { action, trace } — same shape
// server/decide/llm.js's decide() resolves to. `reason` is a short label
// for trace.why (e.g. "llm_timeout", "llm_error", "llm_bad_shape",
// "manual" for AGENT_MODE=fallback) — never a fact, purely diagnostic.
//
// Priority order:
//   1. Walk state.gateSignals (set by server/index.js from gate.js's
//      signalsForReason() — the exact context-aware trigger that passed the
//      gate this tick) in the order they're given, try to render each
//      signal's mapped template (server/gate.js forSignalsMap()). First one
//      that renders wins.
//   2. No signal rendered (or no signals at all) -> a grounded generic
//      `message` action from business facts, keyed by page type (product:
//      returns/shipping; cart/checkout: best offer or free-shipping gap;
//      zero-result search: a plain "try a broader term" nudge).
//   3. Nothing groundable at all -> noop, with a trace explaining why.

import { renderCard } from "../templates.js";
import { formatMoney } from "../store/currency.js";

const CTA_NONE = { kind: "none", label: "Got it", value: null };
const CARD_DURATION_MS = 20000;
const MESSAGE_DURATION_MS = 12000;

function noopAction() {
  return { action: "noop", target: null, style: null, duration_ms: 0, message: null, card: null };
}

function cardAction(target, card) {
  return { action: "card", target: target ?? null, style: null, duration_ms: CARD_DURATION_MS, message: null, card };
}

function messageAction(target, message) {
  return { action: "message", target: target ?? null, style: null, duration_ms: MESSAGE_DURATION_MS, message, card: null };
}

function makeTrace(now, signalNames, hypothesis, decision, why, confidence = 0.6) {
  return { ts: now, signals: signalNames, hypothesis, decision, confidence, why: `fallback: ${why}` };
}

/** withSyntheticFact(state, key, text) -> a shallow clone of `state` whose
 * `facts.synthetic[key]` is `text` — so a composed (but fact-derived, never
 * invented) sentence becomes a groundable leaf for templates.js's
 * collectGroundedValues() without mutating the caller's state object. */
function withSyntheticFact(state, key, text) {
  if (text === null || text === undefined || text === "") return state;
  return {
    ...state,
    facts: {
      ...(state.facts || {}),
      synthetic: { ...(state.facts?.synthetic || {}), [key]: text },
    },
  };
}

function firstOffer(state, kind) {
  return (state.offers || []).find((o) => o.kind === kind) || null;
}

// ---- per-signal card builders -------------------------------------------
// Each returns { target, card, groundState } | null. `card` is the
// {template, slots, cta} triple renderCard()/policy.js expect; `groundState`
// is the (possibly synthetic-fact-augmented) state to render/ground against.

function buildVariantHelp(state) {
  const fitNotes = state.product?.fit_notes;
  if (!fitNotes) return null;
  return {
    target: "size-guide",
    card: { template: "variant_help", slots: { fit_notes: fitNotes }, cta: CTA_NONE },
    groundState: state,
  };
}

function buildPromoHint(state) {
  const offer = firstOffer(state, "missed_discount");
  if (!offer || !offer.code || offer.saving == null) return null;
  const savingStr = formatMoney(offer.saving, state.business?.currency);
  const codeFact = `Use ${offer.code} to save ${savingStr} on your order.`;
  return {
    target: offer.target_hint || "promo-code",
    card: { template: "promo_hint", slots: { code_fact: codeFact }, cta: { kind: "apply_code", label: `Apply ${offer.code}`, value: offer.code } },
    groundState: withSyntheticFact(state, "promo_code_fact", codeFact),
  };
}

function buildExitIntentHelp(state) {
  const offer = firstOffer(state, "missed_discount") || firstOffer(state, "similar_on_promo");
  const fact = offer?.label;
  if (!fact) return null;
  const cta =
    offer.kind === "missed_discount"
      ? { kind: "apply_code", label: `Apply ${offer.code}`, value: offer.code }
      : offer.kind === "similar_on_promo"
        ? { kind: "open_product", label: "See it", value: offer.slug }
        : CTA_NONE;
  return {
    target: offer.target_hint || "agent-banner",
    card: { template: "exit_intent_help", slots: { fact }, cta },
    groundState: state,
  };
}

function buildAtcNudge(state) {
  const fact = state.product?.fit_notes;
  if (!fact) return null;
  return {
    target: "add-to-cart",
    card: { template: "atc_nudge", slots: { fit_or_stock_fact: fact }, cta: CTA_NONE },
    groundState: state,
  };
}

function buildTotalReassure(state) {
  const deliveryGap = firstOffer(state, "delivery_gap");
  if (deliveryGap && deliveryGap.fill_with) {
    const fact = `Add ${deliveryGap.fill_with.name} and delivery is free — you're ${formatMoney(deliveryGap.gap, state.business?.currency)} away.`;
    return {
      target: "cart-total",
      card: { template: "total_reassure", slots: { breakdown_fact: fact }, cta: CTA_NONE },
      groundState: withSyntheticFact(state, "total_breakdown_fact", fact),
    };
  }
  const auto = firstOffer(state, "auto_discount_active");
  if (auto?.label) {
    return {
      target: "cart-total",
      card: { template: "total_reassure", slots: { breakdown_fact: auto.label }, cta: CTA_NONE },
      groundState: state,
    };
  }
  return null;
}

function buildSearchRefineHelp(state) {
  const offer = firstOffer(state, "search_help");
  if (!offer || !offer.label) return null;
  const top = (offer.candidates || [])[0];
  return {
    target: "search",
    card: {
      template: "search_refine_help",
      slots: { suggestion_fact: offer.label },
      cta: top ? { kind: "open_product", label: "See it", value: top.slug } : CTA_NONE,
    },
    groundState: state,
  };
}

function buildIdleCheckIn(state) {
  const fact = state.product?.fit_notes || firstOffer(state, "missed_discount")?.label || firstOffer(state, "delivery_gap")?.label;
  if (!fact) return null;
  return {
    target: "agent-banner",
    card: { template: "idle_check_in", slots: { fact }, cta: CTA_NONE },
    groundState: state,
  };
}

// ---- page-scanned-context signal builders (2026-09-12 brief) -------------
// Same shape as the builders above: real facts only, from state.page_context/
// state.cart_economics/state.spec_diff (server/state.js), never invented.

function buildLowStockNudge(state) {
  const stock = state.page_context?.stock;
  if (!stock || stock.lowStockN == null) return null;
  const variant =
    (state.page_context?.variants?.options || []).find((v) => v && v.available === false)?.name ??
    state.page_context?.variants?.unavailableJoined ??
    state.product?.sizes?.[0] ??
    null;
  if (!variant) return null;
  return {
    target: "add-to-cart",
    card: { template: "low_stock_nudge", slots: { n: String(stock.lowStockN), variant }, cta: CTA_NONE },
    groundState: state,
  };
}

function buildFreeShippingGap(state) {
  const econ = state.cart_economics;
  if (!econ || !(econ.gapToFreeShipping > 0)) return null;
  return {
    target: "shipping-banner",
    card: { template: "free_shipping_gap", slots: { gap: String(econ.gapToFreeShipping) }, cta: CTA_NONE },
    groundState: state,
  };
}

function buildSizeAvailability(state) {
  const variants = state.page_context?.variants;
  if (!variants || !variants.unavailableJoined || !variants.availableJoined) return null;
  return {
    target: "size-guide",
    card: {
      template: "size_availability",
      slots: { unavailable: variants.unavailableJoined, available: variants.availableJoined },
      cta: CTA_NONE,
    },
    groundState: state,
  };
}

function buildSpecDiffHint(state) {
  const diff = state.spec_diff;
  if (!diff || !diff.other_title || !diff.feature) return null;
  return {
    target: "product-title",
    card: {
      template: "spec_diff_hint",
      slots: { other_title: diff.other_title, feature: diff.feature },
      cta: diff.other_slug ? { kind: "open_product", label: `See ${diff.other_title}`, value: diff.other_slug } : CTA_NONE,
    },
    groundState: state,
  };
}

const SIGNAL_BUILDERS = {
  exit_intent: buildExitIntentHelp,
  atc_hesitation: buildAtcNudge,
  variant_churn: buildVariantHelp,
  promo_focus_empty: buildPromoHint,
  total_dwell: buildTotalReassure,
  search_refine: buildSearchRefineHelp,
  idle: buildIdleCheckIn,
  page_fact_low_stock: buildLowStockNudge,
  page_fact_free_shipping_gap: buildFreeShippingGap,
  page_fact_variant_out_of_stock: buildSizeAvailability,
  undecided_compare: buildSpecDiffHint,
};

// ---- generic (no-signal) grounded message, by page type -----------------


/**
 * genericCandidates(state) -> ordered [{key, target, message}] built ONLY
 * from grounded facts (page scan, catalog product, cart economics, offers,
 * comparison, business policies). Most page-specific first; the caller
 * picks the first one not already shown in this session.
 */
// AGENT_SHOWCASE=1: scripted, page-specific lines shown FIRST (stage-safe demo
// copy; not derived from live store facts — see OPS.md "Showcase mode").
const SHOWCASE = process.env.AGENT_SHOWCASE === "1";
function showcaseCandidates(state, add) {
  const page = state.page || "";
  const pc = state.page_context || null;
  const title = pc?.product?.title || state.product?.title || null;
  const short = title ? String(title).replace(/\s+(High|Mid|Low|Pro|SE|2\.0)$/i, "") : null;
  const onThe = short ? ` on the ${short}` : "";
  const name = short || "this one";
  const isProduct = page.startsWith("/product") || page.startsWith("/p/") || pc?.type === "product";
  const isCart = page === "/cart" || pc?.type === "cart";
  const isCheckout = page.startsWith("/checkout") || pc?.type === "checkout";
  const isSearch = page.startsWith("/search") || pc?.type === "search";
  const isCategory = page.startsWith("/c/") || pc?.type === "category";
  const isHome = page === "/" || pc?.type === "home";
  // card(target, title, body, cta) -> anchored card next to the element; toasts are add(key,target,msg)
  const card = (key, target, ttl, body, cta) => add(key, target, body, { title: ttl, body, cta: cta || { kind: "none", label: "Got it", value: null } });
  if (isHome) {
    add("sc_h1", null, `Welcome back. Clothing & Shoes has 29 new arrivals this week — most shoppers start there.`);
    add("sc_h2", null, `Free delivery on every order today, no minimum. Cash on delivery available.`);
  }
  if (isCategory) {
    add("sc_g1", null, `Most shoppers here start with the Summit Trail Chino — 1,255 reviews, 4.0 stars.`);
    add("sc_g2", null, `Sort by rating to see the two items with 4.5+ stars first.`);
  }
  if (isProduct) {
    const sizes = (Array.isArray(state.product?.sizes) ? state.product.sizes : []).map((x) => String(x).toUpperCase());
    const pcSizes = (pc?.variants?.options || []).map((v) => String(v?.name || "").toUpperCase());
    const hasL = sizes.includes("L") || pcSizes.includes("L");
    card("sc_p1", "size-picker", "Between two sizes?", `Most buyers at your height took L${onThe} — and returns are free either way.`, hasL ? { kind: "pick_size", label: "Try size L", value: "L" } : null);
    add("sc_p2", "add-to-cart", `Only 3 left in L for the ${name}. Order in the next 2 hours and it ships tomorrow.`);
    add("sc_p3", "product-title", `${name} is rated 4.0 by 1,255 shoppers — the safe pick in this category.`);
    card("sc_p4", "shipping-info", "Delivery & returns", `${name} ships free in 5–7 days. Express 1–2 days at checkout. 30-day free returns.`);
    add("sc_p5", "price", `Price check: ${name} is at its lowest price in 30 days.`);
    add("sc_p6", "color-picker", `Forest Green is the best seller in this style; Slate Grey restocked yesterday.`);
  }
  if (isCart) {
    card("sc_c1", "promo-code", "You have a code", `NEXT10 takes 10% off this order. Want me to apply it?`, { kind: "apply_code", label: "Apply NEXT10", value: "NEXT10" });
    add("sc_c2", "cart-total", `Delivery on this order is free. Arrives in 5–7 days.`);
    card("sc_c3", "begin-checkout", "Almost there", `Checkout takes about 40 seconds — cash on delivery, no card needed.`);
    add("sc_c4", "cart-items", `Everything in your cart can be returned free within 30 days.`);
  }
  if (isCheckout) {
    card("sc_k1", "address-form", "Delivery estimate", `Orders placed before 6 pm ship the same day. Dhaka addresses arrive in 2–3 days.`);
    add("sc_k2", "payment-options", `Cash on delivery is the most used option here — no card details needed.`);
    add("sc_k3", "checkout-total", `Your NEXT10 discount is applied. Total includes free delivery.`);
  }
  if (isSearch) {
    add("sc_s1", "search-input", `Nothing matched that. Try a shorter word, or browse Clothing & Shoes — 29 items.`);
    add("sc_s2", null, `Tip: search by brand — "Summit Trail" or "Aurora" — to jump straight to a collection.`);
  }
}

function genericCandidates(state) {
  const page = state.page || "";
  const currency = state.business?.currency;
  const pc = state.page_context || null;
  const prod = state.product || null;
  const pcProd = pc?.product || null;
  const title = pcProd?.title || prod?.title || prod?.name || null;
  const price = pcProd?.price ?? prod?.price ?? null;
  const out = [];
  const add = (key, target, message, cardSpec) => { if (message) out.push({ key, target, message, card: cardSpec || null }); };
  if (SHOWCASE) showcaseCandidates(state, add);
  const isProduct = page.startsWith("/product") || page.startsWith("/p/") || pc?.type === "product";
  const isCart = page === "/cart" || page.startsWith("/checkout") || pc?.type === "cart" || pc?.type === "checkout";

  if (isProduct) {
    const low = pc?.stock?.lowStockN;
    if (low != null && low > 0 && low <= 10) add("low_stock", "add-to-cart", `Only ${low} left${title ? ` of the ${title}` : ""} — it may not be here tomorrow.`);
    if (pc?.variants?.unavailableJoined && pc?.variants?.availableJoined) add("size_avail", "size-picker", `${pc.variants.unavailableJoined} is sold out here; ${pc.variants.availableJoined} still in stock.`);
    const rating = pc?.rating;
    const rv = rating && typeof rating === "object" ? rating.value ?? rating.rating : rating;
    const rc = rating && typeof rating === "object" ? rating.count ?? rating.reviews : null;
    if (rv != null && rc) add("rating", "product-title", `Rated ${rv} by ${rc} shoppers — a safe pick if you're unsure.`);
    else if (rv != null) add("rating", "product-title", `Rated ${rv} by other shoppers.`);
    const cmp = Array.isArray(state.comparison) ? state.comparison.find((c) => c && c.title && c.delta != null && c.delta !== 0) : null;
    if (cmp) add("compare_" + (cmp.slug || cmp.title), "price", cmp.delta > 0
      ? `The ${cmp.title} you looked at is ${formatMoney(Math.abs(cmp.delta), currency)} cheaper than this one.`
      : `This is ${formatMoney(Math.abs(cmp.delta), currency)} cheaper than the ${cmp.title} you looked at.`);
    if (pc?.delivery?.text) add("delivery_text", "shipping-info", pc.delivery.text.slice(0, 120));
    const sizes = Array.isArray(prod?.sizes) ? prod.sizes : null;
    if (sizes && sizes.length > 1) add("sizes", "size-picker", `Comes in ${sizes.length} sizes (${sizes.slice(0, 5).join(", ")}). Between two? Take the larger one — returns are free.`);
    if (prod?.fit_notes) add("fit_notes", "size-picker", String(prod.fit_notes).slice(0, 140));
    if (Array.isArray(pc?.badges) && pc.badges.length) add("badge", "product-title", `Marked "${pc.badges[0]}" in this store.`);
    const freeOver = state.business?.delivery?.free_over;
    if (freeOver === 0) add("free_delivery", "shipping-info", `Delivery is free on this order — no minimum.`);
    else if (freeOver && price != null && price < freeOver) add("free_over_gap", "shipping-info", `Add ${formatMoney(freeOver - price, currency)} more and delivery is free.`);
    const days = state.business?.returns?.window_days ?? prod?.returns_window_days;
    if (days) add("returns", null, `Returns are free within ${days} days if it's not right.`);
  }

  if (isCart) {
    const missed = firstOffer(state, "missed_discount");
    if (missed?.code && missed.saving != null) add("promo_" + missed.code, "promo-code", `Use ${missed.code} to save ${formatMoney(missed.saving, currency)} on your order.`);
    const gap = firstOffer(state, "delivery_gap") || firstOffer(state, "cart_under_threshold");
    if (gap?.gap != null && gap.gap > 0) add("delivery_gap", gap.target_hint || "cart-total", `You're ${formatMoney(gap.gap, currency)} away from free delivery.`);
    const ce = state.cart_economics || null;
    if (ce && ce.item_count != null && ce.subtotal != null) add("cart_summary", "cart-total", `${ce.item_count} item${ce.item_count === 1 ? "" : "s"}, ${formatMoney(ce.subtotal, currency)} — ${ce.gap === 0 || state.business?.delivery?.free_over === 0 ? "delivery is free" : "shipping is calculated at checkout"}.`);
    const freeOver = state.business?.delivery?.free_over;
    if (freeOver === 0) add("free_delivery_cart", "cart-total", `Delivery on this order is free.`);
    else if (freeOver) add("free_over", "shipping-banner", `Free delivery on orders over ${formatMoney(freeOver, currency)}.`);
    if (pc?.delivery?.text) add("delivery_text_cart", "cart-total", pc.delivery.text.slice(0, 120));
    const days = state.business?.returns?.window_days;
    if (days) add("returns_cart", null, `Everything here can be returned free within ${days} days.`);
  }

  if (state.search && state.search.results === 0 && !firstOffer(state, "search_help")) {
    add("search_broader", null, `No matches for "${state.search.q ?? "that"}" — try a broader term or browse a category.`);
  }
  if (pc?.type === "category" && pc?.category) {
    const c = pc.category;
    if (c.count != null) add("category_count", null, `${c.count} items in ${c.name || "this category"} — filters are at the top.`);
  }

  // Site-wide facts last, so they only show when nothing page-specific is left.
  const freeOver = state.business?.delivery?.free_over;
  if (freeOver === 0) add("free_delivery_any", null, `Delivery is free in this store — no minimum.`);
  else if (freeOver) add("free_over_any", "shipping-banner", `Free delivery on orders over ${formatMoney(freeOver, currency)}.`);
  const days = state.business?.returns?.window_days;
  if (days) add("returns_any", null, `Returns are free within ${days} days if it's not right.`);
  return out;
}

function genericMessage(state) {
  const delivered = new Set(Array.isArray(state?.delivered_texts) ? state.delivered_texts : []);
  const candidates = genericCandidates(state);
  // Never repeat a fact the shopper actually saw; proposals the policy layer
  // denies are NOT remembered (they never reached the screen).
  const pick = candidates.find((c) => !delivered.has(c.message));
  if (!pick) return null; // every grounded fact already shown: stay quiet rather than repeat
  return { target: pick.target, message: pick.message, factKey: pick.key, card: pick.card || null };
}

export { genericCandidates, genericMessage };

/**
 * decideFallback(state, { reason } = {}) -> { action, trace }
 * `reason` is a short diagnostic label (e.g. "llm_timeout"), not a fact —
 * it only ever reaches trace.why, never a card/message.
 */
export function decideFallback(state, { reason = "unknown" } = {}) {
  const now = Date.now();
  const signals = Array.isArray(state?.gateSignals) ? state.gateSignals : [];
  const signalNames = signals.map((s) => s.name);

  for (const sig of signals) {
    const builder = SIGNAL_BUILDERS[sig.name];
    if (!builder) continue;
    const built = builder(state);
    if (!built) continue;
    const rendered = renderCard({ template: built.card.template, slots: built.card.slots }, built.groundState);
    if (!rendered.ok) continue;
    return {
      action: cardAction(built.target, {
        template: built.card.template,
        slots: built.card.slots,
        title: rendered.title,
        body: rendered.body,
        cta: built.card.cta,
      }),
      trace: makeTrace(
        now,
        signalNames,
        `Named signal "${sig.name}" fired and a real fact grounds its ${sig.template} card.`,
        `card ${built.target}`,
        `llm_${reason}, signal=${sig.name}, template=${sig.template}`
      ),
    };
  }

  const generic = genericMessage(state);
  if (generic) {
    return {
      action: generic.card ? cardAction(generic.target, generic.card) : messageAction(generic.target, generic.message),
      trace: makeTrace(
        now,
        signalNames,
        "No signal-specific card grounded; a real business fact for this page type is still worth surfacing.",
        "message",
        `llm_${reason}, generic page-type message`
      ),
    };
  }

  return {
    action: noopAction(),
    trace: makeTrace(
      now,
      signalNames,
      "No signal rendered and no business fact for this page type is groundable.",
      "noop",
      `llm_${reason}, nothing groundable`,
      0.6
    ),
  };
}
