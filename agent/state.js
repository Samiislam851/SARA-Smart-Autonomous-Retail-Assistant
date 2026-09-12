// Session store + buildState(). buildState() output is tomorrow's LLM input.

import { isPageDwellTarget } from "./buckets.js";
import * as metrics from "./metrics.js";
import { loadStore, computeOffers, businessBlock, productSlugFromPage, classifyPath } from "./store/index.js";
import { log } from "./log.js";
import { getSensitivityMultiplier } from "./policy-config.js";

const RING_SIZE = 200;

// Model-facing state size budget (server/NOTES.md "shopper narrative, not
// raw event tails" defect class) — logged via stateBytes below, same
// LOG_LEVEL=debug idiom as buildState()'s existing "business block size"
// log. Not enforced (never drops fields), just observable.
const STATE_SIZE_BUDGET_BYTES = 2500;

// journey.visits / recent are both capped to their last N entries for size —
// see buildJourney()/buildRecent() below.
const MAX_JOURNEY_VISITS = 12;
const MAX_RECENT_EVENTS = 12;
const MAX_FOCUS_TARGETS = 6;
const FOCUS_NOW_WINDOW_MS = 10000;

// AGENT_SENSITIVITY multiplier (server/policy-config.js) — reused here ONLY
// for breadthNoCommit's product-count floor, same formula gate.js's own
// BREADTH_MIN_PRODUCTS uses, so a merchant's "demo" sensitivity setting
// flips this pattern at the same shopper-breadth as it flips gate.js's own
// decision-triggering signal, instead of the two silently drifting apart.
const M = getSensitivityMultiplier();
const BREADTH_MIN_PRODUCTS = Math.max(2, Math.round(3 * M));

/** session id → Session */
const sessions = new Map();

/**
 * Session shape:
 * { events: Event[], lastInterventionAt: number, actedTargets: Set<string>,
 *   lastDeciderAt: number, lastTrace: Trace | null,
 *   lastDwellBuckets: { [subject: string]: string } — "__page__" or a
 *   target name -> its last-seen dwell bucket, tracked independently per
 *   subject (see tick.js), lastEventAt: number — ts of the most recent
 *   pushEvent(), used by evictLRUSessions() for AGENT_MAX_SESSIONS LRU
 *   eviction (index.js), nudgeCount: number — non-noop actions delivered so
 *   far, enforced against AGENT_MAX_NUDGES_PER_SESSION by policy.js }
 */
export function sessionCount() {
  return sessions.size;
}

export function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, {
      id,
      events: [],
      lastInterventionAt: 0,
      lastInterventionTarget: null,
      actedTargets: new Set(),
      lastDeciderAt: 0,
      lastTrace: null,
      lastDwellBuckets: {},
      lastEventAt: Date.now(),
      // Count of non-noop actions ever delivered to this session — the
      // merchant-configurable AGENT_MAX_NUDGES_PER_SESSION budget in
      // policy.js reads/increments this. See server/POLICY.md.
      nudgeCount: 0,
      // Which merchant store this session belongs to (agent.js's data-site
      // / cfg.site, sent as page_view meta.site — see pushEvent() below and
      // server/store/sites.js). "" until the first page_view arrives; an
      // empty/absent site loads the default store (loadStore()'s own
      // default), same as before multi-site support existed.
      site: "",
    });
  }
  return sessions.get(id);
}

/** peekSession(id) → Session | undefined — never creates. */
export function peekSession(id) {
  return sessions.get(id);
}

/**
 * resetSession(id) → true if a session existed and was deleted, false
 * otherwise. Wipes ALL per-session state tracked in this module (events,
 * actedTargets, lastInterventionAt/Target, dwell buckets, lastDeciderAt/
 * lastTrace) in one shot by dropping the Map entry — getSession() will
 * lazily recreate a fresh session record on the next event. Used by the
 * dev-only DELETE /session/:id route (index.js) to let a fixture replay be
 * retaken without restarting the server. Callers are responsible for
 * tearing down anything session-keyed OUTSIDE this module (sockets,
 * decide/llm.js's in-flight guard, index.js's own per-session maps), same
 * contract as evictLRUSessions().
 */
export function resetSession(id) {
  return sessions.delete(id);
}

export function pushEvent(session, event) {
  session.events.push(event);
  if (session.events.length > RING_SIZE) session.events.shift();
  // A session is pinned to whichever site its LATEST page_view.meta.site
  // names (a non-empty string only — an older client / a page that never
  // sends it stays on whatever this session was already pinned to, default
  // "" on a brand new session). Sticky across page_views that omit it,
  // rather than resetting to default, so a same-visit navigation on a site
  // whose pages don't all carry the attribute doesn't silently flip the
  // agent back to the wrong store mid-session.
  if (event.type === "page_view" && typeof event.meta?.site === "string" && event.meta.site) {
    session.site = event.meta.site;
  }
  // Server receive time, not the client-supplied event.ts — event.ts is
  // attacker/clock-controllable input (a client can backdate or future-date
  // it), and this field drives evictLRUSessions()'s LRU ordering. Using
  // client-controlled input for eviction ordering lets a client keep its own
  // session artificially "fresh" (or force another session to look stale)
  // by choosing ts values, independent of actual traffic recency.
  session.lastEventAt = Date.now();
}

