"use client";

// AgentWidget = tracker + executor + trace panel.
// Tracker: emits events to POST /event.
// Executor: applies actions from the allow-list to [data-agent-target] elements.
// Trace panel: shows the agent's reasoning for every tick, including noop.
//
// The agent never touches the DOM. Only this file does, and only via the allow-list.
// See web/README.md for the full event/action rundown.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { AgentAction, AgentCard, AgentTrace, EventType, OutcomeKind, ServerMessage } from "@/lib/contracts";
import {
  addToCart,
  applyPromo,
  cartTotal,
  getPrimaryPromoMeta,
  getSnapshot as getCartSnapshot,
  subscribe as subscribeCart,
} from "@/lib/cart";
import { getProduct } from "@/lib/products";
import { getSessionId } from "@/lib/agentSession";

const HTTP = process.env.NEXT_PUBLIC_AGENT_HTTP ?? "http://localhost:4000";
const WS = process.env.NEXT_PUBLIC_AGENT_WS ?? "ws://localhost:4000";

const DWELL_HEARTBEAT_MS = 5000; // page-level dwell heartbeat
const DWELL_TICK_MS = 1000; // per-element dwell check interval
const DWELL_BUCKET_MS = 3000; // per-element dwell fires every 3s of cumulative ATTENTION (see TargetAttentionState)
const RAGE_WINDOW_MS = 1500;
const RAGE_THRESHOLD = 3;
const RESCAN_DEBOUNCE_MS = 300;
const SEARCH_DEBOUNCE_MS = 700;
const SEARCH_INPUT_MIN_CHARS = 2;
const SCROLL_THRESHOLDS = [25, 50, 75, 100];
const MESSAGE_MAX_CHARS = 140; // decider-authored copy is untrusted length-wise; hard client clamp

// ---- search result counts (server/contracts.js's `search` meta.results,
// mirrors server/public/agent.js's identical helpers) --------------------
// This demo store's Nav is decorative — its search box (data-agent-target=
// "search") doesn't actually filter anything, so there is no results
// header/container here to tag with the attribute. Kept for parity with
// agent.js's reading logic (and for any future results page this store
// grows) — see docs/ACME.md / docs/NEXTCART.md for the two real
// stores that DO expose the attribute today.
const SEARCH_RESULTS_ATTR = "data-agent-search-results";
function parseResultsCount(v: string | null): number | null {
  if (v == null) return null;
  const n = parseInt(v.replace(/[^0-9-]/g, ""), 10);
  return Number.isNaN(n) ? null : n;
}
function readSearchResultsCount(inputEl: HTMLElement | null): number | null {
  let el: Element | null = null;
  if (inputEl?.hasAttribute?.(SEARCH_RESULTS_ATTR)) {
    el = inputEl;
  } else {
    const form = inputEl?.closest?.("form") ?? null;
    if (form?.hasAttribute(SEARCH_RESULTS_ATTR)) el = form;
  }
  if (!el) el = document.querySelector(`[${SEARCH_RESULTS_ATTR}]`);
  if (!el) return null;
  return parseResultsCount(el.getAttribute(SEARCH_RESULTS_ATTR));
}
// Search-input-only-fires-on-Enter defect class: a search box that filters
// live client-side as the shopper types (Acme — no Enter/submit at
// all) used to never emit `search`. isSearchInput() is the single
// predicate every emission path (Enter, debounced input, form submit) uses
// to decide whether an <input> is a search box. Mirrors server/public/
// agent.js.
const SEARCH_EXCLUDED_TYPES = ["password", "email", "tel", "number", "hidden"];
function isSensitiveInput(el: Element): boolean {
  const type = ((el as HTMLInputElement).type || "text").toLowerCase();
  if (SEARCH_EXCLUDED_TYPES.includes(type)) return true;
  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
  return autocomplete.includes("cc-") || autocomplete.includes("one-time-code");
}
function isSearchInput(el: Element | null): el is HTMLInputElement {
  if (!el || el.tagName !== "INPUT") return false;
  if (isSensitiveInput(el)) return false;
  const input = el as HTMLInputElement;
  const isSearchType = input.type === "search";
  const nameOrId = `${input.name || ""} ${input.id || ""}`.toLowerCase();
  const looksLikeSearch = /search|(^|[^a-z])q([^a-z]|$)/.test(nameOrId);
  const isAgentTarget = el.getAttribute("data-agent-target") === "search";
  return isSearchType || looksLikeSearch || isAgentTarget;
}

// Metrics come over the same WS but aren't part of the fixed Event/Action/Trace
// contract (server/metrics.js's snapshot() shape) — kept as a local, non-exported
// type instead of touching web/lib/contracts.ts.
type MetricsMessage = {
  kind: "metrics";
  ticks?: number;
  quietTicks?: number;
  gated?: number;
  llmCalls?: number;
  cacheHits?: number;
  cacheMisses?: number;
  llmErrors?: number;
  cacheEnabled?: boolean;
  [key: string]: unknown;
};
// In-page demo player (see DEMO.md "No-terminal demo" + server/index.js's
// GET /demo/fixtures, POST /demo/play/:fixture, gated behind AGENT_DEBUG=1).
// Not part of the fixed Event/Action/Trace contract — same treatment as
// MetricsMessage above.
type DemoMessage = { kind: "demo"; state: "start" | "end" | "error"; fixture: string; events?: number; error?: string };
type WireMessage = ServerMessage | MetricsMessage | DemoMessage;

type DemoFixture = {
  name: string;
  session: string;
  description: string;
  expect: unknown;
  page: string;
  events: number;
};
type DemoStatus = { fixture: string; state: "playing" | "done" | "error"; message?: string };
// estimatedMs*3+10000 watchdog, mirrors the server's demo-play watchdog
// (server/index.js) — if no `end` (or `error`) arrives within this window
// of a 202, something's wrong (hung decider, dropped WS) and the button
// shouldn't spin forever.
const DEMO_WATCHDOG_MULTIPLIER = 3;
const DEMO_WATCHDOG_PAD_MS = 10_000;

type TraceEntry = AgentTrace & { suppressed?: boolean };
// id/shownAt: outcome tracking (server/RESEARCH.md "Outcomes" section) —
// id is the server-assigned action id (echoed back in agent_outcome),
// shownAt is when this bubble appeared (-> ms_visible on report).
type Message = { text: string; target: string | null; id?: string; shownAt: number };

// ---- persistent assistant panel (launcher + tray) --------------------------
// Every non-noop action the agent ever delivers this session becomes a
// Suggestion card in the tray (see "Suggestions tray" in the brief) — kept
// separately from `traces` (which include noop/suppressed) and `message`
// (the transient bubble, which stays untouched). Persisted in sessionStorage
// via the same `storage` helper the rest of the widget uses, so a reload
// mid-session doesn't lose the tray.
type Suggestion = {
  id: string;
  ts: number;
  action: Exclude<ActionKind, "noop">;
  target: string | null;
  text: string;
  hypothesis: string | null;
  confidence: number | null;
  why: string | null;
  // Only set for action === "card" — the tray persists the CTA too, so a
  // shopper can still act on an old card suggestion later (see
  // handleTraySuggestionCta).
  cardTitle?: string;
  cta?: AgentCard["cta"];
  // Outcome tracking (server/RESEARCH.md "Outcomes" section) — the
  // server-assigned action id (undefined for an action broadcast before
  // this feature shipped, or a noop, which never gets a tray entry).
  actionId?: string;
  // Tray/badge-desync defect class: resolving the LIVE card (× or its CTA)
  // used to leave the matching tray entry looking untouched — still
  // clickable Show me/CTA, still counted as unseen. Set by
  // markSuggestionResolved() whenever the live slot for this suggestion's
  // actionId is dismissed/CTA'd/turned-off/navigated-away-from, so the tray
  // entry can render as inert and countUnseen can stop counting it.
  resolved?: OutcomeKind;
};
type ActionKind = AgentAction["action"];
const SUGGESTIONS_KEY = "agent_suggestions";
// unread-badge-resets-on-remount defect class: the unseen count used to live
// ONLY in React state, seeded to 0 on every mount — correct within a single
// mount (increments once per new suggestion while the panel is closed,
// resets on open), but a hard reload / full page nav (this widget also ships
// as a plain <script> for non-SPA pages — see server/public/agent.js) remounts
// the component while `suggestions` restores in full from sessionStorage, so
// the badge undercounts (drops back toward 0/1) relative to how many of
// those restored suggestions the shopper actually never saw. Fix: persist a
// "seen before this timestamp" marker alongside the suggestions list, and
// derive the initial unseen count from it on every mount instead of just
// assuming 0.
const SUGGESTIONS_SEEN_AT_KEY = "agent_suggestions_seen_at";
const MAX_SUGGESTIONS = 200;
const SHOW_ME_PULSE_MS = 5000;

function loadSuggestions(): Suggestion[] {
  const raw = storage.get(SUGGESTIONS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadSeenAt(): number {
  const raw = storage.get(SUGGESTIONS_SEEN_AT_KEY);
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) ? n : 0;
}

function saveSeenAt(ts: number): void {
  storage.set(SUGGESTIONS_SEEN_AT_KEY, String(ts));
}

function countUnseen(list: Suggestion[], seenAt: number): number {
  return list.filter((s) => s.ts > seenAt && !s.resolved).length;
}

function saveSuggestions(list: Suggestion[]): void {
  try {
    storage.set(SUGGESTIONS_KEY, JSON.stringify(list));
  } catch {
    // JSON.stringify on a plain array of primitives/strings shouldn't
    // throw, but storage.set already swallows quota/availability errors —
    // this catch is only for a pathological JSON.stringify failure.
  }
}

// Developer-text-leaks-to-shopper defect class: `data-agent-target` values
// (`product-card-nakshi-kantha-scarf`, `size-guide`, ...) and raw event/
// trace strings (`dwell /product/khadi-field-jacket 125s`, `quiet tick:
// dwell within same bucket, no new signal`) are internal identifiers/debug
// text, never shopper copy. Every shopper-facing surface (suggestion tray,
// "What I noticed") must go through a small formatter that either maps a
// known shape to a human phrase or omits it — never dumps the raw string.
// The separate dev trace panel (rows below, gated on its own disclosure
// triangle) is unaffected — that one is explicitly for developers. Mirrored
// in server/public/agent.js.
const TARGET_LABELS: Record<string, string> = {
  "size-guide": "the size guide",
  "size-picker": "the size picker",
  "size-chart": "the size chart",
  "cart-add": "the add-to-cart button",
  "shipping-banner": "the shipping banner",
  "product-image": "the product photo",
  search: "the search box",
  "similar-products": "the similar products",
  "cart-items": "your cart items",
  "cart-link": "your cart",
  "cart-total": "your cart total",
  "checkout-btn": "checkout",
  "checkout-total": "the checkout total",
  "address-form": "the address form",
  "payment-options": "payment options",
  "place-order": "place order",
  "promo-code": "the promo code field",
};
/** slug/id -> "Title Case Words", e.g. "nakshi-kantha-scarf" -> "Nakshi
 * Kantha Scarf". Used for anything that reduces to a product slug. */
function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}
// Raw-path-title-cased-as-a-label defect class: title-casing a whole path
// ("/products/chaa-break-mug" -> "Products/chaa Break Mug") leaks the route
// prefix into shopper-facing copy. lastPathSegment() + the product regex
// below always slug from the LAST segment only, never the full path.
// Mirrors server/public/agent.js.
function lastPathSegment(path: string): string {
  const segs = path.split("/").filter(Boolean);
  return segs.length ? segs[segs.length - 1] : "";
}
// Per-path cache of a DOM-derived page label (see capturePageLabel),
// populated on every page_view — including for paths the shopper has since
// navigated away from, so a later "You spent 1 min on <path>" line (built
// from an OLD trace signal, current DOM no longer matches) still resolves
// to the real product/page name instead of a slug guess. Mirrors
// server/public/agent.js.
const pageLabelCache: Record<string, string> = {};
// Splits a <title> on the first " | " or " – " (en dash) separator and
// returns the part before it. Plain hyphens inside the title itself (e.g.
// "T-Shirt") are left alone since the separator must be surrounded by
// spaces.
function titleBeforeSeparator(title: string | null | undefined): string | null {
  if (!title) return null;
  const parts = title.split(/\s\|\s|\s–\s/);
  const first = parts[0] ? parts[0].trim() : "";
  return first || null;
}
// Label resolution order (both widgets): (a) an explicit product/page name
// read off the page itself — [data-agent-target="product-title"], else the
// first <h1>, else document.title before the first separator; (b) known
// route words for paths with no on-page name to read; (c) the last path
// segment, slugified, as a last resort (never the raw path).
function resolveDomPageLabel(): string | null {
  let el: Element | null = null;
  try {
    el = document.querySelector('[data-agent-target="product-title"]');
  } catch {
    el = null;
  }
  let text = el?.textContent?.trim() ?? "";
  if (!text) {
    try {
      el = document.querySelector("h1");
    } catch {
      el = null;
    }
    text = el?.textContent?.trim() ?? "";
  }
  if (!text) text = titleBeforeSeparator(document.title) ?? "";
  return text || null;
}
// Captures the current page's DOM-derived label into pageLabelCache, keyed
// by path. Called on every page_view (mount + route change) so the cache
// is populated while the page's own DOM is still live and queryable.
function capturePageLabel(path: string): void {
  if (!path) return;
  const label = resolveDomPageLabel();
  if (label) pageLabelCache[path] = label;
}
/** Human label for a `data-agent-target` value (or a page path). Known UI
 * targets go through TARGET_LABELS; `product-card-<slug>` / `similar-<slug>`
 * / a `/product/<slug>` (or `/products/<slug>`) path resolve to the
 * product's title-cased name; anything else still gets title-cased instead
 * of dumped with raw dashes. */
function humanTargetLabel(target: string | null): string {
  if (!target) return "something on the page";
  if (target in TARGET_LABELS) return TARGET_LABELS[target];
  const productMatch =
    target.match(/^product-card-(.+)$/) || target.match(/^similar-(.+)$/) || target.match(/^\/products?\/(.+)$/);
  if (productMatch) return titleCaseSlug(lastPathSegment(productMatch[1]));
  return titleCaseSlug(target);
}
/** Human label for a page path, for dwell signals whose subject is the page
 * itself rather than an element (see server/state.js's isPageDwellTarget).
 * Checks the DOM-derived cache first (a) so a genuinely-named page/product
 * wins even for a path the shopper has since navigated away from, then
 * known route words (b), then a last-path-segment slug guess (c). */
function humanPageLabel(path: string): string {
  if (path in pageLabelCache) return pageLabelCache[path];
  if (path === "/") return "the homepage";
  if (path === "/cart") return "your cart";
  if (path === "/checkout") return "checkout";
  if (/^\/search(\/|\?|$)/.test(path)) return "the search page";
  if (path === "/shop") return "the shop";
  const productMatch = path.match(/^\/products?\/(.+)$/);
  if (productMatch) return titleCaseSlug(lastPathSegment(productMatch[1]));
  const seg = lastPathSegment(path);
  return (seg && titleCaseSlug(seg)) || "the page";
}

/** Plain-language sentence for a delivered action — used by the suggestions
 * tray for every action kind (a `message` action's own text is shown
 * verbatim instead, see addSuggestion; it's already shopper-authored copy
 * from the decider, not a raw identifier). `card` actions are described by
 * their CTA (what the one-tap button actually offers), not by the card's
 * own body text, so the tray line matches the mapping table asked for
 * (action type + target/CTA label -> human phrase) even when the card
 * carries a longer body sentence. */
