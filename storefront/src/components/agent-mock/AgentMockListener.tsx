"use client";

/**
 * ⚠️ UNCOMMITTED PROTOTYPE — REHEARSAL ONLY, NEVER COMMITTED.
 * Intentionally crosses BUILD-DECISIONS.md §0 for a local real-time demo
 * only. See `src/lib/agent-mock/bus.ts`. Do not edit BUILD-DECISIONS.md.
 *
 * Mounted only on `/cart` (see `src/app/cart/page.tsx`). Opens an
 * `EventSource` to `/api/agent-mock/stream`, which is scoped server-side to
 * the signed-in session user, and applies a FIXED allow-list of DOM effects
 * ("glow", "clear") to existing elements on the page. It never trusts an
 * arbitrary action/selector from the server payload beyond that allow-list —
 * mirrors how the real agent design never lets the page executes arbitrary
 * commands. Renders nothing itself.
 */
import { useEffect } from "react";

const ALLOWED_ACTIONS = ["glow", "clear"] as const;
type AllowedAction = (typeof ALLOWED_ACTIONS)[number];

interface AgentMockCommand {
  action: AllowedAction;
  target: string;
  ttlMs?: number;
}

const DEFAULT_GLOW_TTL_MS = 8_000;
const GLOW_CLASS = "agent-pulse";

function isAgentMockCommand(value: unknown): value is AgentMockCommand {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.action === "string" &&
    (ALLOWED_ACTIONS as readonly string[]).includes(record.action) &&
    typeof record.target === "string" &&
    (record.ttlMs === undefined || typeof record.ttlMs === "number")
  );
}

export function AgentMockListener() {
  useEffect(() => {
    // `EventSource` isn't implemented in the jsdom test environment (or any
    // non-browser environment) — no-op rather than throw there, same as it
    // would in a real browser lacking the API.
    if (typeof EventSource === "undefined") return;

    const source = new EventSource("/api/agent-mock/stream");
    const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

    function applyCommand(command: AgentMockCommand) {
      // The target might not exist (e.g. cart just emptied, no checkout
      // button on the page) — that's expected, just do nothing.
      const element = document.querySelector(command.target);
      if (!element) return;

      if (command.action === "glow") {
        element.classList.add(GLOW_CLASS);
        const timer = setTimeout(() => {
          element.classList.remove(GLOW_CLASS);
          pendingTimers.delete(timer);
        }, command.ttlMs ?? DEFAULT_GLOW_TTL_MS);
        pendingTimers.add(timer);
      } else if (command.action === "clear") {
        element.classList.remove(GLOW_CLASS);
      }
    }

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
      // anything else (unknown action, wrong shape) is silently dropped —
      // fixed allow-list only, no arbitrary command execution.
    }

    source.addEventListener("agent-command", handleAgentCommand);

    return () => {
      source.removeEventListener("agent-command", handleAgentCommand);
      source.close();
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
    };
  }, []);

  return null;
}
