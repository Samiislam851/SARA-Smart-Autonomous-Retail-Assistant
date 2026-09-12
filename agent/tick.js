// Decision trigger policy: when to actually call the decider vs. reuse the
// last trace as a quiet tick.
//
// Rewritten (see server/NOTES.md, "gate/tick reason over event counts, not
// state/time windows" defect class): the old rule was "any non-dwell event
// is always a class change; a dwell event is a class change only if its own
// subject's dwell bucket moved". That treated e.g. every back_nav or search
// as automatically worth a decider call regardless of whether it actually
// represented NEW friction, and it never looked at anything except the
// single subject the triggering dwell event named.
//
// shouldCallDecider(session, event, state) now calls the decider when ANY of:
//   1. `event` is a page_view of a path never seen before this session.
//   2. `event` is a cart_view/cart_update and the cart total actually changed
//      since the last one (session.lastCartTotal).
//   3. `event` is a per-ELEMENT dwell (not page-level — see
//      isPageDwellTarget) whose accumulated attention crossed a
//      bucketAttention() boundary (3/5/10/20s) since the last dwell on that
//      same target — tracked in session.lastDwellBuckets, same field name/
//      per-subject-map shape as before (index.js still resets it to {} on
//      every page_view; see server/state.js's session-shape doc and
//      server/state.test.js (iv), which this rewrite must keep passing).
//   4. any of gate.js's twelve friction signals (computeSignals(), shared
//      with gate.js so the two modules can't drift on what a signal means —
//      the original eight rules 1-8 plus rules 9-12, the shopper-pattern
//      signals added 2026-09-12: product ping-pong, breadth-without-commit,
//      cart-visit-and-leave, return-to-product-after-cart) newly flipped
//      false -> true since the last time this function ran, tracked in
//      session.lastSignalFlags.
// Anything else — a page-level dwell heartbeat that doesn't move any of the
// above, a repeat page_view of an already-seen path with no new attention,
// scroll_depth, etc — is a quiet tick.
//
// Both this module and gate.js are pure functions of (state, session, now):
// no globals, no wall-clock reads other than `now` (derived from the
// triggering event's own `ts`, falling back to Date.now() only when absent).
// The `session.lastDwellBuckets` / `lastCartTotal` / `lastSignalFlags` writes
// are the same kind of session-scoped memoization the old code already used
// for `lastDwellBuckets` — not hidden global state.

import { bucketAttention, isPageDwellTarget } from "./buckets.js";
import { computeSignals, consultFloorCheck, pageMomentCheck } from "./gate.js";
import { getSensitivityMultiplier } from "./policy-config.js"; // AGENT_SENSITIVITY: "demo" shrinks bucketAttention's boundaries so a dwell-bucket crossing (and thus a decider call) happens sooner

const M = getSensitivityMultiplier();

/**
 * shouldCallDecider(session, event, state) → boolean
 * `state` is this event's buildState(session) output (already reflects the
 * just-pushed event).
 */
export function shouldCallDecider(session, event, state) {
  const now = event?.ts ?? Date.now();

  // Every check below updates its own session-scoped bookkeeping
  // UNCONDITIONALLY (even when an earlier check already found a reason to
  // call the decider) — otherwise an early `return true` would skip
  // updating e.g. `lastSignalFlags`, and the NEXT call would wrongly see
  // "no baseline" and treat an already-true flag as newly true again.

  // 1. First-ever page_view of this path this session is always worth a look.
  let pageViewTrigger = false;
  if (event.type === "page_view") {
    const seenBefore = session.events
      .slice(0, -1)
      .some((e) => e.type === "page_view" && e.target === event.target);
    pageViewTrigger = !seenBefore;
  }

  // 2. Cart total actually changed (adding/removing an item, quantity
  // change) — distinct from "cart friction" flipping true/false below,
  // since e.g. a cart moving from ৳1,950 to ৳2,050 crosses the free-delivery
  // threshold (friction -> not-friction) without ever going false->true.
  let cartTotalTrigger = false;
  if (event.type === "cart_view" || event.type === "cart_update") {
    const total = state.cart?.total ?? null;
    const prevTotal = session.lastCartTotal;
    session.lastCartTotal = total;
    cartTotalTrigger = prevTotal === undefined || prevTotal !== total;
  }

  // 3. Per-element attention crossed a bucket boundary. Page-level dwell
  // heartbeats (isPageDwellTarget) are intentionally NOT bucketed here —
  // page dwell alone is never a signal (see prompts/decide.md) so bucketing
  // it would just cause periodic decider calls for no new information.
  let dwellBucketTrigger = false;
  if (event.type === "dwell" && !isPageDwellTarget(event.target, state.page)) {
    if (!session.lastDwellBuckets) session.lastDwellBuckets = {};
    const ms = state.dwell?.perTarget?.[event.target] ?? 0;
    const bucket = bucketAttention(ms, M);
    dwellBucketTrigger = session.lastDwellBuckets[event.target] !== bucket;
    session.lastDwellBuckets[event.target] = bucket;
  }

  // 4. Any of the eight friction signals newly turned true since the last
  // check (covers rage_click, back_nav, bounce patterns, search friction,
  // cart-threshold friction, and element-attention/return-visit for events
  // that didn't already trigger above, e.g. a return page_view with
  // existing attention already on the page).
  const sig = computeSignals(state, session, now);
  const flags = {
    elementAttention: sig.elementAttention,
    returnVisit: sig.returnVisit,
    navFriction: sig.navFriction,
    rageClick: sig.rageClick,
    cartFriction: sig.cartFriction.hit,
    searchFriction: sig.searchFriction.hit,
    // Store-offer-driven signals (server/store/index.js) — see gate.js's
    // promoMissedSignal/similarPromoSignal for what "newly true" means here.
    promoMissed: sig.promoMissed.hit,
    similarPromo: sig.similarPromo.hit,
    // Shopper-pattern signals (gate.js rules 9-12) — a real browsing session
    // trips these well before dwell buckets or the older signals do; see
    // server/NOTES.md, "pre-model layers tuned for scripted hover" defect.
    pingPong: sig.pingPong.hit,
    breadthNoCommit: sig.breadthNoCommit.hit,
    cartLeave: sig.cartLeave.hit,
    returnAfterCart: sig.returnAfterCart.hit,
  };
  const prevFlags = session.lastSignalFlags || {};
  const flagTrigger = Object.keys(flags).some((k) => flags[k] && !prevFlags[k]);
  session.lastSignalFlags = flags;

  // 5. Consult floor: an active shopper who hasn't tripped any signal above
  // (rules 1-4) for AGENT_CONSULT_FLOOR_MS still gets a periodic look — see
  // server/NOTES.md, "model only consulted on signal edges, no floor" defect
  // (live 2026-09-12, session you_2: 47 events/31 decisions/0 model calls).
  // 6. Page moment: a page_view landing on product/cart/checkout once the
  // shopper has >=2 prior page views this session. Both predicates live in
  // gate.js (consultFloorCheck/pageMomentCheck) — shared with gate.js's own
  // hard-guard-then-bypass logic in gate() so the two modules can't drift on
  // when a floor/page-moment call is "worth it", same principle as
  // computeSignals() already being shared above.
  const floorTrigger = consultFloorCheck(state, session, event, now).hit;
  const pageMomentTrigger = pageMomentCheck(state, session, event, now).hit;

  return (
    pageViewTrigger || cartTotalTrigger || dwellBucketTrigger || flagTrigger || floorTrigger || pageMomentTrigger
  );
}
