// Stale-response guard — category: a decision computed against a SNAPSHOT
// of the shopper's session (page, product, cart) 10-20s ago (real LLM
// latency) must never be delivered against a session that has since moved
// on. server/policy.js's Guard A (currentVisibleTargets/currentPage) only
// re-checks target liveness; this module closes the rest of that same
// stale-snapshot surface: the product page swapped, the cart contents
// changed, or the shopper's attention moved to a different part of the
// flow entirely, all while the decider call was in flight.
//
// Re-derives everything from session.events directly, the same
// scan-backward-for-the-latest-X idiom Guard A already uses — never
// buildState()'s full store/offer recompute (this runs on every non-noop
// decision, so it stays cheap and has no store-load side effects of its
// own beyond the one catalog lookup liveProduct() needs).

import { productSlugFromPage, loadStore } from "./store/index.js";

// ≥N new hesitation-class events landing on a DIFFERENT target than the one
// this decision is about, while the decider was thinking, counts as "moved
// on" even without a page change — e.g. size-guide hesitation genuinely
// replaced by heavy attention on a totally different element. Configurable
// for tests/tuning; falls back to 3 on anything missing/invalid.
const DEFAULT_MOVED_ON_EVENTS = 3;
function movedOnThreshold() {
  const raw = Number(process.env.AGENT_STALE_MOVED_ON_EVENTS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MOVED_ON_EVENTS;
}

/** "hesitation-class" event, for the moved_on(N-events) check: a rage click,
 * or an attention-kind dwell (hover/focus/tap/scroll-into-view — see
 * state.js's dwell.perTargetEvidence doc). Page-level dwell heartbeats and
 * plain scroll_depth are not hesitation signals on their own. */
function isHesitationEvent(e) {
  if (!e) return false;
  if (e.type === "rage_click") return true;
  if (e.type === "dwell" && e.meta?.kind === "attention") return true;
  return false;
}

/** liveCurrentPage(session) -> string|null — the shopper's CURRENT page
 * path, re-derived from the latest page_view in session.events. Kept
 * independent of policy.js's own (unexported) currentPage() to avoid an
 * import cycle (policy.js imports this module for classifyStaleContext/
 * liveProduct); same rule either way. */
export function liveCurrentPage(session) {
  const events = session?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "page_view") return events[i].target ?? null;
  }
  return null;
}

function liveCart(session) {
  const events = session?.events ?? [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "cart_view" || e.type === "cart_update") {
      return { items: Array.isArray(e.meta?.items) ? e.meta.items : [], promo: e.meta?.promo ?? null };
    }
  }
  return null;
}

/** cartHash({items, promo}) -> string — ids+qty (sorted, order-independent)
 * plus the applied promo code, collapsed to one comparable string. `null`
 * cart (no cart_view/cart_update event yet) hashes to a fixed sentinel so
 * "no cart" never spuriously differs from another "no cart" snapshot. */
function cartHash(cart) {
  if (!cart) return "none";
  const items = Array.isArray(cart.items) ? cart.items : [];
  const key = items
    .map((it) => `${it.sku ?? it.slug ?? it.name ?? "?"}x${it.qty ?? it.quantity ?? 1}`)
    .sort()
    .join("|");
  return `${key}::${cart.promo?.code ?? "none"}`;
}

/**
 * liveProduct(session, store) -> {slug, name, price, sizes, fit_notes} |
 * null — the CURRENT product page's catalog entry, re-derived from the
 * session's LIVE latest page_view (never a caller-supplied snapshot).
 * `null` means either no page_view yet (fresh session) or the live page
 * isn't a product page — callers apply the same "no opinion, don't deny"
 * carve-out Guard A uses for an empty liveTargets when there's no live
 * page_view at all (see server/policy.js's pick_size guard).
 */