function suggestionSentence(a: AgentAction): string {
  // Same path-vs-target-id branch as parseNoticedSignal below: a.target can
  // be a page path rather than a data-agent-target id.
  const label = a.target && a.target.startsWith("/") ? humanPageLabel(a.target) : humanTargetLabel(a.target);
  if (a.action === "card" && a.card) {
    const cta = a.card.cta;
    switch (cta.kind) {
      case "pick_size":
        return cta.value ? `Suggested size ${cta.value}` : "Suggested picking a size";
      case "add_to_cart":
        return cta.value ? `Suggested adding ${titleCaseSlug(cta.value)} to your cart` : "Suggested adding an item to your cart";
      case "apply_code":
        return cta.value ? `Offered code ${cta.value}` : "Offered a discount code";
      case "open_product":
        return cta.value ? `Pointed you to ${titleCaseSlug(cta.value)}` : "Pointed you to a similar product";
      case "search":
        return cta.value ? `Suggested searching for "${cta.value}"` : "Suggested a search";
      case "none":
      default:
        return a.card.title || "Shared a suggestion";
    }
  }
  switch (a.action) {
    case "highlight":
      return `Highlighted ${label} for you`;
    case "spotlight":
      return `Spotlighted ${label} for you`;
    case "scroll_to":
      return `Scrolled you to ${label}`;
    default:
      return `Drew attention to ${label}`;
  }
}

function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

// Developer-text-leaks-to-shopper defect class, continued: index.js's own
// quiet-tick/gate/backpressure short-circuit (never reaches a decider)
// writes internal plumbing straight into trace.why — "quiet tick: dwell
// within same bucket, no new signal", "gated: <reason>", "overloaded" — as
// opposed to a REAL noop decision's why, which is decider-authored human
// text ("No friction signal strong enough to justify stepping in."). Only
// the shopper-facing "What I noticed" panel needs this filter; the separate
// dev trace panel shows the raw trace either way, which is exactly where
// this detail belongs. Mirrored in server/public/agent.js.
const INTERNAL_WHY_PATTERN = /^(quiet tick|gated:|overloaded)/i;
function shopperSafeWhy(why: string | null | undefined): string | null {
  if (!why) return null;
  return INTERNAL_WHY_PATTERN.test(why) ? null : why;
}

/** "What I noticed" — ONE coherent primary line for the latest trace: what
 * it did + why if it acted, or just the quiet reason if it didn't. Never
 * both a hypothesis-shaped sentence AND a contradicting "nothing to help
 * with" line — that pairing (hypothesis-that-implies-action followed
 * immediately by a "browsing normally" disclaimer) read as the widget
 * disagreeing with itself. The hypothesis itself (when present) is shown
 * separately, behind a "why" expander — see agent-noticed-why-toggle below. */
function noticedPrimaryText(t: TraceEntry | undefined): string {
  if (!t) return "Watching. Nothing decided yet.";
  if (t.decision === "noop") {
    return "Nothing to help with right now: browsing normally."; // model reasoning and errors never reach the shopper
  }
  return t.why ? `Decided to ${t.decision} — ${t.why}` : `Decided to ${t.decision}.`;
}

/** Duration formatter for "What I noticed" lines: "40s", "2 min". */
function formatNoticedDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

/** Parses ONE raw trace.signals[] string (server/state.js's summarize() —
 * e.g. "dwell /product/khadi-field-jacket 125s", "attention size-guide 21s
 * (hover 15s, 2 clicks)", "page_view /cart", "cart_view", "rage_click
 * search") into a dedup key + a human sentence. Unknown/unrecognized shapes
 * return null — the caller omits them rather than falling back to the raw
 * string (never dump internal event/trace text on the shopper). Mirrored in
 * server/public/agent.js. */
function parseNoticedSignal(sig: string): { key: string; text: string } | null {
  let m: RegExpMatchArray | null;
  if ((m = sig.match(/^(?:dwell|attention) (\S+) (\d+)s/))) {
    const [, target, secStr] = m;
    const label = target.startsWith("/") ? humanPageLabel(target) : humanTargetLabel(target);
    return { key: `dwell:${target}`, text: `You spent ${formatNoticedDuration(Number(secStr))} on ${label}` };
  }
  if ((m = sig.match(/^page_view\s*(\S*)/))) {
    const path = m[1] || "/";
    return { key: `page_view:${path}`, text: `You viewed ${humanPageLabel(path)}` };
  }
  if (sig.startsWith("cart_view")) return { key: "cart_view", text: "You opened your cart" };
  if (sig.startsWith("cart_update")) return { key: "cart_update", text: "You updated your cart" };
  if (sig.startsWith("search")) return { key: "search", text: "You searched the store" };
  if ((m = sig.match(/^rage_click\s*(\S*)/))) {
    const target = m[1];
    return {
      key: `rage_click:${target || ""}`,
      text: `You clicked ${target ? humanTargetLabel(target) : "something on the page"} repeatedly`,
    };
  }
  if (sig.startsWith("scroll_depth")) return { key: "scroll_depth", text: "You scrolled through the page" };
  if (sig.startsWith("back_nav")) return { key: "back_nav", text: "You went back a page" };
  return null;
}

/** "What I noticed" signal lines: dedupe by (page/target, kind) — keeping
 * the LATEST value and moving it to the most-recent position — then cap at
 * 4. Fixes the repeated-identical-line defect (the same dwell target
 * emitted every ~2s of continued hovering used to render as 4+ near-
 * identical raw lines) and the raw-string leak in one pass. */
function buildNoticedLines(signals: string[]): string[] {
  const texts = new Map<string, string>();
  let order: string[] = [];
  for (const sig of signals) {
    const parsed = parseNoticedSignal(sig);
    if (!parsed) continue;
    texts.set(parsed.key, parsed.text);
    order = order.filter((k) => k !== parsed.key);
    order.push(parsed.key);
  }
  return order.slice(-4).map((k) => texts.get(k)!);
}

// sessionStorage can throw (Safari private mode, storage disabled by policy,
// quota exceeded, third-party-iframe embed context — this widget is
// embeddable per server/public/embed) on ANY call, not just the obviously
// storage-heavy ones. Every access in this file goes through this helper so
// a storage failure degrades to an in-memory-only fallback (session id/
// on-off/panel-open state resets on reload instead of persisting) rather
// than throwing out of the widget entirely.
const memoryStorage = new Map<string, string>();
const storage = {
  get(key: string): string | null {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return memoryStorage.get(key) ?? null;
    }
  },
  set(key: string, value: string): void {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      memoryStorage.set(key, value);
    }
  },
};

// Session id resolution (demo pinning, see DEMO.md), plus clearing every
// OTHER per-identity sessionStorage store (suggestions tray, cart) when the
// resolved id CHANGES, now lives in lib/agentSession.ts — shared with
// cart.ts so both agree on the same id and the same clear-on-change guard
// (see that file for the full rationale). getSessionId() imported above.

/** CSS.escape when available (all modern browsers); a minimal manual escape
 * of `"` and `\` otherwise, since `target` also gets interpolated straight
 * into a `[data-agent-target="..."]` attribute selector string below and an
 * unescaped value (e.g. containing a literal `"`) would break out of the
 * selector — this can only be reached via a decider-produced `action.target`
 * or a page's own `data-agent-target` value, not raw user input, but the
 * decider's output isn't schema-constrained on content, so it's treated as
 * untrusted here. */
function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/[\\"]/g, "\\$&");
}

function targetEl(target: string | null) {
  if (!target) return null;
  return document.querySelector<HTMLElement>(`[data-agent-target="${escapeAttrValue(target)}"]`);
}

// ---- card positioning (founder rule 2026-09-11: "appear AT the thing the
// shopper is looking at", never a fixed corner) --------------------------
// "anchored" = positioned next to the live target element (document
// coordinates: position:absolute + getBoundingClientRect + scrollX/Y, since
// AgentWidget mounts directly under <body> per layout.tsx — no portal
// needed). "banner" = the target isn't on the current page, or the viewport
// is narrow (<480px, mobile always banners per product rule) — centered
// near the top of the viewport instead. Mirrored in server/public/agent.js.
type CardPlacement = "below" | "above" | "right" | "left" | "offset";
type CardPos =
  | { mode: "banner" }
  | {
      mode: "anchored";
      top: number;
      left: number;
      caret: "top" | "bottom";
      caretLeft: number;
      placement: CardPlacement;
    };

const CARD_MAX_WIDTH = 360;
const CARD_MARGIN = 12;
const CARD_MOBILE_BREAKPOINT = 480;
const CARD_EXIT_MS = 120; // exit-fade duration for card/message, mirrors globals.css's agent-box-out

// Card-occludes-recommended-element defect class: the card used to land at
// rect.bottom+10 unconditionally, so it could cover the very "Add to cart"/
// "Try size L" button it was recommending, intercepting the tap. These two
// helpers check a candidate card rect against every other on-page
// interactive element actually visible in the viewport before committing to
// a position. Mirrored in server/public/agent.js.
function rectsOverlap(a: DOMRect | { top: number; left: number; right: number; bottom: number }, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}
// Interactive-element occlusion candidates: every element the card could
// otherwise sit on top of and block a tap on. Broadened from the original
// `[data-agent-target], button, a` (which missed `input`/`select`/ARIA
// buttons) to `button, a, input, select, [role="button"], [data-agent-target]`.
// Callers must exclude the card's own DOM subtree — a previous version only
// excluded the target being highlighted, so the card's own CTA/dismiss/
// "Why?" buttons (all real `<button>`s) could register as "occluding"
// whatever the card's own last on-screen position happened to be.
function interactiveOcclusionCandidates(excludeEls: (HTMLElement | null)[]): HTMLElement[] {
  const all = document.querySelectorAll<HTMLElement>('button, a, input, select, [role="button"], [data-agent-target]');
  const exclusions = excludeEls.filter((e): e is HTMLElement => Boolean(e));
  return Array.from(all).filter((candidate) => {
    for (const ex of exclusions) {
      if (candidate === ex || ex.contains(candidate) || candidate.contains(ex)) return false;
    }
    return true;
  });
}
function intersectingCandidates(
  viewportRect: { top: number; left: number; right: number; bottom: number },
  candidates: HTMLElement[]
): HTMLElement[] {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const hits: HTMLElement[] = [];
  for (const candidate of candidates) {
    const r = candidate.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue; // not on screen
    if (rectsOverlap(viewportRect, r)) hits.push(candidate);
  }
  return hits;
}

// Card-occludes-recommended-element defect class, take 2: the previous fix
// computed a single flip-then-sideways fallback chain but, when BOTH the
// flip and the sideways offset still occluded something, silently kept the
// ORIGINAL (occluding) placement instead of the best alternative tried —
// visually indistinguishable from never having checked at all. This runs
// the same intersection test after EVERY position computation (initial
// render, the 250ms poll, and resize/scroll), trying candidate placements
// in order and always moving off the original spot once it's known to
// occlude something. `data-agent-card-placement` on the rendered card
// records which branch won, for verification. Mirrored in
// server/public/agent.js.
function computeCardPosition(target: string | null, cardEl: HTMLElement | null): CardPos {
  if (typeof window === "undefined") return { mode: "banner" };
  if (window.innerWidth < CARD_MOBILE_BREAKPOINT) return { mode: "banner" };
  const el = targetEl(target);
  if (!el) return { mode: "banner" };
  const rect = el.getBoundingClientRect();
  const cardW = cardEl?.offsetWidth || CARD_MAX_WIDTH;
  const cardH = cardEl?.offsetHeight || 140; // estimate before first measured layout
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const spaceBelow = vh - rect.bottom;
  const spaceAbove = rect.top;
  const fitsBelow = spaceBelow >= cardH + CARD_MARGIN + 10;
  const fitsAbove = spaceAbove >= cardH + CARD_MARGIN + 10;
  // Below by default; only flips above when below doesn't fit but above does.
  // This is purely the space-fit heuristic — occlusion is resolved
  // separately below and always wins over this preference.
  const preferBelow = fitsBelow || !fitsAbove;

  function clampLeft(l: number) {
    const minLeft = window.scrollX + CARD_MARGIN;
    const maxLeft = window.scrollX + vw - cardW - CARD_MARGIN;
    return Math.max(minLeft, Math.min(l, maxLeft));
  }
  function clampTop(t: number) {
    return Math.max(window.scrollY + CARD_MARGIN, t);
  }
  function below(): { top: number; left: number; caret: "top" | "bottom" } {
    return { top: clampTop(rect.bottom + window.scrollY + 10), left: clampLeft(rect.left + window.scrollX), caret: "top" };
  }
  function above(): { top: number; left: number; caret: "top" | "bottom" } {
    return { top: clampTop(rect.top + window.scrollY - cardH - 10), left: clampLeft(rect.left + window.scrollX), caret: "bottom" };
  }
  function rightOf(): { top: number; left: number; caret: "top" | "bottom" } | null {
    const l = rect.right + window.scrollX + 10;
    if (l + cardW > window.scrollX + vw - CARD_MARGIN) return null;
    return { top: clampTop(rect.top + window.scrollY), left: l, caret: preferBelow ? "top" : "bottom" };
  }
  function leftOf(): { top: number; left: number; caret: "top" | "bottom" } | null {
    const l = rect.left + window.scrollX - cardW - 10;
    if (l < window.scrollX + CARD_MARGIN) return null;
    return { top: clampTop(rect.top + window.scrollY), left: l, caret: preferBelow ? "top" : "bottom" };
  }
  // Last resort: stay below the target, but push down past the bottom edge
  // of every interactive element the default "below" spot actually hit —
  // guarantees the CTA(s) that caused the occlusion are cleared.
  function offset(hits: HTMLElement[]): { top: number; left: number; caret: "top" | "bottom" } {
    let maxBottom = rect.bottom;
    for (const h of hits) {
      const r = h.getBoundingClientRect();
      if (r.bottom > maxBottom) maxBottom = r.bottom;
    }
    return { top: clampTop(maxBottom + window.scrollY + 10), left: clampLeft(rect.left + window.scrollX), caret: "top" };
  }
  function viewportRectOf(p: { top: number; left: number }) {
    const vt = p.top - window.scrollY;
    const vl = p.left - window.scrollX;
    return { top: vt, left: vl, right: vl + cardW, bottom: vt + cardH };
  }

  const candidates = interactiveOcclusionCandidates([el, cardEl]);
  const initialPos = preferBelow ? below() : above();
  let chosen = initialPos;
  let placement: CardPlacement = preferBelow ? "below" : "above";
  let hits = intersectingCandidates(viewportRectOf(initialPos), candidates);
  if (hits.length > 0) {
    const tryOrder: Array<[CardPlacement, () => { top: number; left: number; caret: "top" | "bottom" } | null]> = [
      [preferBelow ? "above" : "below", preferBelow ? above : below],
      ["right", rightOf],
      ["left", leftOf],
    ];
    let resolved = false;
    for (const [mode, fn] of tryOrder) {
      const pos = fn();
      if (!pos) continue;
      if (intersectingCandidates(viewportRectOf(pos), candidates).length === 0) {
        chosen = pos;
        placement = mode;
        resolved = true;
        break;
      }
    }
    if (!resolved) {
      chosen = offset(hits);
      placement = "offset";
    }
  }

  const top = chosen.top;
  const left = chosen.left;
  const caretTargetX = rect.left + window.scrollX + Math.min(rect.width, 32) / 2;
  const caretLeft = Math.max(16, Math.min(cardW - 16, caretTargetX - left));
  return { mode: "anchored", top, left, caret: chosen.caret, caretLeft, placement };
}

// Card-over-modal occlusion defect class (finding A): unlike the interactive-
// element check above (used to CHOOSE a position), a host-page modal opening
// over the target AFTER the card is already anchored can't be dodged by
// repositioning — the card would just cover the modal (and its Close
// button) wherever it goes. Instead the card goes invisible (state kept)
// while its target isn't the topmost element at its own centre point, and
// reappears automatically once it is again. Checked every positionCardNow()
// poll tick. Mirrored in server/public/agent.js.
function isTargetOccluded(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false; // off-screen, not a modal case
  const hit = document.elementFromPoint(cx, cy);
  if (!hit) return false;
  return hit !== el && !el.contains(hit) && !hit.contains(el);
}

