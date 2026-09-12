// Rule stand-in for the LLM loop. Pure: no cooldown/already-acted logic here —
// that's policy.js's job. This just proposes.

import { summarize } from "../state.js";
import { isPageDwellTarget } from "../buckets.js";
import { computeSignals } from "../gate.js";

// Test-only artificial latency: AGENT_STUB_DELAY_MS (default 0, no delay,
// zero behavior change for real usage) makes decide() resolve after a fixed
// delay instead of returning synchronously — used by
// server/coalesce.test.js to simulate a slow (llm-speed) decider under
// AGENT_MODE=stub without needing a real model call, so the coalescing
// scheduler in index.js can be exercised deterministically. When 0, decide()
// stays fully synchronous (no Promise wrapper at all) exactly as before.
const AGENT_STUB_DELAY_MS = Number(process.env.AGENT_STUB_DELAY_MS) || 0;

const NO_CARD = null;

function noop(now, signals) {
  return {
    action: { action: "noop", target: null, style: null, duration_ms: 0, message: null, card: NO_CARD },
    trace: {
      ts: now, signals,
      hypothesis: "Shopper is browsing normally.",
      decision: "noop",
      confidence: 0.8,
      why: "No friction signal strong enough to justify stepping in.",
    },
  };
}

/**
 * decide(state, session) → { action, trace } | Promise<{ action, trace }>
 * Four deterministic rules, one per fixture, each proposing a `card` — the
 * one-tap action — rather than a highlight/message: sizing hesitation
 * (pick_size), an unapplied promo code (apply_code), a similar item on
 * promo (open_product), and a near-miss free-delivery gap (add_to_cart, the
 * item that closes it). See server/prompts/decide.md's "Actions" section
 * for the same recipes written for the real LLM decider.
 *
 * per-element-dwell-is-viewport-time defect class: sizing-hesitation keys
 * off the CURRENT event being an ELEMENT-level dwell (target is a specific
 * element, not the page itself — see isPageDwellTarget) with attention >=
 * 6000ms, not page-level dwell alone (page dwell alone is never
 * hesitation). Threshold is 6000ms, not 5000ms (S4 pass): the client-side
 * scroll-into-view one-shot credit (SCROLL_CREDIT_MS, web/components/
 * AgentWidget.tsx / server/public/agent.js) caps attention granted from mere
 * visibility at 5000ms — keeping the stub's own threshold at exactly
 * 5000ms would tie the "reader below the fold, never touched, credit-capped
 * at 5s" case right up against the firing threshold, a margin not a
 * coincidence, keeps reader-below-fold.json a reliable noop fixture instead
 * of a flaky one.
 */
export function decide(state, session) {
  const result = decideNow(state, session);
  if (AGENT_STUB_DELAY_MS > 0) {
    return new Promise((resolve) => setTimeout(() => resolve(result), AGENT_STUB_DELAY_MS));
  }
  return result;
}