export function liveProduct(session, store = loadStore()) {
  const page = liveCurrentPage(session);
  // store (the session's OWN site's catalog/routes), not DEFAULT_ROUTES —
  // same per-site product-route fix as server/store/index.js's own
  // productSlugFromPage() doc comment (NextCart's `/p/<slug>` route).
  const slug = productSlugFromPage(page, store);
  if (!slug) return null;
  const entry = (store.catalog || []).find((p) => p.slug === slug);
  if (!entry) return null;
  return {
    slug: entry.slug,
    name: entry.name,
    price: entry.price,
    sizes: Array.isArray(entry.sizes) ? entry.sizes.slice() : [],
    fit_notes: entry.fit_notes ?? null,
  };
}

/**
 * computeContextFingerprint(session) -> {page, productSlug, cartHash,
 * lastEventId, lastEventTs}. Captured by index.js's decideAndBroadcast()
 * right before the decide() call (the moment the decision starts being
 * computed against "now"). `lastEventId` is session.events.length at
 * capture time — events are only ever appended or ring-shifted, never
 * mutated, so any growth by the time this is re-derived means new signal
 * arrived while the decider was thinking; `lastEventTs` is
 * session.lastEventAt (server receive time, not client-controlled — see
 * state.js's pushEvent() comment) as a second, cheap "anything changed at
 * all" check.
 */
export function computeContextFingerprint(session) {
  const page = liveCurrentPage(session);
  const store = loadStore(session?.site);
  return {
    page,
    productSlug: productSlugFromPage(page, store),
    cartHash: cartHash(liveCart(session)),
    lastEventId: session?.events?.length ?? 0,
    lastEventTs: session?.lastEventAt ?? 0,
  };
}

/**
 * classifyStaleContext(fingerprint, session, actionTarget) -> null (still
 * "same" — deliver) | { klass, reason }, klass one of "product_changed" |
 * "cart_changed" | "moved_on", reason the exact `stale_context:<klass>`
 * string server/policy.js denies the action with.
 *
 * `fingerprint` null-safe: a caller that never captured one (e.g. an older
 * test, or a call site that doesn't wire opts.contextFingerprint) gets no
 * opinion (null) — same "missing context = don't deny" carve-out Guard A
 * uses for an empty liveTargets. Precedence (most specific drift first):
 * product_changed > cart_changed > moved_on(page) > moved_on(attention).
 */
export function classifyStaleContext(fingerprint, session, actionTarget) {
  if (!fingerprint) return null;

  const live = computeContextFingerprint(session);

  if (live.lastEventId === fingerprint.lastEventId && live.lastEventTs === fingerprint.lastEventTs) {
    return null; // nothing happened since capture — cheap exit, definitely "same"
  }

  if (live.productSlug !== fingerprint.productSlug) {
    return { klass: "product_changed", reason: "stale_context:product_changed" };
  }
  if (live.cartHash !== fingerprint.cartHash) {
    return { klass: "cart_changed", reason: "stale_context:cart_changed" };
  }
  if (live.page !== fingerprint.page) {
    return { klass: "moved_on", reason: "stale_context:moved_on" };
  }

  // Same page/product/cart — did ATTENTION move elsewhere while the
  // decider was thinking? Only look at events that actually arrived since
  // capture (new events are always appended at the tail, even across a
  // ring-buffer shift, so events.slice(-newCount) is correct regardless of
  // whether older entries got shifted out in the meantime).
  const events = session?.events ?? [];
  const newCount = Math.min(events.length, Math.max(0, live.lastEventId - fingerprint.lastEventId));
  const newEvents = newCount > 0 ? events.slice(events.length - newCount) : [];
  let hesitationElsewhere = 0;
  for (const e of newEvents) {
    if (!isHesitationEvent(e)) continue;
    if (actionTarget != null && e.target === actionTarget) continue;
    hesitationElsewhere++;
  }
  if (hesitationElsewhere >= movedOnThreshold()) {
    return { klass: "moved_on", reason: "stale_context:moved_on" };
  }

  return null;
}