/** Card look #3: a pick_size CTA whose size is already the one selected on
 * the page (e.g. the jacket defaults to L and the card says "Try size L")
 * is a no-op tap — show it as an already-done state instead. Reads the
 * live DOM (same size-picker markup runCardCta's pick_size case uses)
 * rather than tracked state, since the shopper can select a size by hand
 * without going through the card at all. */
function pickSizeCurrentlySelected(value: string | null): boolean {
  if (!value) return false;
  const picker = document.querySelector<HTMLElement>('[data-agent-target="size-picker"]');
  const btn = Array.from(picker?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
    (b) => b.textContent?.trim() === value
  );
  return btn?.getAttribute("aria-pressed") === "true";
}

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

// per-element-dwell-is-viewport-time defect class: an element used to be
// counted as "dwelled on" purely for being inside the viewport, so every
// above-the-fold element (size guide, size picker, ...) looked exactly like
// page dwell to the decider — every reader looked like a hesitator. Fixed by
// switching to ATTENTION time, accumulated only while hovered, focused,
// tapped, "scrolled into view" (i.e. NOT visible at first paint — see
// isInViewport below — and then intersecting), or within a short heuristic
// window after a click (a proxy for "opened a modal and is looking at it",
// since the widget can't generally know a modal is open). See
// server/public/agent.js's matching tracker for the identical semantics.
function isCoarsePointer() {
  return typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
}

const MODAL_HEURISTIC_MS = 15000; // see the click handler below
// per-element-dwell-is-viewport-time defect class (S4): scroll-into-view
// visibility alone must never grant unbounded attention — a target simply
// relocated below the fold (or a long page the shopper scrolls past) would
// otherwise accrue "attention" for as long as it happens to sit on screen,
// with no actual engagement. One-shot credit: at most SCROLL_CREDIT_MS of
// attention total from scroll-into-view visibility, ever, per target; once
// spent, only hover/focus/click can still grant attention. Mirrored in
// server/public/agent.js.
const SCROLL_CREDIT_MS = 5000;

type TargetAttentionState = {
  initiallyVisible: boolean; // visible (>=50% in viewport) the moment this target was first seen on this page — never eligible for the scroll-into-view pathway below, no matter what it does later
  eligibleForScroll: boolean; // = !initiallyVisible, fixed at creation
  scrolledIntoView: boolean; // eligible target has been observed intersecting at least once
  visible: boolean; // current IntersectionObserver state (only meaningful when eligibleForScroll)
  scrollVisibleSince: number | null; // start of the CURRENT scroll-credit-earning window (visible, credit not yet exhausted), null when not earning credit right now
  scrollCreditMs: number; // scroll-into-view credit already banked from CLOSED windows, capped at SCROLL_CREDIT_MS — see syncAttention()
  hovering: boolean;
  hoverSince: number;
  hoverMs: number;
  focused: boolean;
  focusSince: number;
  focusMs: number;
  clicks: number;
  modalUntil: number; // Date.now() deadline of an active click-modal heuristic window, 0 = none
  activeSince: number | null; // start of the current "any condition true" window, null when inactive
  cumMs: number; // accumulated attention ms from CLOSED windows (attentionTotal() adds the live one)
  lastBucket: number; // last DWELL_BUCKET_MS bucket already emitted for this target
};

function isInViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const visibleW = Math.min(r.right, vw) - Math.max(r.left, 0);
  const visibleH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
  if (visibleW <= 0 || visibleH <= 0) return false;
  const area = r.width * r.height;
  return area > 0 && (visibleW * visibleH) / area >= 0.5;
}

function scrollCreditTotal(s: TargetAttentionState, now: number): number {
  const live = s.scrollVisibleSince !== null ? now - s.scrollVisibleSince : 0;
  return Math.min(SCROLL_CREDIT_MS, s.scrollCreditMs + live);
}

function isTargetActive(s: TargetAttentionState, now: number): boolean {
  const scrollActive =
    s.eligibleForScroll && s.scrolledIntoView && s.visible && scrollCreditTotal(s, now) < SCROLL_CREDIT_MS;
  return s.hovering || s.focused || scrollActive || s.modalUntil > now;
}

/** Closes or opens the union "active" window as of `now`, folding elapsed
 * time into cumMs on close. Must be called after ANY mutation to the fields
 * isTargetActive() reads (hovering/focused/visible/modalUntil), and once per
 * tick so a modal-heuristic window's expiry (a change caused by time alone,
 * not an event) is still observed.
 *
 * Also maintains the scroll-into-view credit window (scrollVisibleSince/
 * scrollCreditMs) — same "call after any mutation, and once per tick" rule
 * applies, since the credit must stop accruing (closing its own window)
 * both when visibility changes AND purely from time passing (the 5s cap
 * itself is a time-only expiry, same shape as modalUntil's). */
function syncAttention(s: TargetAttentionState, now: number) {
  const scrollWantsOpen =
    s.eligibleForScroll && s.scrolledIntoView && s.visible && s.scrollCreditMs < SCROLL_CREDIT_MS;
  if (scrollWantsOpen && s.scrollVisibleSince === null) {
    s.scrollVisibleSince = now;
  } else if (!scrollWantsOpen && s.scrollVisibleSince !== null) {
    s.scrollCreditMs = Math.min(SCROLL_CREDIT_MS, s.scrollCreditMs + (now - s.scrollVisibleSince));
    s.scrollVisibleSince = null;
  }

  const active = isTargetActive(s, now);
  if (active && s.activeSince === null) {
    s.activeSince = now;
  } else if (!active && s.activeSince !== null) {
    s.cumMs += now - s.activeSince;
    s.activeSince = null;
  }
}

function attentionTotal(s: TargetAttentionState, now: number): number {
  return s.cumMs + (s.activeSince !== null ? now - s.activeSince : 0);
}
function hoverTotal(s: TargetAttentionState, now: number): number {
  return s.hoverMs + (s.hovering ? now - s.hoverSince : 0);
}
function focusTotal(s: TargetAttentionState, now: number): number {
  return s.focusMs + (s.focused ? now - s.focusSince : 0);
}

function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}

// Card-interrupts-typing defect class: popping a card/message while the
// shopper is mid-keystroke (search box, promo code field, checkout form)
// steals visual attention off what they're typing. Previous version applied
// this guard only at ACTION-RECEIPT time (a one-shot setTimeout deferring
// the reveal by exactly CARD_TYPING_DEFER_MS) — if the shopper kept typing
// past that fixed window, the timer fired anyway and revealed the card
// while they were still mid-sentence. Fixed by making it a RENDER-TIME
// predicate instead: isActivelyTyping() (below, inside the component) is
// re-evaluated continuously — on every keydown in a typing target, on
// blur/focusout, and on the 250ms poll — and the card/message are kept
// mounted (state preserved) but `visibility: hidden` for as long as it's
// true. Highlights/spotlights are untouched (they aren't gated by this).
// Mirrors server/public/agent.js.
const CARD_TYPING_DEFER_MS = 3000;
function isTypingTarget(node: Element | null): node is HTMLElement {
  if (!node) return false;
  const tag = node.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT") return true;
  return (node as HTMLElement).isContentEditable === true;
}

function currentTargets(): string[] {
  return Array.from(new Set(
    Array.from(document.querySelectorAll<HTMLElement>("[data-agent-target]"))
      .map((el) => el.dataset.agentTarget)
      .filter((t): t is string => Boolean(t))
  )).sort();
}

/** "Why?" line text for the bubble/highlight-chip footers: most recent
 * trace's hypothesis (fallback why) + confidence as a percentage, e.g.
 * "Cart is ৳50 under free delivery and you bounced from checkout · 82% sure".
 * Mirrored in server/public/agent.js's computeWhyText(). */
function traceWhyText(t: TraceEntry | undefined): string | null {
  if (!t) return null;
  const basis = t.hypothesis || t.why;
  if (!basis) return null;
  return `${basis} · ${Math.round(t.confidence * 100)}% sure`;
}

/** Collapse consecutive noop traces (newest-first list) into groups. */
type Row = { kind: "single"; trace: TraceEntry; key: string } | { kind: "group"; traces: TraceEntry[]; key: string };
function buildRows(traces: TraceEntry[]): Row[] {
  const rows: Row[] = [];
  let i = 0;
  while (i < traces.length) {
    if (traces[i].decision === "noop") {
      let j = i;
      while (j < traces.length && traces[j].decision === "noop") j++;
      const group = traces.slice(i, j);
      const key = `${group[0].ts}-${i}`;
      if (group.length > 1) rows.push({ kind: "group", traces: group, key });
      else rows.push({ kind: "single", trace: group[0], key });
      i = j;
    } else {
      rows.push({ kind: "single", trace: traces[i], key: `${traces[i].ts}-${i}` });
      i++;
    }
  }
  return rows;
}