/**
 * evictLRUSessions(max) → array of evicted session ids, removed from the
 * store, oldest lastEventAt first — only when the store exceeds `max`
 * entries. Used by index.js's AGENT_MAX_SESSIONS backpressure guard; callers
 * are responsible for tearing down anything session-keyed outside this
 * module (e.g. index.js's sockets map).
 */
export function evictLRUSessions(max) {
  if (sessions.size <= max) return [];
  const excess = sessions.size - max;
  const byAge = [...sessions.entries()].sort(
    (a, b) => (a[1].lastEventAt ?? 0) - (b[1].lastEventAt ?? 0)
  );
  const evicted = [];
  for (let i = 0; i < excess; i++) {
    const [id] = byAge[i];
    sessions.delete(id);
    evicted.push(id);
  }
  return evicted;
}

/**
 * summarize(events) → last 6 events as short strings for the decider's
 * `recent` log and traces.
 *
 * Element-level dwell (target is not the page path) whose meta carries
 * `kind: "attention"` (see web/components/AgentWidget.tsx / server/public/
 * agent.js — per-element-dwell-is-viewport-time defect class) renders as
 * "attention <target> <n>s (<evidence>)", e.g.
 * "attention size-guide 21s (hover 15s, 2 clicks)", so the evidence behind
 * the number travels with it instead of looking identical to page dwell.
 * Page-level dwell, and any element dwell without `kind` (shouldn't happen
 * from an up-to-date client, but tolerated), keeps the old plain format.
 */
export function summarize(events) {
  return events.slice(-6).map((e) => {
    if (e.type === "dwell") {
      const ms = Math.round((e.meta?.ms ?? 0) / 1000);
      if (e.meta?.kind === "attention") {
        const it = e.meta?.interactions || {};
        const parts = [];
        if (it.hover_ms) parts.push(`hover ${Math.round(it.hover_ms / 1000)}s`);
        if (it.focus_ms) parts.push(`focus ${Math.round(it.focus_ms / 1000)}s`);
        if (it.clicks) parts.push(`${it.clicks} click${it.clicks === 1 ? "" : "s"}`);
        if (it.scrolled_to) parts.push("scrolled to");
        const suffix = parts.length ? ` (${parts.join(", ")})` : "";
        return `attention ${e.target} ${ms}s${suffix}`;
      }
      return `dwell ${e.target} ${ms}s`;
    }
    return `${e.type} ${e.target ?? ""}`.trim();
  });
}

// FACTS_MODE (env, default "both") — server-side switch on which half of
// page_view.meta.facts reaches the model, independent of the page's own
// data-facts attribute. "off" drops facts entirely from buildState().
const FACTS_MODE = process.env.FACTS_MODE || "both";

function filterFacts(facts) {
  if (!facts || FACTS_MODE === "off") return null;
  const out = {};
  if ((FACTS_MODE === "keys" || FACTS_MODE === "both") && facts.keys) out.keys = facts.keys;
  if ((FACTS_MODE === "snippets" || FACTS_MODE === "both") && facts.snippets) out.snippets = facts.snippets;
  return Object.keys(out).length ? out : null;
}

/** catalogName(store, slug) → product name, or null if slug isn't a known
 * product in this store's catalog (or store failed to load). */
function catalogName(store, slug) {
  if (!slug || !store) return null;
  const entry = (store.catalog || []).find((p) => p.slug === slug);
  return entry ? entry.name : null;
}

/** labelForPath(store, path) → a human-readable label for a journey/focus
 * entry's page: the catalog product name for a /product/<slug> path (falls
 * back to the raw path if the slug isn't in the catalog), the path itself
 * otherwise. */
function labelForPath(store, path) {
  if (!path) return null;
  const slug = productSlugFromPage(path, store);
  if (slug) return catalogName(store, slug) ?? path;
  return path;
}

/**
 * fallbackPathFromDwell(events) → the most recent page-level dwell event's
 * target, or null. Only meaningful when NOT ONE page_view has ever arrived
 * for this session (buildState() calls this only in that case) — e.g. a
 * session that survived a server restart (in-memory session.events wiped,
 * see state.js module comment / server/NOTES.md) and has been getting
 * nothing but dwell heartbeats since. isPageDwellTarget(target, null)
 * already treats any "/"-prefixed target as page-level regardless of a
 * known page, which is exactly the signal we want here: the widget always
 * sends dwell with target = page path for page-level dwell, even when the
 * server has no page_view to corroborate it.
 */