function decideNow(state, session) {
  const now = Date.now();
  const signals = summarize(session.events);
  const lastEvent = session.events[session.events.length - 1];
  const isElementDwell = lastEvent?.type === "dwell" && !isPageDwellTarget(lastEvent.target, state.page);
  const elementDwellMs = isElementDwell ? (state.dwell.perTarget?.[lastEvent.target] ?? 0) : 0;
  const wantsHelp = isElementDwell && elementDwellMs >= 6000;

  // ---- sizing-hesitation: fit note + returns window, cta pick_size -------
  if (wantsHelp) {
    const sizeHelp = (state.offers || []).find((o) => o.kind === "size_help");
    const sizes = sizeHelp?.sizes ?? state.product?.sizes ?? [];
    const fitNote = sizeHelp?.fit_notes ?? state.product?.fit_notes ?? null;
    const returnsDays = sizeHelp?.returns_window_days ?? state.business?.returns?.window_days ?? null;
    // The stub is deterministic and has to name ONE size to put on the cta
    // (policy.js's card guard requires a real value from state.product.sizes
    // for cta.kind "pick_size") — it picks the largest listed size, which
    // happens to match this catalog's own fit note ("take the larger"). A
    // real decider should reason from actual evidence (e.g. a previously
    // selected size) instead of copying this heuristic blindly.
    const suggestedSize = sizes.length > 0 ? sizes[sizes.length - 1] : null;
    const bodyParts = [fitNote, returnsDays ? `Returns are free within ${returnsDays} days if it's not right.` : null];

    return {
      action: {
        action: "card",
        target: "size-guide",
        style: null,
        duration_ms: 20000,
        message: null,
        card: {
          title: "Between sizes?",
          body: bodyParts.filter(Boolean).join(" "),
          cta: {
            kind: "pick_size",
            label: suggestedSize ? `Try size ${suggestedSize}` : "Pick a size",
            value: suggestedSize,
          },
        },
      },
      trace: {
        ts: now, signals,
        hypothesis: "Shopper is lingering on the product without moving toward the cart — likely unsure about fit.",
        decision: "card size-guide",
        confidence: 0.7,
        why: "Fit is the most common reason to stall on apparel; a pick-size card is one tap instead of more reading.",
      },
    };
  }

  // Store-offer rules (server/store/index.js) — deterministic stand-ins for
  // the store-knowledge fixtures. Mirror the same gating gate.js's
  // promoMissedSignal/similarPromoSignal/cartFrictionSignal use, so the
  // stub's behavior can't silently diverge from what actually let the tick
  // fire.
  const missedOffer = (state.offers || []).find((o) => o.kind === "missed_discount");
  const onCartFlow = state.page === "/cart" || state.page === "/checkout";
  const pageDwellMs = state.dwell?.pageMs ?? 0;
  if (
    missedOffer &&
    onCartFlow &&
    pageDwellMs >= 8000 &&
    state.visibleTargets.includes(missedOffer.target_hint)
  ) {
    const itemName = missedOffer.slug.replace(/-/g, " ");
    return {
      action: {
        action: "card",
        target: missedOffer.target_hint,
        style: null,
        duration_ms: 20000,
        message: null,
        card: {
          title: "You have a code",
          body: `Use ${missedOffer.code} to save ৳${missedOffer.saving} on your ${itemName}.`,
          cta: { kind: "apply_code", label: `Apply ${missedOffer.code}`, value: missedOffer.code },
        },
      },
      trace: {
        ts: now, signals,
        hypothesis: "Shopper is sitting on the cart/checkout flow with an unapplied discount code still on the table.",
        decision: `card ${missedOffer.target_hint}`,
        confidence: 0.75,
        why: "A cart item has an active code the shopper hasn't entered; a one-tap apply removes the friction of typing it.",
      },
    };
  }

  const similarOffer = (state.offers || []).find((o) => o.kind === "similar_on_promo");
  if (similarOffer && state.visibleTargets.includes(similarOffer.target_hint)) {
    const sig = computeSignals(state, session, now);
    if (sig.elementAttention || sig.returnVisit) {
      const simName = similarOffer.slug.replace(/-/g, " ");
      return {
        action: {
          action: "card",
          target: similarOffer.target_hint,
          style: null,
          duration_ms: 20000,
          message: null,
          card: {
            title: "Something on promo",
            body: `The ${simName} in the same collection is ৳${similarOffer.saving} off if you want a look.`,
            cta: { kind: "open_product", label: "See it", value: similarOffer.slug },
          },
        },
        trace: {
          ts: now, signals,
          hypothesis: "Shopper keeps returning to this product, which isn't the one currently on promo.",
          decision: `card ${similarOffer.target_hint}`,
          confidence: 0.65,
          why: "Repeated attention on this product plus a promo on a similar item is a low-friction cross-sell.",
        },
      };
    }
  }

  // ---- cart-threshold / delivery_gap: add the item that closes the gap --
  const deliveryGap = (state.offers || []).find((o) => o.kind === "delivery_gap");
  if (deliveryGap && deliveryGap.fill_with && state.visibleTargets.includes(deliveryGap.target_hint)) {
    const sig = computeSignals(state, session, now);
    if (sig.cartFriction?.hit) {
      const fill = deliveryGap.fill_with;
      const promoNote = fill.promo ? `, ${fill.promo.label}` : "";
      return {
        action: {
          action: "card",
          target: deliveryGap.target_hint,
          style: null,
          duration_ms: 20000,
          message: null,
          card: {
            title: "Add for free delivery",
            body: `Add the ${fill.name} (৳${fill.price}${promoNote}) and delivery is free — you're ৳${deliveryGap.gap} away.`,
            cta: { kind: "add_to_cart", label: `Add ${fill.name}`, value: fill.slug },
          },
        },
        trace: {
          ts: now, signals,
          hypothesis: "Cart is just under the free-delivery threshold and the shopper is hesitating on the cart/checkout flow.",
          decision: `card ${deliveryGap.target_hint}`,
          confidence: 0.7,
          why: "Naming the exact item that closes the gap is more useful than just stating the ৳ shortfall.",
        },
      };
    }
  }

  return noop(now, signals);
}