export default function AgentWidget() {
  const [traces, setTraces] = useState<TraceEntry[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
  // Exit-fade defect class — same shape as exitingCard above, for the
  // message bubble.
  const [exitingMessage, setExitingMessage] = useState<Message | null>(null);
  const messageExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // On-page "card" action — a visible card with a title, one sentence of
  // help, and one CTA button. Unlike highlight/spotlight, this has NO
  // auto-expiry (coordinator decision 2026-09-11, same fix applied to the
  // message bubble below): a card/message stays until the shopper dismisses
  // it (×), takes the CTA, or navigates away. A fresh card/message replaces
  // whichever of the two is currently showing (only one visible at a time —
  // the replaced one is still in the tray, see addSuggestion).
  // shownAt: outcome tracking (server/RESEARCH.md "Outcomes" section) — see
  // Message's shownAt comment above, same purpose.
  // issuedPathname = the route the card's action arrived on — needed for the
  // pick_size navigation-persistence rule below (pathname effect).
  type CardState = {
    data: AgentAction;
    feedback: string | null;
    shownAt: number;
    issuedPathname: string;
  };
  const [cardState, setCardState] = useState<CardState | null>(null);
  // Exit-fade defect class: dismissing a card used to unmount it instantly
  // (no transition). exitingCard holds the just-dismissed card's data for
  // CARD_EXIT_MS after cardState goes null, purely so the DOM node stays
  // mounted long enough to play the CSS fade (see the render below and
  // .agent-page-card.is-exiting in globals.css) — skipped under
  // prefers-reduced-motion. A NEW card replacing this one always wins
  // (cardState becomes non-null again immediately, see the render's
  // `cardState ?? exitingCard`), so there's no race with a fresh show.
  const [exitingCard, setExitingCard] = useState<CardState | null>(null);
  const cardExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Card-interrupts-typing defect class: see isTypingTarget()/
  // CARD_TYPING_DEFER_MS above. lastTypingKeydownAtRef is updated on every
  // keydown inside a typing target; typingSuppressed is the render-time
  // predicate (re-evaluated on keydown/blur/the 250ms poll, see the effect
  // below) that hides the card/message while true. Applies to card AND
  // message — highlights/spotlights are untouched.
  const lastTypingKeydownAtRef = useRef<number>(0);
  const typingSuppressedRef = useRef(false);
  const [typingSuppressed, setTypingSuppressed] = useState(false);
  // Card-over-modal occlusion defect class (finding A): the card used to
  // render on top of a modal that opened over its target (e.g. the size
  // guide), covering the modal's own Close button with an unrelated CTA.
  // Rather than juggling z-index against every possible host overlay, the
  // card just goes invisible (state kept, no outcome reported) whenever its
  // target is no longer the topmost element at its own centre point —
  // re-shown automatically the next 250ms poll tick once it isn't. See
  // isTargetOccluded()/positionCardNow() below.
  const [cardOccluded, setCardOccluded] = useState(false);
  const [cardWhyOpen, setCardWhyOpen] = useState(false);
  // Card position: anchored next to its target, or a top banner when the
  // target isn't on the page / viewport is narrow. Recomputed by
  // positionCardNow() — see the effects below.
  const [cardPos, setCardPos] = useState<CardPos | null>(null);
  const cardElRef = useRef<HTMLDivElement>(null);
  const cardStateRef = useRef(cardState);
  // Global-Escape-dismisses-the-live-card/message defect class: read inside
  // a mount-once keydown listener (see the effect near closeAssistant),
  // kept in sync via the effect right below cardStateRef's sync effect.
  const messageRef = useRef(message);
  // Per-suggestion inline CTA feedback in the tray (e.g. "Added"), keyed by
  // suggestion id — separate from the live card's own `feedback` field so
  // replaying an old suggestion's CTA doesn't touch the live card's state.
  const [suggestionCtaFeedback, setSuggestionCtaFeedback] = useState<Record<string, string>>({});
  const [metrics, setMetrics] = useState<MetricsMessage | null>(null);
  const [agentEnabled, setAgentEnabled] = useState(true);
  // Dev trace panel: collapsed by default (it's a proof-of-work debug view,
  // not the shopper-facing help surface — that's the assistant panel below).
  const [panelOpen, setPanelOpen] = useState(false);
  const [bubbleWhyOpen, setBubbleWhyOpen] = useState(false);
  const [highlightWhyOpen, setHighlightWhyOpen] = useState(false);
  const [noticedWhyOpen, setNoticedWhyOpen] = useState(false);
  const [activeHighlight, setActiveHighlight] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [demoFixtures, setDemoFixtures] = useState<DemoFixture[]>([]);
  const [demoStatus, setDemoStatus] = useState<DemoStatus | null>(null);
  const [demoLine, setDemoLine] = useState<string | null>(null);
  // "thinking · Ns" indicator: a live decision takes 15-20s and quiet ticks
  // collapse into one trace row, so the panel can look frozen the whole
  // time. null when hidden (no trace overdue, or socket not open); a number
  // of elapsed seconds once it's been >3s since the last {kind:"trace"}
  // frame while the socket is open. See wsOpenRef/lastTraceAtRef below.
  const [thinkingSeconds, setThinkingSeconds] = useState<number | null>(null);

  // ---- persistent assistant panel (launcher + tray) -----------------------
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [unseenCount, setUnseenCount] = useState(0);
  const [expandedSuggestionWhy, setExpandedSuggestionWhy] = useState<Set<string>>(new Set());
  const [wsConnected, setWsConnected] = useState(false);
  const [debugAvailable, setDebugAvailable] = useState(false);
  const [decideStatus, setDecideStatus] = useState<string | null>(null);
  const [decideBusy, setDecideBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  // "now" tick so tray timestamps ("12s ago") stay live while the panel is open.
  const [, forceTick] = useState(0);

  const sessionRef = useRef<string>("");
  const agentEnabledRef = useRef(true);
  const pathname = usePathname();
  const router = useRouter();
  const demoWatchdogRef = useRef<{ fixture: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const wsOpenRef = useRef(false);
  const lastTraceAtRef = useRef<number>(Date.now());
  const latestTraceRef = useRef<TraceEntry | undefined>(undefined);
  const launcherBtnRef = useRef<HTMLButtonElement>(null);
  const assistantPanelRef = useRef<HTMLDivElement>(null);
  const assistantOpenRef = useRef(false);

  function clearDemoWatchdog() {
    if (demoWatchdogRef.current) {
      clearTimeout(demoWatchdogRef.current.timer);
      demoWatchdogRef.current = null;
    }
  }

  useEffect(() => {
    agentEnabledRef.current = agentEnabled;
  }, [agentEnabled]);

  // ---- in-page demo player (see DEMO.md "No-terminal demo") ----------------
  // GET /demo/fixtures only exists (200) when the server was started with
  // AGENT_DEBUG=1 — 404/network error means production, render nothing.
  useEffect(() => {
    let cancelled = false;
    fetch(`${HTTP}/demo/fixtures`)
      .then((res) => (res.ok ? res.json() : null))
      .then((list) => {
        if (cancelled || !Array.isArray(list)) return;
        setDemoFixtures(list);
        if (list.length > 0) setDebugAvailable(true);
      })
      .catch(() => {
        // production / no AGENT_DEBUG — panel stays clean, no demo row
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- tester tools gate ---------------------------------------------------
  // /demo/fixtures alone under-detects AGENT_DEBUG (it 200s [] outside
  // AGENT_MODE=cached even with AGENT_DEBUG=1 — see server/index.js) — probe
  // GET /sessions?limit=1 as a second signal, per the brief's contract.
  // Either probe succeeding is enough; both failing (production) hides the
  // tester tools section entirely rather than showing broken buttons.
  useEffect(() => {
    let cancelled = false;
    fetch(`${HTTP}/sessions?limit=1`)
      .then((res) => {
        if (!cancelled && res.ok) setDebugAvailable(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** POST /demo/play/<name> against the CURRENT tab's pinned session — only
   * valid once the tab is already on the fixture's session + page (callers
   * check that; see handleDemoClick and the `?agent_demo=` auto-play below). */
  function triggerPlay(name: string) {
    setDemoStatus({ fixture: name, state: "playing" });
    clearDemoWatchdog();
    fetch(`${HTTP}/demo/play/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Sending the current tab's pinned session keeps the server's 400
      // mismatch guard live end-to-end (it would otherwise never see a
      // session to compare against, since `{}` always short-circuits it).
      body: JSON.stringify({ session: sessionRef.current }),
    })
      .then(async (res) => {
        if (res.ok) {
          // 202 — playback proceeds async, watch WS for {kind:"demo", state:"end"|"error"}.
          const body = await res.json().catch(() => null as { estimatedMs?: number } | null);
          const estimatedMs = typeof body?.estimatedMs === "number" ? body.estimatedMs : 0;
          const timer = setTimeout(() => {
            setDemoStatus((prev) =>
              prev && prev.fixture === name && prev.state === "playing"
                ? { fixture: name, state: "error", message: "no end signal (reload?)" }
                : prev
            );
          }, estimatedMs * DEMO_WATCHDOG_MULTIPLIER + DEMO_WATCHDOG_PAD_MS);
          demoWatchdogRef.current = { fixture: name, timer };
          return;
        }
        // 400/409 etc — show the server's own message inline, verbatim.
        const body = await res.json().catch(() => ({}) as { error?: string });
        setDemoStatus({
          fixture: name,
          state: "error",
          message: res.status === 409 ? "already playing" : body.error || `HTTP ${res.status}`,
        });
      })
      .catch(() => {
        setDemoStatus({ fixture: name, state: "error", message: "network error" });
      });
  }

  function handleDemoClick(fx: DemoFixture) {
    if (sessionRef.current !== fx.session || pathname !== fx.page) {
      const url = new URL(fx.page, window.location.origin);
      url.searchParams.set("agent_session", fx.session);
      url.searchParams.set("agent_demo", fx.name);
      window.location.assign(url.toString());
      return;
    }
    triggerPlay(fx.name);
  }

  // ---- tracker -------------------------------------------------------------

  const emit = (type: EventType, target: string | null, meta?: Record<string, unknown>) => {
    const ev = { session: sessionRef.current, type, target, ts: Date.now(), meta };
    fetch(`${HTTP}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ev),
      keepalive: true,
    }).catch(() => {});
  };

  // ---- outcome tracking (server/RESEARCH.md "Outcomes" section) -----------
  // Records what the shopper DID after a non-noop action was shown, so the
  // team can tell right from wrong decisions instead of an action landing
  // and nothing about the reaction ever coming back. Covers every visible
  // action kind (card, message, highlight, spotlight, scroll_to) via
  // whichever surface actually represents it — the live on-page
  // card/bubble/chip while agentEnabled, and always the tray ("Show me" /
  // Dismiss), which every non-noop action gets a permanent entry in
  // regardless of agentEnabled (see addSuggestion, called unconditionally
  // in the WS onmessage handler below).
  //
  // reportedOutcomeIds: exactly ONE outcome per action id — the client-side
  // half of that guarantee (live-record.js's recordOutcome() is the
  // server-side half, deduping independently as defense in depth).
  const reportedOutcomeIds = useRef<Set<string>>(new Set());
  // pendingActionInfo: action id -> { action, target, ctaKind } for every
  // non-noop action seen this session, populated once in onmessage right
  // after addSuggestion — the one place that's guaranteed to run for every
  // action kind regardless of which live slot (if any) ends up displaying
  // it. Looked up by reportOutcomeOnce() so call sites only need to pass an
  // id + outcome + shownAt.
  const pendingActionInfo = useRef<Map<string, { action: string; target: string | null; ctaKind?: string }>>(
    new Map()
  );

  function emitOutcome(
    actionId: string,
    action: string,
    target: string | null,
    ctaKind: string | undefined,
    outcome: OutcomeKind,
    shownAt: number
  ) {
    const ev = {
      session: sessionRef.current,
      type: "agent_outcome" as const,
      target,
      ts: Date.now(),
      meta: {
        action_id: actionId,
        action,
        ...(ctaKind ? { cta_kind: ctaKind } : {}),
        outcome,
        ms_visible: Math.max(0, Date.now() - shownAt),
      },
    };
    // keepalive: true (same as emit() above) so a report fired from a
    // visibilitychange/pagehide handler right before the tab closes still
    // has a chance to land — the brief's "sendBeacon or fetch keepalive"
    // requirement, satisfied via the tracker's existing convention.
    fetch(`${HTTP}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ev),
      keepalive: true,
    }).catch(() => {});
  }

  /** reportOutcomeOnce(actionId, outcome, shownAt) — the single entry point
   * every live-slot end condition (×, CTA, Turn off, navigation, replaced,
   * tab hidden/unload) and every tray action (Show me, Dismiss) calls. A
   * no-op if actionId is missing (an action from before this feature
   * shipped) or already reported. */
  function reportOutcomeOnce(actionId: string | undefined, outcome: OutcomeKind, shownAt: number) {
    if (!actionId) return;
    if (reportedOutcomeIds.current.has(actionId)) return;
    reportedOutcomeIds.current.add(actionId);
    const info = pendingActionInfo.current.get(actionId);
    emitOutcome(actionId, info?.action ?? "unknown", info?.target ?? null, info?.ctaKind, outcome, shownAt);
  }

  // ---- one-time setup: session, executor, all delegated listeners ----------

  const lastTargetsKeyRef = useRef<string>("");
  // B2: page-level dwell clock start — reset on every route change (the
  // pathname effect below), not just once at mount. See that effect and the
  // mount effect's dwellHeartbeat setup for the defect this fixes.
  const pageStartRef = useRef<number>(Date.now());
  const dwellStateRef = useRef<Map<string, TargetAttentionState>>(new Map());
  const hoveredTargetRef = useRef<string | null>(null);
  const dwellObserverRef = useRef<IntersectionObserver | null>(null);
  const clickTimestampsRef = useRef<Map<string, number[]>>(new Map());

  function getOrCreateAttentionState(target: string, el: HTMLElement | null, now: number): TargetAttentionState {
    let s = dwellStateRef.current.get(target);
    if (!s) {
      const initiallyVisible = el ? isInViewport(el) : false;
      s = {
        initiallyVisible,
        eligibleForScroll: !initiallyVisible,
        scrolledIntoView: false,
        visible: false,
        scrollVisibleSince: null,
        scrollCreditMs: 0,
        hovering: false,
        hoverSince: 0,
        hoverMs: 0,
        focused: false,
        focusSince: 0,
        focusMs: 0,
        clicks: 0,
        modalUntil: 0,
        activeSince: null,
        cumMs: 0,
        lastBucket: 0,
      };
      dwellStateRef.current.set(target, s);
    }
    return s;
  }
  const scrollAchievedRef = useRef<Set<number>>(new Set());
  // actionId/action: outcome tracking (server/RESEARCH.md "Outcomes"
  // section) — action is "highlight" | "spotlight", the two kinds this
  // effect ever tracks.
  const activeEffectRef = useRef<{
    el: HTMLElement;
    cls: string;
    timer: ReturnType<typeof setTimeout>;
    spotlight?: boolean;
    startedAt: number;
    actionId?: string;
    action: "highlight" | "spotlight";
    target: string | null;
  } | null>(null);
  const EFFECT_GRACE_MS = 5000; // an unrelated click can't dismiss a fresh effect for this long — see onDocumentClick
  const messageTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearMessageTimer() {
    if (messageTimerRef.current) {
      clearTimeout(messageTimerRef.current);
      messageTimerRef.current = null;
    }
  }

  function rescan() {
    const targets = currentTargets();
    const key = targets.join("|");
    if (key !== lastTargetsKeyRef.current) {
      lastTargetsKeyRef.current = key;
      capturePageLabel(window.location.pathname);
      emit("page_view", window.location.pathname, { targets });
    }
    setupDwellObserver();
  }

  function setupDwellObserver() {
    dwellObserverRef.current?.disconnect();
    // disconnect() does NOT fire a final "not intersecting" callback for
    // elements that were visible — e.g. an element removed from the DOM by
    // a route change or a modal close never gets its trailing leave event,
    // so its dwellStateRef entry would stay `visible: true` forever, and
    // (were it eligible for the scroll pathway) keep accruing attention
    // indefinitely after the shopper has left the product page. Mark any
    // currently-visible entry invisible and resync its active window before
    // disconnecting — the freshly (re-)observed elements will flip back to
    // visible on the new observer's initial callback if they're still on
    // the page.
    const now = Date.now();
    dwellStateRef.current.forEach((state) => {
      if (state.visible) {
        state.visible = false;
        syncAttention(state, now);
      }
    });
    const observer = new IntersectionObserver(
      (entries) => {
        const now2 = Date.now();
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const target = el.dataset.agentTarget;
          if (!target) continue;
          const state = getOrCreateAttentionState(target, el, now2);
          if (entry.isIntersecting) {
            if (state.eligibleForScroll) state.scrolledIntoView = true;
            state.visible = true;
          } else {
            state.visible = false;
          }
          syncAttention(state, now2);
        }
      },
      // IO config drift note: this client registers a single threshold
      // (0.5) and reads `entry.isIntersecting` directly — under a single
      // threshold that already means ">=50% visible". server/public/
      // agent.js's observer instead registers threshold: [0, 0.5, 1] and
      // separately checks `intersectionRatio >= 0.5` on each callback. Both
      // are semantically equivalent for "visible" (each fires exactly at
      // the 50% crossing either way) — this is a known, INTENTIONAL
      // difference between the two implementations, not something to
      // "align" into an actual behavioral mismatch; if you touch one,
      // verify the other still means the same thing.
      { threshold: 0.5 }
    );
    // Creating the attention-state entry HERE (synchronously, before the
    // observer's first async callback) is what makes `initiallyVisible`
    // mean "visible at first paint": for a target seen for the first time
    // ever on this page, isInViewport() is checked against the DOM's
    // current layout right now, not after a scroll has had a chance to
    // happen. A target discovered later (e.g. a modal's contents, added by
    // a DOM mutation well after mount) is NOT "at first paint" even if it
    // happens to be visible the instant it's discovered — it's checked
    // against the eligibleForScroll pathway from here on, same as anything
    // scrolled into view.
    document.querySelectorAll<HTMLElement>("[data-agent-target]").forEach((el) => {
      const target = el.dataset.agentTarget;
      if (target) getOrCreateAttentionState(target, el, now);
      observer.observe(el);
    });
    dwellObserverRef.current = observer;
  }

  /** markSuggestionResolved(actionId, outcome) — tray/badge-desync defect
   * class fix: called alongside every reportOutcomeOnce() for a live-slot
   * end condition (highlight/spotlight clear, card dismiss/CTA, message
   * dismiss), so the matching tray entry (same actionId) stops looking
   * live — its Show me/CTA controls go inert and it drops out of
   * unseenCount (see countUnseen). Idempotent (checks `resolved` first) and
   * a no-op if no tray entry exists yet for this id (e.g. addSuggestion
   * hasn't run) — safe to call unconditionally. */
  function markSuggestionResolved(actionId: string | undefined, outcome: OutcomeKind) {
    if (!actionId) return;
    setSuggestions((prev) => {
      let changed = false;
      const next = prev.map((s) => {
        if (s.actionId === actionId && !s.resolved) {
          changed = true;
          return { ...s, resolved: outcome };
        }
        return s;
      });
      if (!changed) return prev;
      saveSuggestions(next);
      setUnseenCount(countUnseen(next, loadSeenAt()));
      return next;
    });
  }

  /** clearActiveEffect(reason) — ends the live highlight/spotlight chip.
   * `reason` is the outcome to report for it (default "dismiss" — the ×/
   * on-target/elsewhere-click paths below), UNLESS it's already been
   * reported (reportOutcomeOnce is idempotent). Pass "ignored" when a NEW
   * highlight/spotlight is about to replace this one, "navigated" from the
   * route-change effect, "turn_off" from disableAgent. A natural
   * duration_ms timeout does NOT call this — see the two setTimeout
   * callbacks in applyAction's highlight/spotlight cases, which clean up
   * inline without going through here (no outcome kind fits a plain
   * timeout, so none is reported for that end condition). */
  function clearActiveEffect(reason: OutcomeKind = "dismiss") {
    const active = activeEffectRef.current;
    if (!active) return;
    clearTimeout(active.timer);
    active.el.classList.remove(active.cls);
    if (active.spotlight) document.body.classList.remove("agent-dim");
    activeEffectRef.current = null;
    setActiveHighlight(false);
    setHighlightWhyOpen(false);
    reportOutcomeOnce(active.actionId, reason, active.startedAt);
    markSuggestionResolved(active.actionId, reason);
  }

  /** dismissCard(reason) — same shape as clearActiveEffect() above, for the
   * on-page card. Uses setCardState's functional form so the outcome report
   * always sees the true latest card (not a possibly-stale closure) — see
   * the "replaced by a newer card" call site in applyAction's "card" case. */
  function dismissCard(reason: OutcomeKind = "dismiss") {
    setCardState((prev) => {
      if (prev) {
        reportOutcomeOnce(prev.data.id, reason, prev.shownAt);
        markSuggestionResolved(prev.data.id, reason);
        // Exit-fade defect class: keep the just-dismissed card mounted
        // (via exitingCard) for CARD_EXIT_MS so the CSS fade can play,
        // skipped entirely under reduced motion. A fresh card replacing
        // this one (cardState set non-null again right after) always wins
        // in the render below regardless of this timer.
        if (!prefersReducedMotion()) {
          if (cardExitTimerRef.current) clearTimeout(cardExitTimerRef.current);
          setExitingCard(prev);
          cardExitTimerRef.current = setTimeout(() => {
            setExitingCard(null);
            cardExitTimerRef.current = null;
          }, CARD_EXIT_MS);
        }
      }
      return null;
    });
    setCardWhyOpen(false);
    setCardOccluded(false);
  }

  /** clearMessageBubble(reason) — same shape as dismissCard() above, for
   * the message bubble. */
  function clearMessageBubble(reason: OutcomeKind = "dismiss") {
    clearMessageTimer();
    setMessage((prev) => {
      if (prev) {
        reportOutcomeOnce(prev.id, reason, prev.shownAt);
        markSuggestionResolved(prev.id, reason);
        if (!prefersReducedMotion()) {
          if (messageExitTimerRef.current) clearTimeout(messageExitTimerRef.current);
          setExitingMessage(prev);
          messageExitTimerRef.current = setTimeout(() => {
            setExitingMessage(null);
            messageExitTimerRef.current = null;
          }, CARD_EXIT_MS);
        }
      }
      return null;
    });
    setBubbleWhyOpen(false);
  }

  /** Recomputes the live card's position against its current target —
   * called right after a card is shown/re-anchored, on a 250ms poll while
   * one is showing (target layout can shift — e.g. a size button
   * re-rendering — without any resize/scroll event), on resize/scroll
   * (rAF-throttled, see effect below), on window `load`, and again in the
   * pathname effect on navigation. Reads cardStateRef (not cardState) so it
   * stays correct inside listeners/intervals set up once at mount, not
   * re-bound on every card change.
   *
   * Does NOT scroll — scroll-jail defect class: re-scrolling into view on
   * every poll/scroll tick yanks back a shopper who deliberately scrolled
   * away. Scrolling into view happens exactly once, in the cardState effect
   * below, at the moment a card is first shown.
   *
   * Also handles: target removed from the page since the card was shown
   * (dismiss as "ignored" instead of leaving a permanent banner — finding
   * 13), and the card-over-modal occlusion check (finding A). */
  function positionCardNow() {
    const cs = cardStateRef.current;
    if (!cs) return;
    const target = cs.data.target;
    const el = targetEl(target);
    if (target && !el) {
      dismissCard("ignored");
      return;
    }
    setCardOccluded(el ? isTargetOccluded(el) : false);
    setCardPos(computeCardPosition(target, cardElRef.current));
  }

  /** Card-interrupts-typing defect class, render-time guard: true while
   * document.activeElement is a text input/textarea/contenteditable AND the
   * last keydown inside it was less than CARD_TYPING_DEFER_MS ago. Read at
   * render time (see displayCard/displayMessage className below) rather
   * than gating the initial setCardState/setMessage call, so continued
   * typing keeps suppressing it — a single fixed timer from action-receipt
   * time no longer resolves the guard early. */
  function isActivelyTyping(): boolean {
    // Evidence-based, not focus-based: a keystroke/input in a typing field
    // within the window suppresses, whatever activeElement reports (inputs
    // that re-render per keystroke briefly report body). focusout clears.
    return Date.now() - lastTypingKeydownAtRef.current < CARD_TYPING_DEFER_MS;
  }
  function syncTypingSuppression() {
    const v = isActivelyTyping();
    if (typingSuppressedRef.current !== v) {
      typingSuppressedRef.current = v;
      setTypingSuppressed(v);
    }
  }

  // ---- card CTA executor ------------------------------------------------
  // Trusted code, allow-list only (contracts.ts's CardCtaKind) — anything
  // else, or a kind whose required page context is missing, logs + no-ops
  // rather than guessing. Shared by the live on-page card's button and the
  // tray's replay of an older card suggestion (handleTraySuggestionCta), so
  // a CTA works the same way whenever it's tapped.
  function runCardCta(cta: AgentCard["cta"]): string | null {
    switch (cta.kind) {
      case "pick_size": {
        // Mechanism per ProductClient.tsx: sizes are plain buttons (no
        // per-size data-agent-target), so match on the rendered label
        // inside the size-picker rather than an attribute selector.
        const picker = document.querySelector<HTMLElement>('[data-agent-target="size-picker"]');
        const btn = cta.value
          ? Array.from(picker?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
              (b) => b.textContent?.trim() === cta.value
            )
          : undefined;
        if (!btn) {
          console.warn("[agent card] pick_size: no matching size-picker button for", cta.value);
          return null;
        }
        btn.click(); // real click — sets state via ProductClient's own handler, counts as attention like any other click
        btn.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
        btn.classList.add("agent-pulse");
        setTimeout(() => btn.classList.remove("agent-pulse"), SHOW_ME_PULSE_MS);
        return null;
      }
      case "add_to_cart": {
        const product = cta.value ? getProduct(cta.value) : undefined;
        if (!product) {
          console.warn("[agent card] add_to_cart: unknown product slug", cta.value);
          return null;
        }
        // addToCart() notifies the cart store's listeners, which the mount
        // effect's subscribeCart() callback already turns into a
        // "cart_update" tracker event — no separate emit() needed here.
        addToCart(product.slug, product.name, product.price, 1);
        return "Added";
      }
      case "apply_code": {
        if (!cta.value) {
          console.warn("[agent card] apply_code: no code");
          return null;
        }
        const result = applyPromo(cta.value); // also drives subscribeCart() -> cart_update
        if (!result.ok) return result.error;
        const primary = getPrimaryPromoMeta(); // computed via cartDiscount() in lib/cart.ts
        return primary ? `Applied — ৳ ${primary.discount.toLocaleString("en-BD")} off` : "Applied";
      }
      case "open_product": {
        if (!cta.value) {
          console.warn("[agent card] open_product: no slug");
          return null;
        }
        router.push("/product/" + cta.value); // pathname effect below emits the resulting page_view naturally
        return null;
      }
      case "search": {
        // No dedicated /search route in this storefront — focus the header
        // search box and set its value instead (see Nav.tsx). Dispatching a
        // real "input" event lets the tracker's existing debounced search
        // listener (mount effect's onInput) emit the "search" event, same
        // as if the shopper had typed it.
        if (!cta.value) return null;
        const input = document.querySelector<HTMLInputElement>('[data-agent-target="search"]');
        if (!input) {
          console.warn("[agent card] search: no search input on this page");
          return null;
        }
        input.value = cta.value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
        input.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
        return null;
      }
      case "none":
      default:
        return null;
    }
  }

  /** Live card's CTA button. Executes the CTA, shows any inline feedback
   * text on the button briefly, then dismisses the card — "the CTA is
   * taken" is one of the card's three end conditions (×, CTA, navigation). */
  function handleCardCtaClick() {
    if (!cardState) return;
    const cta = cardState.data.card?.cta;
    if (!cta) return;
    reportOutcomeOnce(cardState.data.id, "cta", cardState.shownAt);
    const feedback = runCardCta(cta);
    if (feedback) {
      setCardState((prev) => (prev ? { ...prev, feedback } : prev));
      setTimeout(() => dismissCard("cta"), 1200);
    } else {
      dismissCard("cta");
    }
  }

  /** Tray replay of an old card suggestion's CTA — same executor, own
   * (per-suggestion) inline feedback so it never touches the live card.
   * Outcome: "cta" (same bucket as the live card's own CTA button). */
  function handleTraySuggestionCta(s: Suggestion) {
    if (!s.cta) return;
    reportOutcomeOnce(s.actionId, "cta", s.ts);
    markSuggestionResolved(s.actionId, "cta");
    const feedback = runCardCta(s.cta);
    if (!feedback) return;
    setSuggestionCtaFeedback((prev) => ({ ...prev, [s.id]: feedback }));
    setTimeout(() => {
      setSuggestionCtaFeedback((prev) => {
        if (!(s.id in prev)) return prev;
        const next = { ...prev };
        delete next[s.id];
        return next;
      });
    }, 2000);
  }

  // ---- card positioning effects ------------------------------------------
  // Keep cardStateRef in sync so positionCardNow (used inside listeners/
  // intervals set up once, below) always reads the current card, not a
  // stale closure from whenever the effect first ran.
  useEffect(() => {
    cardStateRef.current = cardState;
  }, [cardState]);
  useEffect(() => {
    messageRef.current = message;
  }, [message]);

  // Position (or clear) whenever the card itself changes, and keep polling
  // every 250ms while one is showing — cheap way to catch the target's own
  // layout shifting (e.g. a size button re-rendering) without a
  // MutationObserver. useLayoutEffect so the first position is applied
  // before paint (no visible flash at the wrong spot).
  useLayoutEffect(() => {
    if (!cardState) {
      // Exit-fade defect class: don't clear the last position while
      // exitingCard is still playing its fade-out at that exact spot.
      if (!exitingCard) setCardPos(null);
      return;
    }
    // Scroll-jail defect class: scroll into view exactly ONCE, here, at the
    // moment a card is (re-)shown — never inside positionCardNow's poll.
    const el = targetEl(cardState.data.target);
    if (el && !isInViewport(el)) {
      el.scrollIntoView({ block: "center", behavior: scrollBehavior() });
    }
    positionCardNow();
    const id = setInterval(positionCardNow, 250);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardState]);

  // Reposition on resize/scroll (rAF-throttled) and on window `load` — bound
  // once at mount; positionCardNow no-ops via cardStateRef when no card is
  // showing, so these are safe to leave attached at all times.
  useEffect(() => {
    let rafId: number | null = null;
    const reposition = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        positionCardNow();
      });
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true); // capture: any scrollable ancestor, not just the window
    window.addEventListener("load", reposition);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("load", reposition);
      if (rafId != null) cancelAnimationFrame(rafId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Card-interrupts-typing defect class: keep typingSuppressed current by
  // re-checking on every keydown inside a typing target (captures, so it
  // fires regardless of which element the keydown bubbles through), on
  // focusout (a microtask delay lets document.activeElement settle on the
  // newly-focused element first), and on a 250ms poll — the same cadence as
  // positionCardNow but independent of it (a message-only, no-card state
  // still needs this to keep re-checking idle time). Bound once at mount.
  useEffect(() => {
    const onKeydown = (e: Event) => {
      if (isTypingTarget(e.target as Element | null)) {
        lastTypingKeydownAtRef.current = Date.now();
        syncTypingSuppression();
      }
    };
    const onFocusOut = (e: Event) => {
      if (isTypingTarget(e.target as Element | null)) lastTypingKeydownAtRef.current = 0;
      setTimeout(syncTypingSuppression, 0);
    };
    // keydown AND input: paste, autofill, IME composition and some automation
    // produce input events without per-character keydowns.
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("input", onKeydown, true);
    document.addEventListener("focusout", onFocusOut, true);
    const id = setInterval(syncTypingSuppression, 250);
    return () => {
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("input", onKeydown, true);
      document.removeEventListener("focusout", onFocusOut, true);
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- executor (highlight/spotlight/scroll_to/message/card) ---------------
  // Defined at component scope (not inside the mount effect below) so the
  // dev-only window.__agentInject() hook can drive the exact same code path
  // as a real WS-delivered action — see that effect further down.
  function applyAction(a: AgentAction) {
    // Agent-off: keep tracking (traces still arrive) but never touch the
    // DOM. The trace panel marks the corresponding trace as suppressed.
    if (!agentEnabledRef.current && a.action !== "noop") return;

    const el = targetEl(a.target);
    switch (a.action) {
      case "highlight": {
        if (!el) return;
        // A NEW effect replacing a still-live one is "ignored" for the old
        // one (never dismissed/interacted with, just superseded).
        clearActiveEffect("ignored");
        const cls = a.style === "outline" ? "agent-outline" : "agent-pulse";
        el.classList.add(cls);
        const timer = setTimeout(() => {
          el.classList.remove(cls);
          if (activeEffectRef.current?.el === el) {
            activeEffectRef.current = null;
            setActiveHighlight(false);
            setHighlightWhyOpen(false);
          }
          // Natural duration_ms expiry — not one of the five tracked
          // outcomes (cta/dismiss/turn_off/navigated/ignored), so nothing
          // is reported here; the id stays resolvable later via the tray.
        }, a.duration_ms || 20000);
        activeEffectRef.current = { el, cls, timer, startedAt: Date.now(), actionId: a.id, action: "highlight", target: a.target };
        setActiveHighlight(true);
        break;
      }
      case "spotlight": {
        if (!el) return;
        clearActiveEffect("ignored");
        document.body.classList.add("agent-dim");
        el.classList.add("agent-spotlight");
        const timer = setTimeout(() => {
          document.body.classList.remove("agent-dim");
          el.classList.remove("agent-spotlight");
          if (activeEffectRef.current?.el === el) {
            activeEffectRef.current = null;
            setActiveHighlight(false);
            setHighlightWhyOpen(false);
          }
        }, a.duration_ms || 20000);
        activeEffectRef.current = {
          el,
          cls: "agent-spotlight",
          timer,
          spotlight: true,
          startedAt: Date.now(),
          actionId: a.id,
          action: "spotlight",
          target: a.target,
        };
        setActiveHighlight(true);
        break;
      }
      case "scroll_to": {
        // No lingering on-page affordance (no chip) — its outcome is
        // resolved right here instead of via a live slot: "cta" if it
        // actually found and scrolled to its target (the action did
        // something), "ignored" if the target wasn't on this page (or the
        // agent is off — see the early return above, which means this
        // branch never even runs in that case, leaving the id to be
        // resolved later via the tray's Show me/Dismiss instead).
        const found = !!el;
        if (found) el.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
        reportOutcomeOnce(a.id, found ? "cta" : "ignored", Date.now());
        break;
      }
      case "message": {
        if (!a.message) return;
        // No auto-expiry (coordinator decision 2026-09-11): a message stays
        // until ×, "Turn off", or navigation — duration_ms is ignored here
        // (still honored for highlight/spotlight above). A fresh message
        // also replaces any currently-showing card (only one visible at a
        // time in this corner; the card survives in the tray) — "ignored"
        // for that old card, same rationale as highlight/spotlight above.
        dismissCard("ignored");
        const text =
          a.message.length > MESSAGE_MAX_CHARS ? a.message.slice(0, MESSAGE_MAX_CHARS - 1) + "…" : a.message;
        // A new message replacing a still-showing old message is also
        // "ignored" for the old one — clearMessageBubble's functional
        // setMessage form handles that (a no-op if there was no old
        // message to report for).
        clearMessageBubble("ignored");
        setMessage({ text, target: a.target, id: a.id, shownAt: Date.now() });
        // Session 2 decision (option b): a message carrying a target also
        // scrolls the shopper to it instead of requiring a second action.
        if (a.target) el?.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
        break;
      }
      case "card": {
        if (!a.card) return;
        // No defer-on-receipt here anymore — the typing guard is a
        // render-time predicate (typingSuppressed) applied below, so the
        // card/message state is always set immediately and the render
        // itself decides whether it's visible right now.
        // Same no-auto-expiry rule as message, and replaces any
        // currently-showing message bubble (only one visible at a time)
        // — "ignored" for that old message.
        clearMessageBubble("ignored");
        setCardWhyOpen(false);
        // A new card replacing a still-showing old card is also
        // "ignored" for the old one (dismissCard's functional
        // setCardState form handles that; no-op if there was no old
        // card).
        dismissCard("ignored");
        setCardState({ data: a, feedback: null, shownAt: Date.now(), issuedPathname: pathname });
        // Positioning (anchor-to-target or banner) is handled by the
        // cardState effect below, which also does the off-screen
        // scrollIntoView — no separate scroll here.
        break;
      }
      case "noop":
        break;
    }
  }

  useEffect(() => {
    sessionRef.current = getSessionId();

    const storedEnabled = storage.get("agent_enabled");
    if (storedEnabled != null) {
      const v = storedEnabled === "1";
      setAgentEnabled(v);
      agentEnabledRef.current = v;
    }
    const storedPanel = storage.get("agent_panel_open");
    if (storedPanel != null) setPanelOpen(storedPanel === "1");

    const restoredSuggestions = loadSuggestions();
    setSuggestions(restoredSuggestions);
    setUnseenCount(countUnseen(restoredSuggestions, loadSeenAt()));

    // The initial page_view + dwell observer setup for the FIRST page load
    // is handled by the pathname effect below (it runs once on mount too,
    // same as this effect, and is now the ONLY place page_view is emitted —
    // see that effect's comment for why "emit unconditionally, keyed by
    // pathname+targets" replaced the old "emit only if the target SET
    // changed" rescan() call here).
    lastTargetsKeyRef.current = currentTargets().join("|");

    // Page-level dwell heartbeat. pageStartRef is reset on every route
    // change by the pathname effect below (B2: previously a plain local
    // `const pageStart` captured once at mount and never reset, so the
    // FIRST heartbeat on a newly-navigated-to page reported dwell since the
    // widget originally mounted — potentially minutes — instead of dwell on
    // the new page).
    pageStartRef.current = Date.now();
    const dwellHeartbeat = setInterval(
      () => emit("dwell", window.location.pathname, { ms: Date.now() - pageStartRef.current }),
      DWELL_HEARTBEAT_MS
    );

    // Per-element dwell: fires every DWELL_BUCKET_MS of cumulative ATTENTION
    // (hover/focus/tap/scroll-into-view/click-modal-heuristic — see
    // TargetAttentionState), never mere viewport visibility. Also the only
    // place a modal-heuristic window's expiry (time passing with no new
    // event) gets observed, via syncAttention().
    const touch = isCoarsePointer();
    const dwellTick = setInterval(() => {
      const now = Date.now();
      dwellStateRef.current.forEach((state, target) => {
        syncAttention(state, now);
        const total = attentionTotal(state, now);
        if (total <= 0) return;
        const bucket = Math.floor(total / DWELL_BUCKET_MS);
        if (bucket > state.lastBucket && total >= DWELL_BUCKET_MS) {
          state.lastBucket = bucket;
          emit("dwell", target, {
            ms: total,
            kind: "attention",
            interactions: {
              hover_ms: Math.round(hoverTotal(state, now)),
              focus_ms: Math.round(focusTotal(state, now)),
              clicks: state.clicks,
              scrolled_to: state.scrolledIntoView,
            },
            ...(touch ? { touch: true } : {}),
          });
        }
      });
    }, DWELL_TICK_MS);

    // Re-scan targets after DOM mutations (modal open/close, etc.), debounced.
    let rescanTimer: ReturnType<typeof setTimeout> | null = null;
    const mutationObserver = new MutationObserver(() => {
      if (rescanTimer) clearTimeout(rescanTimer);
      rescanTimer = setTimeout(rescan, RESCAN_DEBOUNCE_MS);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    // Clicks: clear any active highlight/spotlight early (user stays in
    // control), and detect rage clicks (>=3 on the same target within 1.5s).
    const onDocumentClick = (e: MouseEvent) => {
      // Clicks on the widget's own UI (bubble, chip, pill, panel) are not
      // page clicks: they must not dismiss the effect they belong to (the
      // chip/bubble's own × already calls clearActiveEffect() directly —
      // see dismissHighlight/disableAgent), and they are never rage clicks.
      if ((e.target as HTMLElement).closest("[data-agent-ui]")) return;
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-agent-target]");
      // Fixed-short-effect-lifetime defect class: a highlight/spotlight used
      // to be dismissed by ANY click anywhere on the page, including one
      // that has nothing to do with it — with a slow (15-22s live) decider,
      // an incidental click while reading could kill help the shopper
      // hadn't even seen yet. Now it ends on the earliest of its duration,
      // an interaction with it (clicking its own target — a click on
      // page/agent UI counts as interaction, see the return above and the
      // chip's own dismiss button), or navigation away (the route-change
      // effect below) — never earlier. An unrelated click still counts as
      // "shopper is doing something else" and dismisses it, but only once
      // it's had EFFECT_GRACE_MS to actually be seen.
      const active = activeEffectRef.current;
      if (active) {
        const isActiveTargetClick = !!el && active.el === el;
        const elapsedSinceEffect = Date.now() - active.startedAt;
        if (isActiveTargetClick || elapsedSinceEffect >= EFFECT_GRACE_MS) {
          clearActiveEffect();
        }
      }
      if (!el) return;
      const t = el.dataset.agentTarget!;
      const now = Date.now();

      // Attention: modal-open heuristic. The widget can't generally tell a
      // click opened a dialog (e.g. the size guide modal) — a click followed
      // by no navigation is treated as "shopper is now engaging with
      // whatever that click produced" for MODAL_HEURISTIC_MS, UNLESS a
      // DIFFERENT target is interacted with first (cancelled below on every
      // other target's click). Navigation itself already clears all
      // dwellStateRef entries (route-change effect), so no separate
      // "did not navigate" check is needed here.
      dwellStateRef.current.forEach((s, key) => {
        if (key === t) return;
        s.modalUntil = 0;
        // syncAttention's own contract: "must be called after ANY mutation
        // to the fields isTargetActive() reads" — modalUntil is one of
        // them. Without this, a target whose "active" window was open ONLY
        // because of its own modal-heuristic window stays open (in
        // activeSince bookkeeping) until the next periodic dwellTick sync,
        // silently over-counting up to DWELL_TICK_MS of attention past the
        // moment a different target's click actually ended it.
        syncAttention(s, now);
      });
      const attnState = getOrCreateAttentionState(t, el, now);
      attnState.clicks += 1;
      attnState.modalUntil = now + MODAL_HEURISTIC_MS;
      syncAttention(attnState, now);

      const arr = (clickTimestampsRef.current.get(t) ?? []).filter((ts) => now - ts < RAGE_WINDOW_MS);
      arr.push(now);
      if (arr.length >= RAGE_THRESHOLD) {
        emit("rage_click", t, { count: arr.length });
        clickTimestampsRef.current.set(t, []);
      } else {
        clickTimestampsRef.current.set(t, arr);
      }
    };
    document.addEventListener("click", onDocumentClick);

    // Attention: hover (pointerover/pointerout delegation — bubbling events,
    // unlike mouseenter/mouseleave, so a single document-level listener
    // covers every current and future [data-agent-target] element without
    // per-element listener wiring). Touch devices have no hover; taps still
    // count via the click handler above (see meta.touch on the emitted
    // event, computed from matchMedia("(pointer: coarse)") in the dwellTick
    // closure).
    const onPointerOver = (e: PointerEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-agent-target]");
      const target = el?.dataset.agentTarget ?? null;
      if (target === hoveredTargetRef.current) return;
      const now = Date.now();
      if (hoveredTargetRef.current) {
        const prev = dwellStateRef.current.get(hoveredTargetRef.current);
        if (prev?.hovering) {
          prev.hoverMs += now - prev.hoverSince;
          prev.hovering = false;
          syncAttention(prev, now);
        }
      }
      hoveredTargetRef.current = target;
      if (target && el) {
        const s = getOrCreateAttentionState(target, el, now);
        s.hovering = true;
        s.hoverSince = now;
        syncAttention(s, now);
      }
    };
    const onPointerOut = (e: PointerEvent) => {
      const current = hoveredTargetRef.current;
      if (!current) return;
      const related = e.relatedTarget as HTMLElement | null;
      if (related?.closest?.(`[data-agent-target="${escapeAttrValue(current)}"]`)) return;
      const now = Date.now();
      const prev = dwellStateRef.current.get(current);
      if (prev?.hovering) {
        prev.hoverMs += now - prev.hoverSince;
        prev.hovering = false;
        syncAttention(prev, now);
      }
      hoveredTargetRef.current = null;
    };
    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);

    // Attention: focus (focusin/focusout — the bubbling counterparts of
    // focus/blur — delegation, so "the target or a descendant has focus"
    // works for a target that's a container around a real form control).
    const onFocusIn = (e: FocusEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-agent-target]");
      if (!el) return;
      const target = el.dataset.agentTarget!;
      const now = Date.now();
      const s = getOrCreateAttentionState(target, el, now);
      if (!s.focused) {
        s.focused = true;
        s.focusSince = now;
        syncAttention(s, now);
      }
    };
    const onFocusOut = (e: FocusEvent) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-agent-target]");
      if (!el) return;
      const target = el.dataset.agentTarget!;
      const s = dwellStateRef.current.get(target);
      if (!s?.focused) return;
      // A focus move between two descendants of the SAME target (e.g.
      // tabbing within a form group) must not flicker focus off and back on.
      const related = e.relatedTarget as HTMLElement | null;
      if (related && related.closest(`[data-agent-target="${escapeAttrValue(target)}"]`) === el) return;
      const now = Date.now();
      s.focusMs += now - s.focusSince;
      s.focused = false;
      syncAttention(s, now);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    // Scroll depth: 25/50/75/100, once each per page.
    const onScroll = () => {
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - doc.clientHeight;
      const pct = scrollable > 0 ? Math.min(100, Math.round((window.scrollY / scrollable) * 100)) : 100;
      for (const threshold of SCROLL_THRESHOLDS) {
        if (pct >= threshold && !scrollAchievedRef.current.has(threshold)) {
          scrollAchievedRef.current.add(threshold);
          emit("scroll_depth", window.location.pathname, { pct: threshold });
        }
      }
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    // Back/forward navigation.
    const onPopState = () => emit("back_nav", window.location.pathname);
    window.addEventListener("popstate", onPopState);

    // Search: three emission paths, all funneled through the same
    // dedupe/results-watch helpers below (mirrors server/public/agent.js).
    // meta.results: no host wiring required — see readSearchResultsCount
    // above. This demo store never sets the attribute today, so results
    // stays undefined here (agent.js's stores that DO set it get the count
    // synchronously the same way).
    let searchResultsObserver: MutationObserver | null = null;
    let searchResultsTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSearchResultsKey: string | null = null;
    let lastEmittedSearchQueryKey: string | null = null;
    const stopSearchResultsWatch = () => {
      if (searchResultsObserver) {
        searchResultsObserver.disconnect();
        searchResultsObserver = null;
      }
      if (searchResultsTimer) {
        clearTimeout(searchResultsTimer);
        searchResultsTimer = null;
      }
    };
    const emitSearchResultsIfChanged = (target: string | null, q: string, results: number | null) => {
      if (results == null) return;
      const key = `${target ?? ""}|${q}|${results}`;
      if (key === lastSearchResultsKey) return;
      lastSearchResultsKey = key;
      emit("search", target, { q, results });
    };
    // Dedupe for the base `search` emit (no results yet) — separate from
    // lastSearchResultsKey above, which dedupes the results-carrying
    // re-emit.
    const emitSearchQuery = (target: string | null, q: string) => {
      const key = `${target ?? ""}|${q}`;
      if (key === lastEmittedSearchQueryKey) return;
      lastEmittedSearchQueryKey = key;
      emit("search", target, { q });
    };
    const watchSearchResults = (target: string | null, q: string, inputEl: HTMLElement | null) => {
      stopSearchResultsWatch();
      const immediate = readSearchResultsCount(inputEl);
      if (immediate != null) emitSearchResultsIfChanged(target, q, immediate);
      try {
        searchResultsObserver = new MutationObserver(() => {
          const n = readSearchResultsCount(inputEl);
          if (n != null) emitSearchResultsIfChanged(target, q, n);
        });
        searchResultsObserver.observe(document.body, {
          attributes: true,
          attributeFilter: [SEARCH_RESULTS_ATTR],
          subtree: true,
        });
      } catch {
        /* MutationObserver unsupported — best effort only */
      }
      searchResultsTimer = setTimeout(stopSearchResultsWatch, 5000);
    };
    const searchInputDebounceTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
    // Live-filter path (Acme etc.): no Enter/submit at all — the shop
    // filters as the shopper types. Debounced ~700ms after the last
    // keystroke, min 2 chars.
    const onInput = (e: Event) => {
      const el = e.target as HTMLElement;
      if (!isSearchInput(el)) return;
      const pending = searchInputDebounceTimers.get(el);
      if (pending) clearTimeout(pending);
      const timer = setTimeout(() => {
        searchInputDebounceTimers.delete(el);
        const q = el.value.trim().slice(0, 200);
        if (q.length < SEARCH_INPUT_MIN_CHARS) return;
        const target = el.getAttribute("data-agent-target");
        emitSearchQuery(target, q);
        watchSearchResults(target, q, el);
      }, SEARCH_DEBOUNCE_MS);
      searchInputDebounceTimers.set(el, timer);
    };
    document.addEventListener("input", onInput);
    // Explicit-action path: Enter always emits immediately, regardless of
    // length. Cancels any pending debounce timer for the same input.
    const onSearchKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const el = e.target as HTMLElement;
      if (!isSearchInput(el)) return;
      const pending = searchInputDebounceTimers.get(el);
      if (pending) {
        clearTimeout(pending);
        searchInputDebounceTimers.delete(el);
      }
      const q = el.value.trim().slice(0, 200);
      const target = el.getAttribute("data-agent-target");
      emitSearchQuery(target, q);
      watchSearchResults(target, q, el);
    };
    document.addEventListener("keydown", onSearchKeyDown, true);
    // Submit path: <input type="search"> (or any qualifying search input)
    // inside a <form> that's submitted rather than live-filtered.
    const onSearchSubmit = (e: Event) => {
      const form = e.target as HTMLFormElement;
      if (!form?.querySelectorAll) return;
      const inputs = form.querySelectorAll("input");
      for (const el of Array.from(inputs)) {
        if (!isSearchInput(el)) continue;
        const pending = searchInputDebounceTimers.get(el);
        if (pending) {
          clearTimeout(pending);
          searchInputDebounceTimers.delete(el);
        }
        const q = el.value.trim().slice(0, 200);
        const target = el.getAttribute("data-agent-target");
        emitSearchQuery(target, q);
        watchSearchResults(target, q, el);
        break;
      }
    };
    document.addEventListener("submit", onSearchSubmit, true);

    // Cart store subscription -> cart_update on every change.
    const unsubscribeCart = subscribeCart(() => {
      const items = getCartSnapshot();
      emit("cart_update", "cart-add", { total: cartTotal(items), items, promo: getPrimaryPromoMeta() });
    });

    // ---- executor ----------------------------------------------------------

    const ws = new WebSocket(`${WS}?session=${sessionRef.current}`);
    ws.onopen = () => {
      wsOpenRef.current = true;
      setWsConnected(true);
      // `?agent_demo=<name>` (see DEMO.md's shareable link pattern) auto-plays
      // that fixture 2s after the socket opens, once — only when the URL's
      // `agent_session` still matches the session this tab is pinned to
      // (getSessionId() already resolved/stored it before this effect ran).
      // Removed from the URL afterward (agent_session kept) so a reload
      // doesn't replay it.
      const url = new URL(window.location.href);
      const demoName = url.searchParams.get("agent_demo");
      const demoSession = url.searchParams.get("agent_session");
      if (demoName && demoSession && demoSession === sessionRef.current) {
        setTimeout(() => {
          triggerPlay(demoName);
          url.searchParams.delete("agent_demo");
          window.history.replaceState({}, "", url.pathname + url.search + url.hash);
        }, 2000);
      }
    };
    ws.onmessage = (e) => {
      let msg: WireMessage;
      try {
        msg = JSON.parse(e.data);
      } catch {
        // Malformed frame (shouldn't happen from our own server, but this
        // is a public-facing WS endpoint) — drop it rather than letting a
        // JSON.parse throw inside an event handler crash the widget.
        return;
      }
      if (msg.kind === "metrics") {
        setMetrics(msg);
        return;
      }
      if (msg.kind === "demo") {
        if (msg.state === "error") {
          if (demoWatchdogRef.current?.fixture === msg.fixture) clearDemoWatchdog();
          setDemoLine(`Demo error: ${msg.fixture}`);
          setDemoStatus({ fixture: msg.fixture, state: "error", message: msg.error || "playback error" });
          return;
        }
        setDemoLine(
          msg.state === "start" ? `Demo: ${msg.fixture} ▶ ${msg.events ?? "?"} events` : `Demo finished: ${msg.fixture}`
        );
        if (msg.state === "end") {
          if (demoWatchdogRef.current?.fixture === msg.fixture) clearDemoWatchdog();
          setDemoStatus((prev) =>
            prev && prev.fixture === msg.fixture && prev.state !== "error" ? { fixture: msg.fixture, state: "done" } : prev
          );
          setTimeout(() => {
            setDemoStatus((prev) => (prev && prev.fixture === msg.fixture && prev.state === "done" ? null : prev));
          }, 3000);
        }
        return;
      }
      if (msg.kind === "trace") {
        lastTraceAtRef.current = Date.now();
        setThinkingSeconds(null);
        const suppressed = msg.decision !== "noop" && !agentEnabledRef.current;
        const entry: TraceEntry = { ...msg, suppressed };
        latestTraceRef.current = entry;
        setTraces((prev) => [entry, ...prev].slice(0, 200));
        setNoticedWhyOpen(false); // a new decision landed — collapse the old one's expanded hypothesis
        return;
      }
      // {kind:"replay"} isn't part of the fixed contract (see WireMessage) —
      // harmless to ignore; nothing in `msg` past this point matches any of
      // the branches above, and `apply()` below only understands the
      // ACTIONS allow-list, so an unrecognized `msg.action` would already
      // silently no-op there too. Kept as an explicit branch for clarity
      // per the brief ("keep replay harmless").
      if ((msg as { kind?: string }).kind === "replay") return;
      // A delivered (non-noop) action also becomes a permanent tray card —
      // added BEFORE apply() so a "Show me" replay is available even if the
      // live DOM effect itself no-ops (e.g. target not found on this page).
      if (msg.action !== "noop") {
        addSuggestion(msg);
        // Outcome tracking (server/RESEARCH.md "Outcomes" section): register
        // this action's info once, here — the one place guaranteed to run
        // for every non-noop action kind regardless of which live slot (if
        // any) ends up displaying it — so reportOutcomeOnce() calls
        // elsewhere only need an id.
        if (msg.id) {
          pendingActionInfo.current.set(msg.id, {
            action: msg.action,
            target: msg.target,
            ctaKind: msg.action === "card" ? (msg.card?.cta.kind ?? undefined) : undefined,
          });
        }
      }
      applyAction(msg);
    };
    ws.onclose = () => {
      wsOpenRef.current = false;
      setWsConnected(false);
    };
    ws.onerror = () => {
      wsOpenRef.current = false;
      setWsConnected(false);
    };

    // "thinking · Ns" indicator (see thinkingSeconds/lastTraceAtRef above):
    // ticks every second, showing elapsed seconds once it's been >3s since
    // the last trace while the socket is open; hidden otherwise. The trace
    // handler above clears it immediately on the next {kind:"trace"} frame.
    const thinkingInterval = setInterval(() => {
      const idleMs = Date.now() - lastTraceAtRef.current;
      if (wsOpenRef.current && idleMs > 3000) {
        setThinkingSeconds(Math.floor(idleMs / 1000));
      } else {
        setThinkingSeconds(null);
      }
    }, 1000);

    return () => {
      clearInterval(dwellHeartbeat);
      clearInterval(dwellTick);
      clearInterval(thinkingInterval);
      if (rescanTimer) clearTimeout(rescanTimer);
      clearMessageTimer();
      mutationObserver.disconnect();
      dwellObserverRef.current?.disconnect();
      dwellStateRef.current.clear();
      hoveredTargetRef.current = null;
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("popstate", onPopState);
      document.removeEventListener("input", onInput);
      document.removeEventListener("keydown", onSearchKeyDown, true);
      document.removeEventListener("submit", onSearchSubmit, true);
      stopSearchResultsWatch();
      unsubscribeCart();
      ws.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- route changes: fresh page_view/targets scan, reset per-page state ---
  //
  // B1 (page-boundary defect class): this effect is the ONLY place page_view
  // is emitted for a route change, and it now does so UNCONDITIONALLY — key
  // = pathname + targets, not just targets.join("|") as rescan() alone used
  // to gate it on. Every product page shares the identical target-id set
  // (ProductClient.tsx), so a product->product navigation never changed
  // `targets.join("|")` at all — the old rescan()-only path silently
  // dropped the page_view entirely, so the server (state.js's
  // lastPageView-scoped dwell math, index.js's lastDwellBuckets reset) never
  // saw the page boundary and per-target dwell/buckets leaked across the
  // navigation (the observed saree false-positive). This effect fires once
  // on initial mount too (same as the `[]` effect above, same render commit,
  // sessionRef already set by then) — so it's also this component's ONE
  // source of the very first page_view, replacing the old mount-effect emit.
  //
  // rescan() itself (still called by the MutationObserver in the mount
  // effect, for same-page DOM changes like a modal opening new targets)
  // keeps its OLD conditional behavior — emit only if the target SET
  // changed — since a same-page DOM mutation is not a page boundary; only
  // an actual route change always warrants a fresh page_view.
  useEffect(() => {
    if (!sessionRef.current) return; // first render before mount effect ran
    const targets = currentTargets();
    lastTargetsKeyRef.current = targets.join("|");
    capturePageLabel(window.location.pathname);
    emit("page_view", window.location.pathname, { targets });
    setupDwellObserver();
    pageStartRef.current = Date.now(); // B2: reset page dwell clock on every route change
    scrollAchievedRef.current = new Set();
    // Full clear (not just marking invisible, which setupDwellObserver
    // inside rescan() already does) — a route change is a hard per-page
    // boundary, so a stale per-target entry from the previous page (same
    // target name reused on the new page, or one that simply no longer
    // exists) must not carry forward any accumulated cumMs/lastBucket.
    dwellStateRef.current.clear();
    hoveredTargetRef.current = null; // the hovered element (if any) belongs to the page just left
    // Same per-page boundary for rage-click burst history: the 1.5s window
    // self-expires these in practice, but clearing explicitly here removes
    // any doubt for a target name reused across pages.
    clickTimestampsRef.current.clear();
    // Fixed-short-effect-lifetime defect class: an effect (highlight/
    // spotlight/message) belongs to the page that earned it and must not
    // visually persist onto a page whose shopper never triggered it — this
    // is the third of the three end-conditions (duration, interaction,
    // navigation — never earlier) alongside onDocumentClick's grace-period
    // dismiss above.
    // "navigated" — pathname changed while still showing and untouched
    // (server/RESEARCH.md "Outcomes" section). A no-op report for whichever
    // of these wasn't actually showing (reportOutcomeOnce needs an id).
    clearActiveEffect("navigated");
    clearMessageBubble("navigated");
    // Card navigation-persistence (product rule 2026-09-11): unlike the
    // message bubble above, a card survives navigation when its CTA still
    // makes sense elsewhere — apply_code/add_to_cart/open_product/search/none
    // survive any navigation (re-anchored to the target on the new page, or
    // shown as a banner if the target isn't there — see the cardPos effect
    // above, which re-runs because cardState is unchanged in that case, and
    // positionCardNow is also called directly below). pick_size only makes
    // sense on the exact product page it was issued on (a size CTA for one
    // jacket means nothing on another product's page), so it's cleared on
    // any other navigation via dismissCard("navigated") — same page-boundary
    // outcome rule as the message bubble above — a card belongs to the page
    // that earned it unless its CTA still makes sense elsewhere.
    {
      const cs = cardStateRef.current;
      const kind = cs?.data.card?.cta.kind;
      if (cs && kind === "pick_size" && cs.issuedPathname !== pathname) {
        dismissCard("navigated");
      } else if (cs) {
        // Re-anchor (rather than waiting for the interval poll) so a
        // surviving card doesn't sit at its old, now-stale position for up
        // to 250ms after the new page's content has already painted.
        // Deferred one rAF (SPA-navigation-layout-race defect class): this
        // effect runs right after React commits the new route's tree, but
        // the new page's layout may not have settled/painted yet — a
        // synchronous positionCardNow() here could measure the target's
        // pre-layout rect. No outcome is reported — the card is still
        // live, not resolved.
        requestAnimationFrame(() => positionCardNow());
      }
    }
    if (pathname === "/cart") {
      const items = getCartSnapshot();
      emit("cart_view", "cart-items", { total: cartTotal(items), items, promo: getPrimaryPromoMeta() });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // ---- outcome tracking: tab hides / unload while still untouched ---------
  // "ignored" (server/RESEARCH.md "Outcomes" section): whichever of
  // card/message/highlight-spotlight is still showing when the tab goes
  // away, never having been dismissed/CTA'd/turned-off/navigated away from.
  // Re-registered on every cardState/message change so the closures below
  // always see the CURRENT one (activeEffectRef is a ref, always current
  // regardless); reportOutcomeOnce is idempotent so re-registering never
  // double-reports. keepalive fetch (emitOutcome, used by
  // reportOutcomeOnce -> emitOutcome) is the same "or fetch keepalive:true"
  // path the brief allows in place of navigator.sendBeacon.
  useEffect(() => {
    const reportIfStillShowing = () => {
      if (cardState) reportOutcomeOnce(cardState.data.id, "ignored", cardState.shownAt);
      if (message) reportOutcomeOnce(message.id, "ignored", message.shownAt);
      const active = activeEffectRef.current;
      if (active) reportOutcomeOnce(active.actionId, "ignored", active.startedAt);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") reportIfStillShowing();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", reportIfStillShowing);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", reportIfStillShowing);
    };
  }, [cardState, message]);

  // ---- user controls ---------------------------------------------------------

  const toggleAgent = () => {
    setAgentEnabled((v) => {
      const next = !v;
      storage.set("agent_enabled", next ? "1" : "0");
      return next;
    });
  };

  // "Turn off" link in the message bubble — the same disable path as the
  // on/off pill (persists the same way), plus it also removes the current
  // bubble and any active highlight so the shopper sees the effect land
  // immediately, not just the pill flipping to "off".
  const disableAgent = () => {
    setAgentEnabled(false);
    agentEnabledRef.current = false;
    storage.set("agent_enabled", "0");
    // "Turn off" clicked from card or bubble — report "turn_off" for
    // whichever of card/message/highlight-spotlight is still showing (a
    // category fix, not just the one that owns the button clicked: all
    // three end together here, so all three should report the same cause).
    clearMessageBubble("turn_off");
    clearActiveEffect("turn_off");
    dismissCard("turn_off");
  };

  // Chip's "×" — dismiss the active highlight/spotlight early without
  // touching the on/off state (mirrors clicking anywhere on the page, which
  // already clears the effect via onDocumentClick).
  const dismissHighlight = () => clearActiveEffect("dismiss");

  const togglePanel = () => {
    setPanelOpen((v) => {
      const next = !v;
      storage.set("agent_panel_open", next ? "1" : "0");
      return next;
    });
  };

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ---- assistant panel (launcher + tray) controls ---------------------------

  function addSuggestion(a: AgentAction) {
    const t = latestTraceRef.current;
    const isCard = a.action === "card" && a.card;
    const text = a.action === "message" && a.message ? a.message : suggestionSentence(a);
    const s: Suggestion = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      action: a.action as Exclude<ActionKind, "noop">,
      target: a.target,
      text,
      hypothesis: t?.hypothesis ?? null,
      confidence: t ? t.confidence : null,
      why: t?.why ?? null,
      ...(isCard ? { cardTitle: a.card!.title, cta: a.card!.cta } : {}),
      ...(a.id ? { actionId: a.id } : {}),
    };
    setSuggestions((prev) => {
      const next = [s, ...prev].slice(0, MAX_SUGGESTIONS);
      saveSuggestions(next);
      return next;
    });
    setUnseenCount((n) => (assistantOpenRef.current ? n : n + 1));
  }

  // "Show me" — re-applies the effect for an OLD suggestion: scroll target
  // into view + a short 5s pulse. Independent of the live activeEffectRef/
  // highlight-chip machinery (that belongs to the CURRENT decision, not a
  // historical one being re-shown), so this never interferes with — or gets
  // clobbered by — a fresh action arriving from the server mid-replay.
  // Outcome (server/RESEARCH.md "Outcomes" section): counts as "cta" — the
  // shopper engaged with an old suggestion again — same bucket as the live
  // card's own CTA button, only if no outcome was reported yet for that id
  // (reportOutcomeOnce is idempotent).
  function showSuggestion(s: Suggestion) {
    reportOutcomeOnce(s.actionId, "cta", s.ts);
    const el = targetEl(s.target);
    if (!el) return;
    el.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
    el.classList.add("agent-pulse");
    setTimeout(() => el.classList.remove("agent-pulse"), SHOW_ME_PULSE_MS);
  }

  // Tray/badge-desync defect class: dismissSuggestion/clearAllSuggestions
  // used to mutate the suggestions list without ever recomputing
  // unseenCount, so the launcher badge kept showing a stale count over an
  // empty (or partially-emptied) tray. Both now recompute from the actual
  // post-mutation list via countUnseen (same function the mount effect
  // uses), instead of leaving the last-set number untouched.
  function dismissSuggestion(s: Suggestion) {
    reportOutcomeOnce(s.actionId, "dismiss", s.ts);
    setSuggestions((prev) => {
      const next = prev.filter((x) => x.id !== s.id);
      saveSuggestions(next);
      setUnseenCount(countUnseen(next, loadSeenAt()));
      return next;
    });
    setExpandedSuggestionWhy((prev) => {
      if (!prev.has(s.id)) return prev;
      const next = new Set(prev);
      next.delete(s.id);
      return next;
    });
  }

  function clearAllSuggestions() {
    for (const s of suggestions) reportOutcomeOnce(s.actionId, "dismiss", s.ts);
    setSuggestions([]);
    saveSuggestions([]);
    setUnseenCount(0);
    setExpandedSuggestionWhy(new Set());
  }

  function toggleSuggestionWhy(id: string) {
    setExpandedSuggestionWhy((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    assistantOpenRef.current = assistantOpen;
  }, [assistantOpen]);

  // ---- dev-only manual action injector --------------------------------------
  // window.__agentInject(action) feeds a fake AgentAction through the exact
  // same path a real WS-delivered action takes (tray + executor), so a
  // browser worker (or anyone at the console) can test every action —
  // including "card" and its CTAs — without waiting on the decider. Gated
  // behind NEXT_PUBLIC_AGENT_DEBUG=1 or the tester-tools probe
  // (debugAvailable, see the two probe effects above) so it never ships
  // live/production-visible.
  useEffect(() => {
    const enabled = process.env.NEXT_PUBLIC_AGENT_DEBUG === "1" || debugAvailable;
    if (!enabled || typeof window === "undefined") return;
    const w = window as unknown as { __agentInject?: (action: AgentAction) => void };
    w.__agentInject = (action: AgentAction) => {
      if (!action || action.kind !== "action") return;
      if (action.action !== "noop") addSuggestion(action);
      applyAction(action);
    };
    return () => {
      delete w.__agentInject;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugAvailable]);

  function openAssistant() {
    setAssistantOpen(true);
    setUnseenCount(0);
    saveSeenAt(Date.now());
  }
  function closeAssistant() {
    setAssistantOpen(false);
    launcherBtnRef.current?.focus();
  }
  function toggleAssistant() {
    if (assistantOpen) closeAssistant();
    else openAssistant();
  }

  // Escape closes the panel and returns focus to the launcher, while open.
  useEffect(() => {
    if (!assistantOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAssistant();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantOpen]);

  // Escape-only-closes-the-panel defect class: Escape used to be wired up
  // ONLY while the assist panel was open — a live card or message bubble
  // had no keyboard dismissal at all. Mount-once (reads refs, not state, so
  // it never needs re-binding), and defers to the panel's own
  // Escape-closes-it effect above while the panel is open.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || assistantOpenRef.current) return;
      if (cardStateRef.current) {
        dismissCard("dismiss");
      } else if (messageRef.current) {
        clearMessageBubble("dismiss");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live "Ns ago" timestamps in the tray: retick once a second only while
  // the panel is actually open (no point paying the interval otherwise).
  useEffect(() => {
    if (!assistantOpen) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [assistantOpen]);

  /** Tester tools — "Decide now": POST /session/<id>/decide (200
   * {action, trace, ms} | 409 in-flight/cached-mode | 404 not debug). Shown
   * only when debugAvailable. */
  function decideNow() {
    if (decideBusy) return;
    setDecideBusy(true);
    setDecideStatus(null);
    fetch(`${HTTP}/session/${encodeURIComponent(sessionRef.current)}/decide`, { method: "POST" })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}) as Record<string, unknown>);
        if (res.ok) {
          const action = body.action as AgentAction | undefined;
          const ms = typeof body.ms === "number" ? (body.ms / 1000).toFixed(1) : "?";
          const decided = action ? (action.action === "noop" ? "noop" : [action.action, action.target].filter(Boolean).join(" ")) : "?";
          setDecideStatus(`decided: ${decided}, ${ms}s`);
        } else {
          setDecideStatus((body as { error?: string }).error || `HTTP ${res.status}`);
        }
      })
      .catch(() => setDecideStatus("network error"))
      .finally(() => setDecideBusy(false));
  }

  /** Tester tools — "Reset session": DELETE /session/<id>, then reload the
   * page so every piece of client state (traces, tray, message, session
   * pinning) starts fresh against the server's now-empty session record. */
  function resetSession() {
    if (resetBusy) return;
    setResetBusy(true);
    fetch(`${HTTP}/session/${encodeURIComponent(sessionRef.current)}`, { method: "DELETE" })
      .then(() => window.location.reload())
      .catch(() => setResetBusy(false));
  }

  // ---- ui --------------------------------------------------------------------

  const rows = buildRows(traces);
  const hasMetrics = metrics !== null;
  // Exit-fade defect class: render the exiting card/message for
  // CARD_EXIT_MS after the real state goes null, purely so the fade-out
  // plays instead of an instant unmount. `key` on the outer element is the
  // card's shownAt — a genuinely NEW card always gets a fresh key, forcing
  // React to remount the node (see the entry-animation-restart defect
  // class: reusing the same node meant the CSS entry animation only ever
  // played once per session).
  const displayCard = cardState ?? exitingCard;
  const displayMessage = message ?? exitingMessage;

  return (
    <>
      {displayCard ? (
        // Anchored next to its target, or a top banner if the target isn't
        // on this page / the viewport is narrow — see cardPos/positionCardNow
        // above. A card replaces any visible bubble (see applyAction's
        // "card" case) and, like the bubble, has NO auto-expiry: only ×, the
        // CTA, or a navigation it doesn't survive (pathname effect above)
        // ends it.
        <div
          key={displayCard.shownAt}
          ref={cardElRef}
          className={
            "agent-page-card " +
            (cardPos?.mode === "anchored" ? `mode-anchored caret-${cardPos.caret}` : "mode-banner") +
            (cardState ? "" : " is-exiting") +
            (cardState && cardOccluded ? " is-target-occluded" : "") +
            (cardState && typingSuppressed ? " is-typing-suppressed" : "")
          }
          style={
            cardPos?.mode === "anchored"
              ? ({ top: cardPos.top, left: cardPos.left, "--caret-left": `${cardPos.caretLeft}px` } as CSSProperties)
              : undefined
          }
          data-agent-ui
          data-agent-card-placement={cardPos?.mode === "anchored" ? cardPos.placement : undefined}
          role="status"
          aria-live="polite"
        >
          <div className="agent-page-card-head">
            <strong>{displayCard.data.card?.title}</strong>
            <button onClick={() => dismissCard()} aria-label="Dismiss">
              ×
            </button>
          </div>
          <p className="agent-page-card-body">{displayCard.data.card?.body}</p>
          {displayCard.data.card && displayCard.data.card.cta.kind !== "none" && (
            displayCard.data.card.cta.kind === "pick_size" &&
            pickSizeCurrentlySelected(displayCard.data.card.cta.value) ? (
              <button className="agent-page-card-cta" disabled>
                {`Size ${displayCard.data.card.cta.value} selected ✓`}
              </button>
            ) : (
              <button className="agent-page-card-cta" onClick={handleCardCtaClick} disabled={displayCard.feedback != null}>
                {displayCard.feedback ?? displayCard.data.card.cta.label}
              </button>
            )
          )}
          <div className="agent-message-footer">
            <button className="agent-why-toggle" onClick={() => setCardWhyOpen((v) => !v)} aria-expanded={cardWhyOpen}>
              Why?
            </button>
            <button className="agent-turnoff" onClick={disableAgent}>
              Turn off
            </button>
          </div>
          {cardWhyOpen && traceWhyText(traces[0]) && <div className="agent-why-line">{traceWhyText(traces[0])}</div>}
        </div>
      ) : (
        displayMessage && (
          <div
            key={displayMessage.shownAt}
            className={
              "agent-message" +
              (message ? "" : " is-exiting") +
              (message && typingSuppressed ? " is-typing-suppressed" : "")
            }
            data-agent-ui
            role="status"
            aria-live="polite"
          >
            <div className="agent-message-row">
              <span>{displayMessage.text}</span>
              <button
                onClick={() => clearMessageBubble()}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
            <div className="agent-message-footer">
              <button
                className="agent-why-toggle"
                onClick={() => setBubbleWhyOpen((v) => !v)}
                aria-expanded={bubbleWhyOpen}
              >
                Why?
              </button>
              <button className="agent-turnoff" onClick={disableAgent}>
                Turn off
              </button>
            </div>
            {bubbleWhyOpen && traceWhyText(traces[0]) && (
              <div className="agent-why-line">{traceWhyText(traces[0])}</div>
            )}
          </div>
        )
      )}

      <button
        ref={launcherBtnRef}
        className="agent-launcher"
        data-agent-ui
        onClick={toggleAssistant}
        aria-label={assistantOpen ? "Close store assistant" : "Open store assistant"}
        aria-expanded={assistantOpen}
        aria-haspopup="dialog"
      >
        <span aria-hidden="true">💬</span>
        {unseenCount > 0 && (
          <span className="agent-launcher-badge" aria-label={`${unseenCount} new suggestion${unseenCount === 1 ? "" : "s"}`}>
            {unseenCount > 9 ? "9+" : unseenCount}
          </span>
        )}
      </button>

      {assistantOpen && (
        <div
          ref={assistantPanelRef}
          className="agent-assist"
          data-agent-ui
          role="dialog"
          aria-label="Store assistant"
        >
          <div className="agent-assist-head">
            <span className="agent-assist-title">Store assistant</span>
            <span className="agent-assist-status">
              {!wsConnected
                ? "offline"
                : !agentEnabled
                ? "paused"
                : thinkingSeconds !== null
                ? `thinking · ${thinkingSeconds}s`
                : "watching"}
            </span>
            <button className="agent-assist-close" onClick={closeAssistant} aria-label="Close store assistant">
              ×
            </button>
          </div>

          <div className="agent-assist-body">
            <section className="agent-assist-section">
              <h3 className="agent-assist-heading">Suggestions</h3>
              <div className="agent-assist-tray" aria-live="polite">
                {suggestions.length === 0 && (
                  <p className="agent-assist-empty">Nothing yet — I&apos;ll drop suggestions here as I notice things.</p>
                )}
                {suggestions.map((s) => (
                  // s.resolved (tray/badge-desync fix): this suggestion's
                  // live slot (card/message/highlight) has already ended
                  // (×'d, CTA'd, turned off, or navigated away from) — its
                  // Show me/CTA controls are now inert (nothing live left to
                  // re-show or act on again) instead of silently no-op'ing.
                  <div key={s.id} className={"agent-card" + (s.resolved ? " is-resolved" : "")}>
                    {s.cardTitle && <div className="agent-card-title">{s.cardTitle}</div>}
                    <div className="agent-card-text">{s.text}</div>
                    <div className="agent-card-time">
                      {timeAgo(s.ts, Date.now())}
                      {s.resolved && <span className="agent-card-resolved"> · {s.resolved === "cta" ? "done" : "dismissed"}</span>}
                    </div>
                    <div className="agent-card-actions">
                      {!s.resolved && s.cta && s.cta.kind !== "none" && (
                        <button
                          onClick={() => handleTraySuggestionCta(s)}
                          disabled={suggestionCtaFeedback[s.id] != null}
                        >
                          {suggestionCtaFeedback[s.id] ?? s.cta.label}
                        </button>
                      )}
                      {!s.resolved && <button onClick={() => showSuggestion(s)}>Show me</button>}
                      <button
                        className="agent-why-toggle"
                        onClick={() => toggleSuggestionWhy(s.id)}
                        aria-expanded={expandedSuggestionWhy.has(s.id)}
                      >
                        Why?
                      </button>
                      <button onClick={() => dismissSuggestion(s)} aria-label="Dismiss suggestion">
                        Dismiss
                      </button>
                    </div>
                    {expandedSuggestionWhy.has(s.id) && (
                      <div className="agent-why-line">
                        {s.hypothesis || s.why || "No reasoning recorded."}
                        {s.confidence != null && ` · ${Math.round(s.confidence * 100)}% sure`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <section className="agent-assist-section">
              <h3 className="agent-assist-heading">What I noticed</h3>
              {traces[0] ? (
                <div className="agent-assist-noticed">
                  {(() => {
                    const lines = buildNoticedLines(traces[0].signals ?? []);
                    return lines.length ? (
                      <ul className="agent-noticed-signals">
                        {lines.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="agent-noticed-signals-empty">(no signals)</p>
                    );
                  })()}
                  <p className="agent-noticed-decision">{noticedPrimaryText(traces[0])}</p>
                  {traces[0].hypothesis && (
                    <>
                      <button
                        type="button"
                        className="agent-why-toggle agent-noticed-why-toggle"
                        onClick={() => setNoticedWhyOpen((v) => !v)}
                        aria-expanded={noticedWhyOpen}
                      >
                        {noticedWhyOpen ? "Hide why" : "Why?"}
                      </button>
                      {noticedWhyOpen && (
                        <p className="agent-noticed-hypothesis">{traces[0].hypothesis}</p>
                      )}
                    </>
                  )}
                </div>
              ) : (
                <p className="agent-assist-empty">Watching. Nothing decided yet.</p>
              )}
            </section>

            <section className="agent-assist-section">
              <h3 className="agent-assist-heading">Controls</h3>
              <div className="agent-assist-controls">
                <button
                  className="agent-toggle"
                  onClick={toggleAgent}
                  aria-pressed={agentEnabled}
                  title="When off, the assistant keeps watching but won't act on the page"
                >
                  Agent {agentEnabled ? "on" : "off"}
                </button>
                <button onClick={clearAllSuggestions} disabled={suggestions.length === 0}>
                  Clear suggestions
                </button>
              </div>
            </section>

            {debugAvailable && (
              <section className="agent-assist-section agent-assist-tester">
                <h3 className="agent-assist-heading">Tester tools</h3>
                {demoFixtures.length > 0 && (
                  <div className="agent-demo">
                    <div className="agent-demo-label">Demo</div>
                    <div className="agent-demo-buttons">
                      {demoFixtures.map((fx) => {
                        const status = demoStatus?.fixture === fx.name ? demoStatus : null;
                        return (
                          <button
                            key={fx.name}
                            className="agent-demo-btn"
                            title={fx.description}
                            disabled={status?.state === "playing"}
                            onClick={() => handleDemoClick(fx)}
                          >
                            {fx.name}
                            {status?.state === "playing" && " …"}
                            {status?.state === "done" && " ✓"}
                          </button>
                        );
                      })}
                    </div>
                    {demoStatus?.state === "error" && demoStatus.message && (
                      <div className="agent-demo-error">{demoStatus.message}</div>
                    )}
                    {demoLine && <div className="agent-demo-status">{demoLine}</div>}
                  </div>
                )}
                <div className="agent-tester-row">
                  <button onClick={decideNow} disabled={decideBusy}>
                    {decideBusy ? "Deciding…" : "Decide now"}
                  </button>
                  {decideStatus && <span className="agent-tester-result">{decideStatus}</span>}
                </div>
                <div className="agent-tester-row">
                  <button onClick={resetSession} disabled={resetBusy}>
                    {resetBusy ? "Resetting…" : "Reset session"}
                  </button>
                </div>
                <div className="agent-tester-row">
                  <a href={`/sessions/${encodeURIComponent(sessionRef.current)}`} target="_blank" rel="noopener noreferrer">
                    Open research page
                  </a>
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      {activeHighlight && (
        <div className="agent-highlight-chip" data-agent-ui role="status" aria-live="polite">
          <div className="agent-highlight-chip-row">
            <button
              className="agent-why-toggle"
              onClick={() => setHighlightWhyOpen((v) => !v)}
              aria-expanded={highlightWhyOpen}
            >
              Why?
            </button>
            <button className="agent-highlight-dismiss" onClick={dismissHighlight} aria-label="Dismiss highlight">
              ×
            </button>
          </div>
          {highlightWhyOpen && traceWhyText(traces[0]) && (
            <div className="agent-why-line">{traceWhyText(traces[0])}</div>
          )}
        </div>
      )}

      {panelOpen ? (
        <aside className="agent-trace" data-agent-ui>
          <button className="agent-trace-tab agent-trace-tab-close" onClick={togglePanel} aria-label="Hide trace panel">
            ›
          </button>
          <div className="agent-trace-head">
            <span>Agent trace</span>
            <span className="agent-trace-session">{sessionRef.current}</span>
          </div>

          {hasMetrics && (
            <div className="agent-metrics">
              {metrics!.llmCalls ?? 0} calls · {metrics!.cacheHits ?? 0} cache hits · {metrics!.gated ?? 0} gated ·{" "}
              {metrics!.quietTicks ?? 0} quiet
            </div>
          )}

          <p className="agent-rules">
            One nudge per 30s. Never twice on the same element. Silence is a decision.
          </p>

          {thinkingSeconds !== null && (
            <div className="agent-thinking" data-agent-ui>
              thinking · {thinkingSeconds}s
            </div>
          )}

          {rows.length === 0 && <p className="agent-trace-empty">Watching. Nothing decided yet.</p>}

          {rows.map((row) => {
            if (row.kind === "single") {
              const t = row.trace;
              return (
                <div
                  key={row.key}
                  className={`agent-trace-item ${t.decision === "noop" ? "is-noop" : "is-act"} ${t.suppressed ? "is-suppressed" : ""}`}
                >
                  <div className="agent-trace-decision">
                    <span>{t.decision === "noop" ? "stayed quiet" : t.decision}</span>
                    <span>{t.suppressed ? "suppressed by shopper" : `${Math.round(t.confidence * 100)}%`}</span>
                  </div>
                  <div className="agent-trace-signals">
                    {t.signals?.length ? t.signals.join(" · ") : "(no signals)"}
                  </div>
                  <div className="agent-trace-why"><em>{t.hypothesis}</em> {t.why}</div>
                </div>
              );
            }
            const expanded = expandedGroups.has(row.key);
            const latest = row.traces[0];
            return (
              <div key={row.key} className="agent-trace-item is-noop is-group">
                <button className="agent-trace-group-toggle" onClick={() => toggleGroup(row.key)}>
                  <div className="agent-trace-decision">
                    <span>stayed quiet ×{row.traces.length}</span>
                    <span>{expanded ? "▾" : "▸"}</span>
                  </div>
                  <div className="agent-trace-why">{latest.why}</div>
                </button>
                {expanded && (
                  <div className="agent-trace-group-items">
                    {row.traces.map((t, idx) => (
                      <div key={`${row.key}-${idx}`} className="agent-trace-item is-noop">
                        <div className="agent-trace-signals">
                          {t.signals?.length ? t.signals.join(" · ") : "(no signals)"}
                        </div>
                        <div className="agent-trace-why"><em>{t.hypothesis}</em> {t.why}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </aside>
      ) : (
        <button className="agent-trace-tab agent-trace-tab-open" onClick={togglePanel} aria-label="Show trace panel">
          Trace
        </button>
      )}
    </>
  );
}