function fallbackPathFromDwell(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "dwell" && isPageDwellTarget(e.target, null) && e.target) return e.target;
  }
  return null;
}

/**
 * buildJourney(events, store, now) → { visits, pagesVisited, distinctProducts,
 * returnsToSameProduct, cartVisits, checkoutReached, sessionSeconds }.
 *
 * `visits` collapses consecutive page_views of the SAME path into one entry
 * (a page re-rendering its own data-agent-target set, e.g. a modal opening,
 * is not a new visit) — same collapse rule research-routes.js's own
 * pageList() uses for the /sessions list "pages" column, so this journey
 * and that summary never disagree about what counts as one visit. Each
 * visit's `seconds` is wall-clock time until the NEXT visit starts (or,
 * for the last visit, until the session's last event) — not dwell-derived,
 * so it's never zero just because a page emitted no dwell before the
 * shopper navigated away. `addedToCart` is true when a cart_update with
 * target "cart-add" (the web widget's own contract, see gate.js's
 * breadthNoCommitSignal) landed inside that visit's time range.
 *
 * Aggregate counts (pagesVisited, distinctProducts, returnsToSameProduct,
 * cartVisits, checkoutReached) are computed over the FULL visit history for
 * this session, even though the `visits` array itself is truncated to the
 * last MAX_JOURNEY_VISITS for size (see buildState()) — losing the running
 * totals to a size cap would make "3rd time back on this product" silently
 * turn into "1st time" once the array rolls over.
 */
function buildJourney(events, store, now) {
  const pageViews = events.filter((e) => e.type === "page_view");
  const visits = [];
  for (const e of pageViews) {
    const path = e.target ?? null;
    const prev = visits[visits.length - 1];
    if (prev && prev.path === path) continue; // collapse consecutive same-path page_views
    visits.push({ path, startTs: e.ts ?? now });
  }

  const lastEventTs = events.length ? events[events.length - 1].ts ?? now : now;
  const cartAdds = events.filter((e) => e.type === "cart_update" && e.target === "cart-add");

  const fullVisits = visits.map((v, i) => {
    const endTs = i + 1 < visits.length ? visits[i + 1].startTs : lastEventTs;
    const addedToCart = cartAdds.some((c) => (c.ts ?? now) >= v.startTs && (c.ts ?? now) < endTs);
    return {
      path: v.path,
      label: labelForPath(store, v.path),
      seconds: Math.max(0, Math.round((endTs - v.startTs) / 1000)),
      addedToCart,
      leftTo: i + 1 < visits.length ? visits[i + 1].path : null,
    };
  });

  const seenProducts = new Set();
  let returnsToSameProduct = 0;
  const distinctProducts = new Set();
  for (const v of fullVisits) {
    const slug = productSlugFromPage(v.path, store);
    if (!slug) continue;
    distinctProducts.add(slug);
    if (seenProducts.has(slug)) returnsToSameProduct++;
    seenProducts.add(slug);
  }

  const firstEventTs = events.length ? events[0].ts ?? now : now;

  // cartVisits/checkoutReached: routes-aware (server/store/index.js's
  // classifyPath(), per-site `routes.cart`/`routes.checkout` prefixes), not
  // a bare `=== "/cart"`/`=== "/checkout"` literal — a hardcoded exact match
  // silently missed NextCart's `/checkout/address` sub-route (live finding,
  // session final_nc_1219732343: checkoutReached stayed false despite real
  // checkout visits).
  return {
    visits: fullVisits.slice(-MAX_JOURNEY_VISITS),
    pagesVisited: fullVisits.length,
    distinctProducts: distinctProducts.size,
    returnsToSameProduct,
    cartVisits: fullVisits.filter((v) => classifyPath(v.path, store) === "cart").length,
    checkoutReached: fullVisits.some((v) => classifyPath(v.path, store) === "checkout"),
    sessionSeconds: Math.max(0, Math.round((lastEventTs - firstEventTs) / 1000)),
    _all: fullVisits, // internal only — stripped before returning from buildState(), used by buildPatterns()
  };
}

/**
 * buildFocus(events, store, now) → { top: focus[], focusNow }.
 *
 * A focus entry tracks one element-level dwell TARGET (never the page
 * itself — page-level dwell is dwell.pageMs, unchanged) across the whole
 * session, keyed by target: {target, label, seconds, hovers, clicks, page}.
 * `seconds` is the target's LATEST reported ms (dwell ms is cumulative
 * within a visit, same convention dwell.perTarget already relies on), so a
 * target dwelt on across several visits keeps growing rather than
 * resetting. `hovers` counts attention-dwell HEARTBEATS recorded for this
 * target (a proxy for "kept coming back to it" — the client only ever sends
 * cumulative hover_ms/focus_ms, never a discrete hover-start/hover-end
 * event, so a literal hover count isn't available). `clicks` is the latest
 * (cumulative) interactions.clicks. `page` is the page path the target was
 * last dwelt on under.
 *
 * `focusNow`: the target of the most recent ELEMENT-level dwell event, only
 * if it landed within the last FOCUS_NOW_WINDOW_MS — null once the trail's
 * gone cold (the shopper moved attention elsewhere, or the tab's been idle).
 */
