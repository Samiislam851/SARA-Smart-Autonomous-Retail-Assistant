// Contracts — mirrored in web/lib/contracts.ts. Change both or neither.

export const EVENT_TYPES = [
  "page_view", "dwell", "scroll_depth", "rage_click",
  "cart_view", "cart_update", "search", "back_nav", "agent_outcome",
];

export const ACTIONS = ["highlight", "scroll_to", "message", "spotlight", "card", "noop"];

// Outcome tracking (server/RESEARCH.md "Outcomes" section): what the shopper
// DID after a non-noop action was shown, reported back by the widget as an
// `agent_outcome` event (see EVENT_TYPES above) so the team can tell right
// from wrong decisions instead of an action landing and nothing about the
// reaction ever coming back.
//
// Every non-noop action the server broadcasts gets a server-assigned `id`
// (see actionMessage() in index.js) — `a_` + 8 base36 chars — echoed back by
// the widget in agent_outcome.meta.action_id. Exactly ONE outcome is ever
// recorded per action id (server-side dedup in live-record.js's
// recordOutcome(), client-side a Set of already-reported ids — see
// AgentWidget.tsx / agent.js).
export const OUTCOME_KINDS = ["cta", "dismiss", "turn_off", "navigated", "ignored"];

/**
 * `card` action shape (server -> widget), the one action that lets the
 * agent DO something in one tap instead of just pointing/pulsing/talking:
 * {
 *   action: "card", target: string|null, style: null, duration_ms: number,
 *   message: null,   // a card carries its own text; message is always null here
 *   card: {
 *     title: string (<=60 chars),
 *     body: string (<=200 chars),
 *     cta: {
 *       kind: "pick_size" | "add_to_cart" | "apply_code" | "open_product" | "search" | "none",
 *       label: string (<=28 chars),
 *       value: string|null   // see below
 *     }
 *   }
 * }
 * `cta.value` semantics (server/policy.js validates every one of these is
 * REAL before broadcast — see server/POLICY.md):
 *   - pick_size    -> a size from the CURRENT product's `sizes` (state.product)
 *   - add_to_cart  -> a product slug in the store catalog
 *   - apply_code   -> an ACTIVE promo's code (server/store/promos.json)
 *   - open_product -> a product slug in the store catalog
 *   - search       -> a non-empty query string (<=60 chars)
 *   - none         -> null (informational card, no action to take)
 * `target` is the element the card anchors to — same visibleTargets rule as
 * every other action. `style` is always null (cards have no pulse/outline).
 *
 * `id?: string` — server-assigned, echoed back in agent_outcome. Present on
 * every non-noop action of ANY kind (not just card — see actionMessage() in
 * index.js), absent on noop.
 *
 * Card templates (server/templates.js, server/prompts/templates.json): the
 * DECIDER's own output contract (server/prompts/schema.json) additionally
 * accepts `card.template` (a merchant-authored recipe id) + `card.slots`
 * (short fact values) INSTEAD of free `title`/`body` — but that's resolved
 * to plain `{title, body}` entirely server-side (server/policy.js's
 * applyPolicy(), before broadcast). This WIRE shape — what actually reaches
 * the widget, documented above — is unchanged: `card` is always exactly
 * `{title, body, cta}` here, whether it came from a template or free text.
 */


