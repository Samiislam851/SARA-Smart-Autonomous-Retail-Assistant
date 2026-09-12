"use client";

/**
 * ⚠️ UNCOMMITTED PROTOTYPE — REHEARSAL ONLY, NEVER COMMITTED.
 * Intentionally crosses BUILD-DECISIONS.md §0 for a local real-time demo
 * only. See `src/lib/agent-mock/bus.ts`. Do not edit BUILD-DECISIONS.md.
 *
 * Mounted only on `/p/[slug]` (see `src/app/p/[slug]/page.tsx`). This is the
 * SECOND agent-mock listener, for the "variant churn" (size/colour
 * indecision) signal — it sits alongside the cart page's
 * `AgentMockListener` (glow) and opens its own `EventSource` to the SAME
 * `/api/agent-mock/stream`, which is scoped server-side to the signed-in
 * session user. The two listeners don't conflict because each has its OWN
 * fixed allow-list: this one only ever acts on `chat` / `badge` / `reveal` /
 * `clear`, never `glow` — a `glow` command (meant for the cart page) is
 * simply not a recognized action here and is dropped, exactly as a
 * `chat`/`badge`/`reveal` command is dropped by the cart's listener. Same
 * "fixed allow-list only, never arbitrary DOM instructions" trust boundary
 * as the original mock.
 *
 * Attention design (see task spec): the badge is the PRIMARY, in-gaze
 * mechanism — a small pill attached directly to the size row. The chat
 * bubble carries the reasoning/offer, not the attention. `reveal` opens and
 * briefly rings the shipping/returns accordion (fit branch only), reusing
 * `.agent-spotlight` from `src/styles/agent.css` — no new highlight CSS.
 *
 * THIRD and FOURTH signals share this same listener rather than needing
 * their own: `shipping_info_hunt` is just another `chat` (+ `reveal` on the
 * same shipping/returns accordion the fit branch already targets) with no
 * new allow-listed action required. `rage_click` is `chat` only, and — on
 * top of the admin-triggered path every mock here has — this listener also
 * runs a genuine local detector (see the second `useEffect` below): 3+
 * `pointerdown`s within 800ms inside a 30px radius on the same element
 * fire the identical chat with no server round trip at all, which is what
 * makes it a reliable "insurance beat". The local detector explicitly
 * skips interactive elements, anything under `[data-agent-repeatable]`
 * (legitimate rapid-click controls — cart quantity, gallery thumbnails),
 * and the agent widget's own DOM (`[data-agent-mock-widget]`) so it can't
 * fire on itself.
 */
import { useEffect, useRef, useState } from "react";
import {
  RAGE_CLICK_CHAT_TEXT,
  RAGE_CLICK_COOLDOWN_MS,
  RAGE_CLICK_MIN_EVENTS,
  RAGE_CLICK_RADIUS_PX,
  RAGE_CLICK_WINDOW_MS,
  withinRadius,
  type PointRecord,
} from "@/lib/agent-mock/rage-click";

const ALLOWED_ACTIONS = ["chat", "badge", "reveal", "clear"] as const;
type AllowedAction = (typeof ALLOWED_ACTIONS)[number];

interface AgentMockCommand {
  action: AllowedAction;
  target?: string;
  text?: string;
  chips?: string[];
  ttlMs?: number;
}

const DEFAULT_REVEAL_TTL_MS = 4_000;
const SPOTLIGHT_CLASS = "agent-spotlight";
const BADGE_CLASS =
  "agent-mock-badge pointer-events-none absolute -top-3 right-0 z-10 inline-flex max-w-[12rem] items-center rounded-full bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white shadow-md";
const BADGE_HOST_PREV_POSITION_ATTR = "agentMockPrevPosition";