function buildFocus(events, store, now) {
  let currentPath = null;
  const byTarget = new Map();
  let lastElementDwell = null;

  for (const e of events) {
    if (e.type === "page_view") {
      currentPath = e.target ?? null;
      continue;
    }
    if (e.type !== "dwell") continue;
    if (isPageDwellTarget(e.target, currentPath)) continue; // page-level, not a focus target
    const ms = e.meta?.ms ?? 0;
    const it = e.meta?.interactions || {};
    const prev = byTarget.get(e.target) || { hovers: 0 };
    byTarget.set(e.target, {
      target: e.target,
      page: currentPath,
      seconds: Math.round(ms / 1000),
      hovers: prev.hovers + (it.hover_ms > 0 ? 1 : 0),
      clicks: it.clicks ?? 0,
    });
    lastElementDwell = e;
  }

  const top = [...byTarget.values()]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, MAX_FOCUS_TARGETS)
    .map((f) => ({ ...f, label: labelForPath(store, f.page) }));

  const focusNow =
    lastElementDwell && now - (lastElementDwell.ts ?? now) <= FOCUS_NOW_WINDOW_MS
      ? lastElementDwell.target
      : null;

  return { top, focusNow };
}

/**
 * buildPatterns({visits, focusTop, events}) → named booleans, one source of
 * truth for "does this session's shape match a known shopper pattern" that
 * gate.js's own windowed rules (pingPongSignal, breadthNoCommitSignal,
 * cartLeaveSignal, returnAfterCartSignal — server/gate.js rules 9-12) can
 * migrate to import from later, rather than keeping two copies of "what
 * counts as ping-pong" that can silently drift apart. Deliberately
 * SESSION-WIDE (no now-relative time window) — these are for the shopper
 * NARRATIVE the model reads, not a decision-triggering signal; gate.js's
 * own windowed versions remain the authority for "should THIS tick act".
 */
function buildPatterns({ visits, focusTop, events, store }) {
  const productVisitCounts = new Map();
  for (const v of visits) {
    const slug = productSlugFromPage(v.path, store);
    if (slug) productVisitCounts.set(slug, (productVisitCounts.get(slug) ?? 0) + 1);
  }
  const pingPong = [...productVisitCounts.values()].some((c) => c >= 2);
  const hasAddedToCart = visits.some((v) => v.addedToCart);
  const breadthNoCommit = productVisitCounts.size >= BREADTH_MIN_PRODUCTS && !hasAddedToCart;

  // cart/checkout classification below is routes-aware (classifyPath()),
  // not a bare `=== "/cart"`/`=== "/checkout"` literal — see the
  // productSlugFromPage()/classifyPath() doc comments in
  // server/store/index.js for the per-site route-prefix defect class this
  // closes (NextCart's `/checkout/address` sub-route, `/p/<slug>` products).
  let lastCartIdx = -1;
  visits.forEach((v, i) => {
    if (classifyPath(v.path, store) === "cart") lastCartIdx = i;
  });
  const cartVisitedThenLeft =
    lastCartIdx !== -1 &&
    lastCartIdx + 1 < visits.length &&
    classifyPath(visits[lastCartIdx + 1].path, store) !== "checkout";

  let returnedAfterCart = false;
  if (lastCartIdx !== -1) {
    const before = new Set(
      visits.slice(0, lastCartIdx).map((v) => productSlugFromPage(v.path, store)).filter(Boolean)
    );
    for (let i = lastCartIdx + 1; i < visits.length; i++) {
      const slug = productSlugFromPage(visits[i].path, store);
      if (slug && before.has(slug)) {
        returnedAfterCart = true;
        break;
      }
    }
  }

  const sizeHesitation = focusTop.some((f) => /^size-/.test(f.target) && f.seconds >= 3);
  const searches = events.filter((e) => e.type === "search");
  const promoHunting =
    focusTop.some((f) => /^promo/.test(f.target) && f.seconds >= 3) ||
    searches.some((s) => /promo|code|discount/i.test(s.meta?.q ?? ""));

  let searchStruggle = searches.some((s) => s.meta?.results === 0);
  if (!searchStruggle) {
    const seen = new Map();
    for (const s of searches) {
      const q = String(s.meta?.q ?? "").trim().toLowerCase();
      if (!q) continue;
      const count = (seen.get(q) ?? 0) + 1;
      seen.set(q, count);
      if (count >= 2) {
        searchStruggle = true;
        break;
      }
    }
  }

  const rageClicks = events.some((e) => e.type === "rage_click");

  // checkoutBounce — the shopper reached /checkout at some point in this
  // session and then WALKED AWAY to somewhere that is neither /checkout nor
  // /cart (a login wall, back to home/shop/a product) without a later
  // /checkout re-visit ending the story. This is the "4-minute real
  // journey, 0 interventions" defect class (live finding, session
  // final_tm_242431): checkout->login->checkout->login->/shop is a real,
  // actionable moment, but with no dedicated pattern flag the model had
  // nothing pre-computed to check and talked itself into noop every time.
  // See prompts/decide.md's `checkout_bounce` recipe. Deliberately EXCLUDES
  // a bounce back to /cart specifically — checkout->cart is its own,
  // already-modeled friction shape (`cartVisitedThenLeft`/the existing
  // "delivery gap over generic promo, on checkout->cart friction" priority
  // rule below), and treating it as checkoutBounce too caused a real
  // regression (server/sessions/gap-over-promo.json started firing
  // `checkout_bounce` instead of the intended `delivery_gap` card, since
  // checkout->cart trivially satisfied the broader "left checkout"
  // definition first drafted here).
  let lastCheckoutIdx = -1;
  visits.forEach((v, i) => {
    if (classifyPath(v.path, store) === "checkout") lastCheckoutIdx = i;
  });
  const checkoutBounce =
    lastCheckoutIdx !== -1 &&
    lastCheckoutIdx + 1 < visits.length &&
    !["checkout", "cart"].includes(classifyPath(visits[lastCheckoutIdx + 1].path, store));

  const lastVisit = visits[visits.length - 1];
  return {
    pingPong,
    breadthNoCommit,
    cartVisitedThenLeft,
    returnedAfterCart,
    sizeHesitation,
    promoHunting,
    searchStruggle,
    rageClicks,
    checkoutStall: Boolean(lastVisit && classifyPath(lastVisit.path, store) === "checkout" && lastVisit.seconds >= 15),
    checkoutBounce,
  };
}