// Session ids come from the client (POST body, WS query string, URL param) —
// never trust them as a filesystem/path component or free-form string.
// One shared pattern, checked everywhere a session id enters the system.
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidSessionId(id) {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

/**
 * Documented meta shapes per event type, used for lenient validation.
 * Unknown keys are always allowed. Wrong types don't reject the event —
 * they just log a warning (see validateMeta below).
 *
 * page_view    meta: { targets: string[], site?: string, facts?: { keys?: object, snippets?: string[] } }
 *              — targets: all data-agent-target ids present on the page.
 *              — site (optional): agent.js's cfg.site / data-site attribute
 *                — which merchant's store this embed is running on (see
 *                server/store/sites.js). Absent/"" means the default store.
 *              — facts (optional): agent.js's DOM-read heuristics (see
 *                server/FACTS.md). facts.keys is a map of normalized values
 *                (cart_total, cart_count, free_delivery_threshold,
 *                delivery_fee, stock, size_selected, price — all optional,
 *                present only when confidently extracted). facts.snippets is
 *                up to 10 short (<=120 char) verbatim strings from the
 *                page's own text. Either half may be absent depending on the
 *                page's data-facts attribute and the server's FACTS_MODE env
 *                (buildState() surfaces the filtered result as top-level
 *                `facts`, not duplicated under `recent`).
 * dwell        meta: { ms: number, kind?: "attention", interactions?: { hover_ms?, focus_ms?,
 *                clicks?, scrolled_to? }, touch?: boolean }
 *              — kind/interactions/touch appear ONLY on element-level dwell
 *              (target is an element id, not the page path): `ms` there is
 *              ATTENTION time (hover/focus/tap/scroll-into-view), never mere
 *              viewport-visibility time. `interactions` is the evidence used
 *              to compute it. Page-level dwell (target = page path) never
 *              carries these — it stays a plain `{ ms }` heartbeat.
 * scroll_depth meta: { pct: number }
 * rage_click   meta: { count: number }
 * cart_view    meta: { total: number, items: [{ sku, qty, price }] }
 * cart_update  meta: same as cart_view
 * search       meta: { q: string, results?: number }
 *              — results (optional): the store's result count for `q`, when
 *              the page knows it. 0 means a genuine zero-result search —
 *              server/gate.js's searchFriction signal and server/store/
 *              index.js's search_help offer both require EXACTLY 0, never
 *              an absent/undefined count. agent.js discovers this count
 *              itself, without any host wiring, by reading a
 *              data-agent-search-results="<n>" attribute — checked in order
 *              on the search input, its closest form, then anywhere on the
 *              page — and watching it via MutationObserver for up to 5s
 *              after the query (covers both client-side-filtered results
 *              and SSR results pages reached via location navigation, e.g.
 *              /search?q=...). A second `search` emit with the discovered
 *              count is normal and expected; consumers should treat later
 *              `search` events for the same `q` as refining/superseding
 *              earlier ones, same as cart_update.
 * back_nav     no meta (target = path)
 * agent_outcome meta: { action_id: string, action: string, cta_kind?: string,
 *                outcome: "cta"|"dismiss"|"turn_off"|"navigated"|"ignored",
 *                ms_visible: number }
 *              — target = the action's own target. Never pushed into
 *              session.events (see index.js's dedicated agent_outcome
 *              branch in POST /event) — it must never feed gate.js/tick.js's
 *              friction signals or buildState()'s `recent` log, and must
 *              never itself trigger a decision. Recorded (when live
 *              recording is on) via live-record.js's recordOutcome(), keyed
 *              by session, deduped by action_id.
 */
export const META_SHAPES = {
  page_view: { targets: "array", site: "string", facts: "object" },
  dwell: { ms: "number", kind: "string", interactions: "object", touch: "boolean" },
  scroll_depth: { pct: "number" },
  rage_click: { count: "number" },
  cart_view: { total: "number", items: "array" },
  cart_update: { total: "number", items: "array" },
  search: { q: "string", results: "number" },
  back_nav: null,
  agent_outcome: { action_id: "string", action: "string", cta_kind: "string", outcome: "string", ms_visible: "number" },
};

function typeOf(v) {
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Lenient meta validation: never rejects the event. Logs a console.warn
 * for any documented key whose type doesn't match. Unknown keys are fine.
 */
export function validateMeta(type, meta) {
  const shape = META_SHAPES[type];
  if (!shape || !meta) return;
  for (const [key, expected] of Object.entries(shape)) {
    if (key in meta && typeOf(meta[key]) !== expected) {
      console.warn(
        `[contracts] event "${type}" meta.${key} expected ${expected}, got ${typeOf(meta[key])}`
      );
    }
  }
}