function isAgentMockCommand(value: unknown): value is AgentMockCommand {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;

  if (
    typeof record.action !== "string" ||
    !(ALLOWED_ACTIONS as readonly string[]).includes(record.action)
  ) {
    return false;
  }
  if (record.target !== undefined && typeof record.target !== "string") return false;
  if (record.text !== undefined && typeof record.text !== "string") return false;
  if (record.ttlMs !== undefined && typeof record.ttlMs !== "number") return false;
  if (
    record.chips !== undefined &&
    (!Array.isArray(record.chips) || !record.chips.every((chip) => typeof chip === "string"))
  ) {
    return false;
  }
  return true;
}

interface ChatState {
  text: string;
  chips: string[];
}

export function PdpAgentMockListener() {
  const [chat, setChat] = useState<ChatState | null>(null);
  const [visible, setVisible] = useState(false);

  const badgeHostRef = useRef<HTMLElement | null>(null);
  const badgeElRef = useRef<HTMLSpanElement | null>(null);
  const revealElRef = useRef<HTMLElement | null>(null);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Chat bubble entrance: a plain CSS transition (not a keyframe), so
  // `motion-reduce:transition-none` below is enough to make it an instant
  // appearance under `prefers-reduced-motion` — no new keyframes needed.
  useEffect(() => {
    if (!chat) {
      setVisible(false);
      return;
    }
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, [chat]);

  useEffect(() => {
    function clearBadge() {
      badgeElRef.current?.remove();
      badgeElRef.current = null;
      const host = badgeHostRef.current;
      if (host) {
        const previous = host.dataset[BADGE_HOST_PREV_POSITION_ATTR] ?? "";
        host.style.position = previous;
        delete host.dataset[BADGE_HOST_PREV_POSITION_ATTR];
        badgeHostRef.current = null;
      }
    }

    function clearReveal() {
      if (revealTimerRef.current) {
        clearTimeout(revealTimerRef.current);
        revealTimerRef.current = null;
      }
      revealElRef.current?.classList.remove(SPOTLIGHT_CLASS);
      revealElRef.current = null;
    }

    function applyBadge(target: string, text: string) {
      clearBadge();
      // The target might not exist (e.g. a product with no size variants
      // has no size selector) — that's expected, just do nothing.
      const host = document.querySelector(target);
      if (!(host instanceof HTMLElement)) return;

      if (window.getComputedStyle(host).position === "static") {
        host.dataset[BADGE_HOST_PREV_POSITION_ATTR] = host.style.position;
        host.style.position = "relative";
      }

      const pill = document.createElement("span");
      pill.className = BADGE_CLASS;
      pill.textContent = text;
      host.appendChild(pill);

      badgeHostRef.current = host;
      badgeElRef.current = pill;
    }

    function applyReveal(target: string, ttlMs: number) {
      clearReveal();
      const anchor = document.querySelector(target);
      if (!(anchor instanceof HTMLElement)) return;

      const details = anchor.closest("details");
      if (details) details.open = true;
      const spotlightHost = details ?? anchor;

      spotlightHost.classList.add(SPOTLIGHT_CLASS);
      revealElRef.current = spotlightHost;
      revealTimerRef.current = setTimeout(() => {
        spotlightHost.classList.remove(SPOTLIGHT_CLASS);
        revealTimerRef.current = null;
      }, ttlMs);
    }

    function applyCommand(command: AgentMockCommand) {
      switch (command.action) {
        case "chat":
          if (!command.text) return;
          setChat({ text: command.text, chips: command.chips ?? [] });
          return;
        case "badge":
          if (!command.target || !command.text) return;
          applyBadge(command.target, command.text);
          return;
        case "reveal":
          if (!command.target) return;
          applyReveal(command.target, command.ttlMs ?? DEFAULT_REVEAL_TTL_MS);
          return;
        case "clear":
          // A full reset of THIS listener's own effects, regardless of
          // whatever (if anything) `target` names — the cart's "clear"
          // (for the checkout glow) is a separate listener's concern.
          setChat(null);
          clearBadge();
          clearReveal();
      }
    }

    // `EventSource` isn't implemented in the jsdom test environment (or any
    // non-browser environment) — no-op rather than throw there.
    if (typeof EventSource === "undefined") return;

    const source = new EventSource("/api/agent-mock/stream");

    function handleAgentCommand(event: MessageEvent<string>) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return; // malformed payload, ignore
      }
      if (isAgentMockCommand(parsed)) {
        applyCommand(parsed);
      }
      // anything else (unknown action, wrong shape — e.g. a "glow" meant
      // for the cart page) is silently dropped — fixed allow-list only.
    }

    source.addEventListener("agent-command", handleAgentCommand);

    return () => {
      source.removeEventListener("agent-command", handleAgentCommand);
      source.close();
      clearBadge();
      clearReveal();
    };
  }, []);

  // SECONDARY path: a genuine local rage-click detector, additive to (and
  // independent of) the admin-triggered SSE path above. If this effect
  // never ran at all, the admin "Rage click" button would still work
  // exactly as before — that trigger is built and verified first, and nothing
  // here is allowed to interfere with it (it only ever calls `setChat`,
  // the same state setter the SSE handler above already owns).
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Per-element sliding window of recent pointerdown points, and a
    // per-element-shape cooldown so one 3+ burst doesn't refire on every
    // subsequent click within the same 60s. Both live only for this
    // effect's lifetime — nothing here needs to survive a remount.
    const recentClicksByElement = new WeakMap<Element, PointRecord[]>();
    const cooldownByKey = new Map<string, number>();

    // Elements where rapid repeated clicking is the shopper doing exactly
    // what they mean to do, not a sign anything is broken.
    const INTERACTIVE_SELECTOR =
      'a, button, input, select, textarea, option, label, summary, [role="button"], [role="link"], [role="tab"], [contenteditable="true"], [contenteditable=""]';
    const REPEATABLE_SELECTOR = "[data-agent-repeatable]";
    const WIDGET_SELECTOR = "[data-agent-mock-widget]";

    /** A rough, best-effort "selector" for the 60s cooldown key — not a
     * real CSS selector, just a stable-enough shape (tag + id + first
     * class) for a single-page rehearsal demo where the DOM doesn't churn
     * mid-session. */
    function describeElement(element: Element): string {
      const id = element.id ? `#${element.id}` : "";
      const firstClass = element.classList.item(0);
      const cls = firstClass ? `.${firstClass}` : "";
      return `${element.tagName}${id}${cls}`;
    }

    function handlePointerDown(event: PointerEvent) {
      try {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        if (target.closest(WIDGET_SELECTOR)) return;
        if (target.closest(REPEATABLE_SELECTOR)) return;
        if (target.closest(INTERACTIVE_SELECTOR)) return;

        const now = Date.now();
        const point: PointRecord = { x: event.clientX, y: event.clientY, time: now };

        const recent = (recentClicksByElement.get(target) ?? []).filter(
          (record) => now - record.time <= RAGE_CLICK_WINDOW_MS
        );
        const matches = recent.filter((record) => withinRadius(record, point, RAGE_CLICK_RADIUS_PX));
        recent.push(point);
        recentClicksByElement.set(target, recent);

        if (matches.length + 1 < RAGE_CLICK_MIN_EVENTS) return;

        const key = describeElement(target);
        const lastFiredAt = cooldownByKey.get(key) ?? 0;
        if (now - lastFiredAt < RAGE_CLICK_COOLDOWN_MS) return;

        cooldownByKey.set(key, now);
        recentClicksByElement.set(target, []);
        setChat({ text: RAGE_CLICK_CHAT_TEXT, chips: [] });
      } catch {
        // Never let the local detector throw — the admin-triggered path
        // must keep working regardless of what this one does.
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  if (!chat) return null;

  return (
    <div
      role="status"
      data-agent-mock-widget=""
      className={`fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl transition-all duration-200 ease-out motion-reduce:transition-none ${
        visible ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm leading-relaxed text-slate-800">{chat.text}</p>
        <button
          type="button"
          onClick={() => setChat(null)}
          aria-label="Dismiss"
          className="-mr-1 -mt-1 shrink-0 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
        >
          ✕
        </button>
      </div>
      {chat.chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chat.chips.map((chip) => (
            <span
              key={chip}
              className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700"
            >
              {chip}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