/** describeCartUpdate(e) → a short human line for a cart_update event. */
function describeCartUpdate(e) {
  if (e.target === "cart-add") {
    const items = Array.isArray(e.meta?.items) ? e.meta.items : [];
    const added = items[items.length - 1]?.name;
    return added ? `added to cart: ${added}` : "added to cart";
  }
  const total = e.meta?.total;
  return total != null ? `cart updated (৳${total})` : "cart updated";
}

/**
 * buildRecent(events, store, now) → last MAX_RECENT_EVENTS MEANINGFUL
 * events as human-readable, relative-time-stamped strings — never a
 * heartbeat dwell tick (server/NOTES.md "dwell heartbeats flood the recent
 * window" defect class: a 335s page dwell resends the SAME heartbeat every
 * few seconds, and 20 near-identical "dwell /product/x {ms:335000}" lines
 * told the model nothing a shopper's own actions did).
 *
 * "Meaningful": every page_view (collapsed against the immediately
 * preceding one, same rule buildJourney() uses), every cart_update/
 * cart_view/search/back_nav/rage_click, and the FIRST element-attention
 * dwell seen for a given target since the last page_view — a shopper's
 * attention landing on something new is a real event; the heartbeats that
 * follow reporting the same growing number are not. scroll_depth and
 * agent_outcome are never included here (agent_outcome is never pushed
 * into session.events at all — see contracts.js).
 */
function buildRecent(events, store, now) {
  const out = [];
  let lastPageViewTarget = undefined; // undefined = "no page_view seen yet"
  let seenThisVisit = new Set();

  for (const e of events) {
    const ts = e.ts ?? now;
    if (e.type === "page_view") {
      seenThisVisit = new Set();
      const path = e.target ?? null;
      if (path === lastPageViewTarget) continue; // collapse consecutive dup page_views
      lastPageViewTarget = path;
      out.push({ ts, line: `viewed ${labelForPath(store, path) ?? "page"}` });
    } else if (e.type === "dwell") {
      if (isPageDwellTarget(e.target, lastPageViewTarget ?? null)) continue; // never a page-level heartbeat
      if (seenThisVisit.has(e.target)) continue; // only the FIRST attention crossing per target per visit
      seenThisVisit.add(e.target);
      const seconds = Math.round((e.meta?.ms ?? 0) / 1000);
      out.push({ ts, line: `focused on ${e.target} (${seconds}s)` });
    } else if (e.type === "cart_update") {
      out.push({ ts, line: describeCartUpdate(e) });
    } else if (e.type === "cart_view") {
      const total = e.meta?.total;
      out.push({ ts, line: total != null ? `viewed cart (৳${total})` : "viewed cart" });
    } else if (e.type === "search") {
      const q = e.meta?.q ?? "";
      const results = e.meta?.results;
      out.push({ ts, line: `searched "${q}"${results !== undefined ? ` (${results} results)` : ""}` });
    } else if (e.type === "back_nav") {
      out.push({ ts, line: `navigated back${e.target ? ` to ${e.target}` : ""}` });
    } else if (e.type === "rage_click") {
      const count = e.meta?.count;
      out.push({ ts, line: `rage-clicked ${e.target ?? "page"}${count ? ` (${count}x)` : ""}` });
    }
    // scroll_depth, agent_outcome: never meaningful here.
  }

  return out.slice(-MAX_RECENT_EVENTS).map((o) => `${o.line} (${Math.max(0, Math.round((now - o.ts) / 1000))}s ago)`);
}

