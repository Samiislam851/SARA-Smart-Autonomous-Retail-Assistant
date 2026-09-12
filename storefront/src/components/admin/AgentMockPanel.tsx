"use client";

/**
 * ⚠️ UNCOMMITTED PROTOTYPE — REHEARSAL ONLY, NEVER COMMITTED.
 * Intentionally crosses BUILD-DECISIONS.md §0 for a local real-time demo
 * only. See `src/lib/agent-mock/bus.ts`. Do not edit BUILD-DECISIONS.md.
 *
 * `/admin/agent-mock`'s table: one row per seeded user, a live "connected"
 * indicator (polled from `/api/agent-mock/connected`, which reflects who
 * has a live SSE stream open — cart tab or product tab, either counts), and
 * per-user trigger buttons for FOUR independent mocks that POST to
 * `/api/agent-mock/command`:
 *
 *  - cart_hesitation (pulse checkout) / Clear — needs the user on `/cart`.
 *    Deliberately sends NO chat: the spec is explicit that a chat message
 *    here is worse, because it adds a reading task to an overloaded shopper.
 *  - Variant churn (out of stock / fit) — needs the user on the product
 *    page named by the slug field below; that page's own real `variants`
 *    data is what the badge count and chat copy are computed from
 *    server-side, so the slug must match what the shopper actually has open.
 *  - Shipping info hunt — needs the user on ANY product page (`/p/<slug>`).
 *    Not slug-specific: the delivery estimate is computed from today's
 *    date, not from product data, so no slug is sent for this one.
 *  - Rage click — same surface (any PDP) and same "no slug needed" shape;
 *    this is the demo's insurance-beat trigger, kept deliberately simple.
 */
import { useEffect, useState } from "react";

interface AgentMockUser {
  _id: string;
  name: string;
  email: string;
}

const POLL_INTERVAL_MS = 2_000;
const DEFAULT_SLUG = "summit-trail-chino-pants-high";

type TriggerAction =
  | "glow"
  | "clear"
  | "variantChurnOutOfStock"
  | "variantChurnFit"
  | "shippingInfoHunt"
  | "rageClick";

const ACTION_LABEL: Record<TriggerAction, string> = {
  glow: "cart_hesitation",
  clear: "Clear",
  variantChurnOutOfStock: "Variant churn (out of stock)",
  variantChurnFit: "Variant churn (fit)",
  shippingInfoHunt: "Shipping info hunt",
  rageClick: "Rage click",
};

// Which surface a trigger needs the shopper on, and whether it needs the
// slug field's value sent along so the route can load that exact product.
const SLUG_ACTIONS = new Set<TriggerAction>(["variantChurnOutOfStock", "variantChurnFit"]);
const PDP_ACTIONS = new Set<TriggerAction>([
  "variantChurnOutOfStock",
  "variantChurnFit",
  "shippingInfoHunt",
  "rageClick",
]);

function isConnectedResponse(value: unknown): value is { userIds: string[] } {
  if (typeof value !== "object" || value === null) return false;
  const userIds = (value as Record<string, unknown>).userIds;
  return Array.isArray(userIds) && userIds.every((id) => typeof id === "string");
}

