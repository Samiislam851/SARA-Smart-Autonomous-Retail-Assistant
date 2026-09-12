/**
 * ⚠️ UNCOMMITTED PROTOTYPE — REHEARSAL ONLY, NEVER COMMITTED.
 *
 * This file intentionally crosses BUILD-DECISIONS.md §0 ("no sockets, SSE,
 * or push") to prove out a real-time admin -> shopper demo. It exists only
 * in the working tree for a live rehearsal and must never be `git add`ed or
 * committed. Do not edit BUILD-DECISIONS.md to "make this legal" — the rule
 * still protects the real, committed repo; this prototype is exempt only
 * because it never enters git history.
 *
 * In-memory pub/sub for the agent-mock SSE demo: one signed-in shopper can
 * be subscribed from at most a handful of open tabs, and the admin panel
 * publishes a command to exactly one user id at a time.
 *
 * State lives in a module-level Map, which means:
 *  - it resets to empty on every dev-server restart (expected, fine for a
 *    local demo — nobody needs commands to survive a restart), and
 *  - it would NOT be shared across multiple server instances/processes
 *    (no Redis, no DB — a real deployment would need a shared broker).
 * Both are acceptable for a single local `next dev` process.
 */

export const AGENT_MOCK_ACTIONS = ["glow", "clear", "chat", "badge", "reveal"] as const;
export type AgentMockAction = (typeof AGENT_MOCK_ACTIONS)[number];

/**
 * `target` is required for the DOM-attached actions (`glow`, `badge`,
 * `reveal`) and the cart's `clear`, but a `chat` command has no DOM target
 * of its own — it renders a floating bubble the listener owns — and a
 * broadcast `clear` (variant-churn's "wipe everything" button) is also
 * happily target-less, so every listener resets its own local effects
 * regardless of what (if anything) `target` names. `text`/`chips` only
 * apply to `chat` and `badge`. Every field beyond `action` stays optional
 * here; each listener's own allow-list decides what it actually needs.
 */
export interface AgentMockCommand {
  action: AgentMockAction;
  target?: string;
  ttlMs?: number;
  text?: string;
  chips?: string[];
}

type Subscriber = ReadableStreamDefaultController<Uint8Array>;

const subscribersByUserId = new Map<string, Set<Subscriber>>();

const encoder = new TextEncoder();

/** Registers an open SSE stream controller for a user. */
export function subscribe(userId: string, controller: Subscriber): void {
  let subscribers = subscribersByUserId.get(userId);
  if (!subscribers) {
    subscribers = new Set();
    subscribersByUserId.set(userId, subscribers);
  }
  subscribers.add(controller);
}

/** Removes a stream controller, e.g. on client disconnect/abort. */
export function unsubscribe(userId: string, controller: Subscriber): void {
  const subscribers = subscribersByUserId.get(userId);
  if (!subscribers) return;
  subscribers.delete(controller);
  if (subscribers.size === 0) subscribersByUserId.delete(userId);
}

/**
 * Sends a command to every live stream for one user (normally just one tab).
 * Returns how many streams actually received it, purely so the caller/admin
 * UI can tell "nobody was listening" apart from "sent". A controller that
 * throws on enqueue (already closed but not yet cleaned up) is dropped here
 * rather than left to error again later.
 */
export function publish(userId: string, command: AgentMockCommand): number {
  const subscribers = subscribersByUserId.get(userId);
  if (!subscribers || subscribers.size === 0) return 0;

  const payload = encoder.encode(`event: agent-command\ndata: ${JSON.stringify(command)}\n\n`);
  let delivered = 0;
  for (const controller of subscribers) {
    try {
      controller.enqueue(payload);
      delivered++;
    } catch {
      subscribers.delete(controller);
    }
  }
  return delivered;
}

/** Whether the given user currently has at least one open SSE stream. */
export function isConnected(userId: string): boolean {
  return (subscribersByUserId.get(userId)?.size ?? 0) > 0;
}

/** All user ids that currently have at least one open SSE stream. */
export function connectedUserIds(): string[] {
  return [...subscribersByUserId.entries()]
    .filter(([, subscribers]) => subscribers.size > 0)
    .map(([userId]) => userId);
}