/**
 * buildState(session) → plain JSON object, the LLM's input tomorrow.
 * {
 *   page, visibleTargets, cart: {total, items} | null,
 *   promo: {code, discount} | null — latest cart_view/cart_update
 *     meta.promo (see web contract; missing meta.promo is treated as null).
 *   search: {q, results} | null — latest search event's query and the
 *     store's result count for it (results is undefined, not 0, when a
 *     client hasn't started sending it — see search_help offer above).
 *   facts: { keys?: {...}, snippets?: [...] } | null — latest
 *     page_view.meta.facts, filtered by FACTS_MODE (env, default "both").
 *   business: { delivery, returns, payment } | null — the merchant's own
 *     policies (server/store/policies.json via businessBlock()); null only
 *     if the store failed to load. This is the merchant's CURRENT policy —
 *     the model should quote it, never assume ৳2,000/free delivery or any
 *     other number that belongs here.
 *   offers: offer[] — computed store facts (server/store/index.js
 *     computeOffers()): missed_discount, auto_discount_active,
 *     similar_on_promo, delivery_gap, size_help. Empty array (never
 *     omitted) when the store has nothing relevant, or failed to load.
 *   product: {slug, name, price, sizes, fit_notes} | null — the CURRENT
 *     product page's catalog entry (server/store/catalog.json), null off a
 *     product page. server/policy.js's card guard validates a pick_size
 *     cta.value against `product.sizes`. Resolved from `page` when there is
 *     one; when there's been no page_view AT ALL this session (see
 *     needsResnapshot below), resolved instead from the last page-level
 *     dwell event's target (fallbackPathFromDwell()) — the shopper's page
 *     snapshot is missing, but the widget's own dwell heartbeats still say
 *     what PATH it's on, and a size-picker card off that is more useful
 *     than none.
 *   needsResnapshot: boolean — true when this session has events but has
 *     NEVER seen a page_view (typically: the server restarted and lost this
 *     session's in-memory events — see state.js's module comment; the
 *     widget keeps sending dwell heartbeats but only re-sends page_view on
 *     its own next route change). visibleTargets and `journey` will be
 *     thin/empty in this state; not wired to any widget behavior yet.
 *   journey: { visits, pagesVisited, distinctProducts, returnsToSameProduct,
 *     cartVisits, checkoutReached, sessionSeconds } — the shopper's page-
 *     level story for this session (server/NOTES.md "raw event tails, not a
 *     shopper narrative" defect class). `visits` (each
 *     {path, label, seconds, addedToCart, leftTo}) collapses consecutive
 *     page_views of the same path and is capped to the last
 *     MAX_JOURNEY_VISITS; the aggregate counts alongside it are running
 *     totals over the WHOLE session, not just the truncated visits array.
 *   focus: { top: focus[], focusNow } — top MAX_FOCUS_TARGETS element-level
 *     attention targets by seconds ({target, label, seconds, hovers, clicks,
 *     page}, session-wide, unlike dwell.perTarget below which stays page-
 *     scoped for gate.js/tick.js's bucket math); focusNow is the target of
 *     the most recent attention-dwell if it landed within the last 10s, else
 *     null.
 *   patterns: named booleans (pingPong, breadthNoCommit, cartVisitedThenLeft,
 *     returnedAfterCart, sizeHesitation, promoHunting, searchStruggle,
 *     rageClicks, checkoutStall, checkoutBounce) — see buildPatterns()
 *     above for exact definitions; single source of truth gate.js's own
 *     windowed rules 9-12 may migrate to import from later. checkoutBounce
 *     (added 2026-09-12, live finding session final_tm_242431): the
 *     shopper reached /checkout and then WALKED AWAY (login wall, back to
 *     home/shop/a product) without a later /checkout visit — deliberately
 *     excludes a bounce back to /cart specifically, that's the existing
 *     `cartVisitedThenLeft`/delivery-gap-priority shape instead — see
 *     buildPatterns()'s own checkoutBounce comment and prompts/decide.md's
 *     `checkout_bounce` recipe.
 *   recent: string[] (last MAX_RECENT_EVENTS MEANINGFUL events — never a
 *     heartbeat dwell tick — as relative-time-stamped human-readable lines;
 *     see buildRecent() above),
 *   dwell: { pageMs, perTarget: {...}, perTargetEvidence: {...} },
 *   lastIntervention: {target, agoMs} | null
 * }
 *
 * dwell.perTarget[target] stays a plain ms NUMBER (gate.js/tick.js bucket
 * math depends on that) — for an up-to-date client that number is ATTENTION
 * time (hover/focus/tap/scroll-into-view), not viewport-visibility time; see
 * the per-element-dwell-is-viewport-time defect-class comments in
 * web/components/AgentWidget.tsx / server/public/agent.js. dwell.
 * perTargetEvidence[target] = { kind, interactions } surfaces the evidence
 * behind that number (only present for targets whose latest in-scope dwell
 * event carries meta.kind — a client too old to send it just won't have an
 * entry here, same page-scoping as perTarget above).
 */