export function AgentMockPanel({ users }: { users: AgentMockUser[] }) {
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set());
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [slug, setSlug] = useState(DEFAULT_SLUG);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res = await fetch("/api/agent-mock/connected", { cache: "no-store" });
        if (!res.ok) return;
        const data: unknown = await res.json();
        if (!cancelled && isConnectedResponse(data)) {
          setConnectedIds(new Set(data.userIds));
        }
      } catch {
        // transient poll failure — next tick will retry
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  async function trigger(userId: string, userName: string, action: TriggerAction) {
    const key = `${userId}:${action}`;
    setPendingKey(key);
    setLastResult(null);
    const needsSlug = SLUG_ACTIONS.has(action);
    try {
      const res = await fetch("/api/agent-mock/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(needsSlug ? { userId, action, slug } : { userId, action }),
      });
      if (!res.ok) {
        setLastResult(`Failed to send to ${userName}.`);
        return;
      }
      const data: unknown = await res.json();
      const delivered =
        typeof data === "object" && data !== null && typeof (data as { delivered?: unknown }).delivered === "number"
          ? (data as { delivered: number }).delivered
          : 0;
      const surface = !PDP_ACTIONS.has(action) ? "/cart" : needsSlug ? `/p/${slug}` : "a product page";
      setLastResult(
        delivered > 0
          ? `${ACTION_LABEL[action]} sent to ${userName} (${delivered} open tab${delivered === 1 ? "" : "s"}).`
          : `${userName} doesn't have ${surface} open right now — nothing delivered.`
      );
    } catch {
      setLastResult(`Failed to send to ${userName}.`);
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {lastResult && (
        <p role="status" className="rounded-md bg-slate-100 p-3 text-sm text-slate-700">
          {lastResult}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Product page for variant-churn triggers (must match what the user has open)
          <input
            type="text"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="product-slug"
            className="w-72 rounded-md border border-slate-300 px-2 py-1.5 text-sm text-slate-900"
          />
        </label>
        <p className="text-xs text-slate-500">
          e.g. <code>{DEFAULT_SLUG}</code> — sent as <code>/p/{slug || "…"}</code>
        </p>
      </div>
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-semibold text-slate-700">
                User
              </th>
              <th scope="col" className="px-3 py-2 text-left font-semibold text-slate-700">
                Status
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold text-slate-700">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {users.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-8 text-center text-slate-500">
                  No seeded users.
                </td>
              </tr>
            )}
            {users.map((user) => {
              const isConnected = connectedIds.has(user._id);
              const glowPending = pendingKey === `${user._id}:glow`;
              const clearPending = pendingKey === `${user._id}:clear`;
              const oosPending = pendingKey === `${user._id}:variantChurnOutOfStock`;
              const fitPending = pendingKey === `${user._id}:variantChurnFit`;
              const shippingHuntPending = pendingKey === `${user._id}:shippingInfoHunt`;
              const rageClickPending = pendingKey === `${user._id}:rageClick`;
              return (
                <tr key={user._id}>
                  <td className="px-3 py-2">
                    <span className="font-medium text-slate-900">{user.name}</span>{" "}
                    <span className="text-slate-400">({user.email})</span>
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
                        isConnected ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600"
                      }`}
                    >
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${isConnected ? "bg-emerald-500" : "bg-slate-400"}`}
                        aria-hidden="true"
                      />
                      {isConnected ? "Connected" : "Not connected"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        disabled={pendingKey !== null}
                        onClick={() => void trigger(user._id, user.name, "glow")}
                        title="Needs the user on /cart"
                        className="rounded-md bg-amber-400 px-3 py-1.5 text-xs font-semibold text-slate-900 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                      >
                        {glowPending ? "Sending…" : "cart_hesitation — pulse checkout"}
                      </button>
                      <button
                        type="button"
                        disabled={pendingKey !== null}
                        onClick={() => void trigger(user._id, user.name, "variantChurnOutOfStock")}
                        title={`Needs the user on /p/${slug}`}
                        className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                      >
                        {oosPending ? "Sending…" : "Variant churn — out of stock"}
                      </button>
                      <button
                        type="button"
                        disabled={pendingKey !== null}
                        onClick={() => void trigger(user._id, user.name, "variantChurnFit")}
                        title={`Needs the user on /p/${slug}`}
                        className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                      >
                        {fitPending ? "Sending…" : "Variant churn — fit"}
                      </button>
                      <button
                        type="button"
                        disabled={pendingKey !== null}
                        onClick={() => void trigger(user._id, user.name, "shippingInfoHunt")}
                        title="Needs the user on a product page (/p/<slug>, any product)"
                        className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-teal-500 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                      >
                        {shippingHuntPending ? "Sending…" : "Shipping info hunt"}
                      </button>
                      <button
                        type="button"
                        disabled={pendingKey !== null}
                        onClick={() => void trigger(user._id, user.name, "rageClick")}
                        title="Needs the user on a product page (/p/<slug>, any product) — insurance-beat trigger"
                        className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-rose-500 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
                      >
                        {rageClickPending ? "Sending…" : "Rage click"}
                      </button>
                      <button
                        type="button"
                        disabled={pendingKey !== null}
                        onClick={() => void trigger(user._id, user.name, "clear")}
                        title="Clears glow (cart) and badge/chat/highlight (product page)"
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400"
                      >
                        {clearPending ? "Sending…" : "Clear"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
