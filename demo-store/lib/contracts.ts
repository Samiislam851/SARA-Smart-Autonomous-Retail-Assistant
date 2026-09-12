// Contracts — mirrored in server/contracts.js. Change both or neither.

export const EVENT_TYPES = [
  "page_view", "dwell", "scroll_depth", "rage_click",
  "cart_view", "cart_update", "search", "back_nav", "agent_outcome",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

// Outcome tracking (server/RESEARCH.md "Outcomes" section) — mirrors
// server/contracts.js's OUTCOME_KINDS. What the shopper DID after a
// non-noop action was shown, reported back as an `agent_outcome` event.
export const OUTCOME_KINDS = ["cta", "dismiss", "turn_off", "navigated", "ignored"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export type AgentOutcomeMeta = {
  action_id: string;
  action: string;
  cta_kind?: string;
  outcome: OutcomeKind;
  ms_visible: number;
};

// Per-event meta shapes, mirrored from server/contracts.js META_SHAPES.
// Loose/optional on purpose: validation server-side is lenient (unknown keys
// allowed, wrong types just warn) so this stays backward-compatible with any
// existing meta the widget already sends.
// Element-level dwell (`dwell` events whose target is NOT the page path) is
// ATTENTION time, not viewport-visibility time — see server/CLAUDE.md-style
// comments in AgentWidget.tsx's dwell tracker for the full defect writeup.
// `kind: "attention"` + `interactions` are optional additions (never sent on
// page-level dwell, whose target IS the page path — that stays a plain
// `{ ms }` heartbeat, unchanged).
export type DwellInteractions = {
  hover_ms?: number;
  focus_ms?: number;
  clicks?: number;
  scrolled_to?: boolean;
};

export type EventMeta = {
  page_view: { targets?: string[] };
  dwell: { ms?: number; kind?: "attention"; interactions?: DwellInteractions; touch?: boolean };
  scroll_depth: { pct?: number };
  rage_click: { count?: number };
  cart_view: { total?: number; items?: { sku: string; qty: number; price: number }[] };
  cart_update: { total?: number; items?: { sku: string; qty: number; price: number }[] };
  search: { q?: string; results?: number };
  back_nav: Record<string, never>;
  agent_outcome: AgentOutcomeMeta;
};

export type AgentEvent = {
  session: string;
  type: EventType;
  target: string | null;
  ts: number;
  meta?: EventMeta[EventType] | Record<string, unknown>;
};

export const ACTIONS = ["highlight", "scroll_to", "message", "spotlight", "card", "noop"] as const;
export type ActionType = (typeof ACTIONS)[number];

// Mirrors server/contracts.js's `card` action doc comment — the one action
// that lets the agent DO something in one tap (pick a size, add the item
// that unlocks free delivery, apply a code, open a similar product, search
// again) instead of just pointing/pulsing/talking. `cta.value` semantics
// (server/policy.js validates every one of these is REAL before broadcast):
//   pick_size -> a size from the current product's sizes; add_to_cart /
//   open_product -> a product slug; apply_code -> an active promo code;
//   search -> a non-empty query string; none -> null.
export type CardCtaKind = "pick_size" | "add_to_cart" | "apply_code" | "open_product" | "search" | "none";

// Card templates (server/templates.js, server/prompts/templates.json): the
// decider may propose a card via a merchant-authored template id + short
// slot values instead of free title/body, but that's resolved to plain
// title/body entirely server-side before broadcast — this WIRE type (what
// the widget actually receives) is unaffected and unchanged.
export type AgentCard = {
  title: string; // <=60 chars
  body: string; // <=200 chars
  cta: {
    kind: CardCtaKind;
    label: string; // <=28 chars
    value: string | null;
  };
};

export type AgentAction = {
  kind: "action";
  action: ActionType;
  target: string | null;
  style: "pulse" | "outline" | null;
  duration_ms: number;
  message: string | null;
  card?: AgentCard | null; // present (non-null) only when action === "card"
  // server-assigned, echoed back in agent_outcome. Present on every
  // non-noop action (not just card), absent on noop.
  id?: string;
};

export type AgentTrace = {
  kind: "trace";
  ts: number;
  signals: string[];
  hypothesis: string;
  decision: string;
  confidence: number;
  why: string;
};

export type ServerMessage = AgentAction | AgentTrace;