export function buildState(session) {
  const events = session.events;

  let page = null;
  let visibleTargets = [];
  let facts = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "page_view") {
      page = events[i].target ?? null;
      if (Array.isArray(events[i].meta?.targets)) visibleTargets = events[i].meta.targets;
      facts = filterFacts(events[i].meta?.facts ?? null);
      break;
    }
  }

  let cart = null;
  let promo = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "cart_view" || e.type === "cart_update") {
      cart = { total: e.meta?.total ?? 0, items: e.meta?.items ?? [] };
      // meta.promo: { code, discount } | null — the web cart page's own
      // record of which code (if any) is currently applied. Missing entirely
      // (an older client, or a page that never sends the key) is treated the
      // same as null: "nothing applied", never "unknown" — computeOffers()'s
      // missed_discount check needs a definite answer, not a third state.
      promo = e.meta?.promo ?? null;
      break;
    }
  }

  // search: the shopper's most recent search box query — {q, results} |
  // null. `results` (a store-side result count) is optional client-side
  // input (see contracts.js META_SHAPES.search); when absent it stays
  // `undefined` here rather than a guessed 0, so computeOffers()'s
  // search_help offer (which requires results === 0 EXACTLY) never fires
  // off a client that hasn't started sending it yet. Category: zero-result
  // search never yields a card (server/NOTES.md) — this is the raw signal
  // half; server/store/index.js's search_help offer is the candidate half.
  let search = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "search") {
      search = { q: events[i].meta?.q ?? "", results: events[i].meta?.results };
      break;
    }
  }

  // Page dwell: the widget sends dwell with target = page path (or null).
  // Anything else is per-element dwell. Only dwell since the latest page_view counts.
  const dwell = { pageMs: 0, perTarget: {}, perTargetEvidence: {} };
  let lastPageView = events.findLastIndex((e) => e.type === "page_view");

  // acceptedTargets: the union of visibleTargets across EVERY page_view for
  // the CURRENT page path, scanned backward from the latest page_view until
  // a page_view for a DIFFERENT path is hit (a fresh visit's boundary) or
  // events run out. B1's client-side fix now emits a page_view on every
  // route change (even a same-target product->product navigation), and can
  // also legitimately re-fire on the SAME path with a changed target set
  // (e.g. a modal opening/closing new data-agent-target elements) — a dwell
  // target that was visible under an EARLIER page_view of this same visit
  // but has since scrolled out of the latest page_view's own targets list
  // must still be accepted, not treated as "off page" (that direction of
  // this defect class is a false NEGATIVE: real, in-visit attention
  // silently dropped from dwell.perTarget). Only a target that never
  // appeared under ANY page_view of this path, in this visit, is a genuine
  // leak from a DIFFERENT page and gets dropped (metrics.dwellDroppedOffPage).
  const acceptedTargets = new Set(visibleTargets);
  for (let i = lastPageView - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "page_view") continue;
    if ((e.target ?? null) !== page) break; // different path — visit boundary
    if (Array.isArray(e.meta?.targets)) for (const t of e.meta.targets) acceptedTargets.add(t);
  }

  for (const e of events.slice(Math.max(lastPageView, 0))) {
    if (e.type !== "dwell") continue;
    const ms = e.meta?.ms ?? 0;
    const isPage = isPageDwellTarget(e.target, page);
    if (isPage) {
      dwell.pageMs = ms;
    } else if (visibleTargets.length === 0 || visibleTargets.includes(e.target) || acceptedTargets.has(e.target)) {
      // Defense in depth against the per-element-state-leak defect class: a
      // dwell event positioned after the latest page_view is already scoped
      // to the current page by array position, but a buggy/stale client
      // (see web/components/AgentWidget.tsx and server/public/agent.js's
      // route-change reset comments) could still emit a dwell for a target
      // that only existed on the PREVIOUS page. Cross-checking against this
      // visit's accepted targets means such an event can never be
      // attributed to a target the shopper cannot currently (or couldn't,
      // earlier in this same visit) see, even if the client-side reset ever
      // regresses. When visibleTargets is empty (a fixture/page that never
      // sent meta.targets), fall back to accepting the event rather than
      // silently dropping all per-target dwell.
      dwell.perTarget[e.target] = ms;
      if (e.meta?.kind === "attention") {
        dwell.perTargetEvidence[e.target] = { kind: e.meta.kind, interactions: e.meta.interactions ?? {} };
      } else {
        delete dwell.perTargetEvidence[e.target];
      }
    } else {
      // Genuinely off-page (never visible under any page_view of this path,
      // this visit) — dropped, same as before, but now counted so this
      // defect class has an observable signal instead of failing silently.
      metrics.inc("dwellDroppedOffPage");
    }
  }

  const lastIntervention = session.lastInterventionAt
    ? {
        target: session.lastInterventionTarget ?? null,
        agoMs: Date.now() - session.lastInterventionAt,
      }
    : null;

  const now = Date.now();

  // needsResnapshot: this session has events but has NEVER seen a page_view
  // — see the field's doc above the return statement. Logged once per
  // buildState() call (not deduped/rate-limited: buildState() itself is
  // already only called per incoming event, not per tick) so an operator
  // watching logs can see a session stuck in this state instead of it
  // failing silently as "product: null" with no explanation.
  const needsResnapshot = events.length > 0 && page === null;
  if (needsResnapshot) {
    console.warn(`[state] session ${session.id} has events but no page_view — no page snapshot`);
  }
  const effectivePage = page ?? (needsResnapshot ? fallbackPathFromDwell(events) : null);

  // Store knowledge (server/store/) is loaded defensively: a missing/broken
  // catalog.json/promos.json/policies.json degrades to "no offers, no
  // business block" rather than throwing buildState() (and therefore the
  // whole /event handler) into an error — see store/index.js's own
  // load-error handling.
  let offers = [];
  let business = null;
  let product = null;
  let store = null;
  try {
    store = loadStore(session.site);
    offers = computeOffers({ page, cart, promo, search }, now, store);
    business = businessBlock(store);
    // product: the CURRENT product page's catalog entry, trimmed to what the
    // decider/policy needs — null off a product page (or if the slug isn't
    // in the catalog). server/policy.js's card guard uses product.sizes to
    // validate a pick_size cta.value is real; server/decide/stub.js and the
    // prompt use fit_notes for sizing-hesitation cards. Resolved from
    // `effectivePage` (falls back to the dwell-derived path when there's no
    // page_view at all — see needsResnapshot above), not `page`.
    const slug = productSlugFromPage(effectivePage, store);
    const catalogEntry = slug ? (store.catalog || []).find((p) => p.slug === slug) : null;
    if (catalogEntry) {
      product = {
        slug: catalogEntry.slug,
        name: catalogEntry.name,
        price: catalogEntry.price,
        sizes: Array.isArray(catalogEntry.sizes) ? catalogEntry.sizes.slice() : [],
        fit_notes: catalogEntry.fit_notes ?? null,
      };
    }
    // Business-block size per decision (server/store/README.md "Multiple
    // stores" latency note): {product, offers, business} is the store-
    // derived slice of buildState()'s output the decider actually reasons
    // over — cart/dwell/facts are session-derived, not store-derived, and
    // sized independently of which site/catalog is loaded. Logged at
    // debug level (LOG_LEVEL=debug to see it) so a merchant's catalog
    // growing (e.g. an imported Acme-sized store) is observable
    // without guessing from cold profiling.
    log.debug("business block size", {
      site: session.site || "default",
      bytes: Buffer.byteLength(JSON.stringify({ product, offers, business }), "utf8"),
    });
  } catch (err) {
    console.warn(`[state] store lookup failed, continuing with no offers: ${err.message}`);
  }

  const journey = buildJourney(events, store, now);
  const visitsForPatterns = journey._all;
  delete journey._all; // internal only, never leaves buildState()
  const focus = buildFocus(events, store, now);
  const patterns = buildPatterns({ visits: visitsForPatterns, focusTop: focus.top, events, store });
  const recent = buildRecent(events, store, now);

  const result = {
    page,
    needsResnapshot,
    visibleTargets: visibleTargets.slice(),
    cart,
    promo,
    search,
    facts,
    business,
    offers,
    product,
    journey,
    focus,
    patterns,
    recent,
    dwell,
    lastIntervention,
  };

  // stateBytes: total size of the model-facing state (server/NOTES.md
  // "shopper narrative, not raw event tails" defect class — the whole point
  // of journey/focus/patterns/recent replacing raw event tails is to keep
  // this small even for a long session). Not enforced, just observable;
  // STATE_SIZE_BUDGET_BYTES is the target for a ~5-minute session.
  log.debug("state size", {
    site: session.site || "default",
    bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
    budget: STATE_SIZE_BUDGET_BYTES,
  });

  return result;
}
