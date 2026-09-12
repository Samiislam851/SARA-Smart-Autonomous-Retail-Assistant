import type { Metadata } from "next";
import { listMockUsers } from "@/lib/db/repositories";
import { AgentMockPanel } from "@/components/admin/AgentMockPanel";

export const metadata: Metadata = { title: "Admin — Agent mock — NextCart" };

/**
 * ⚠️ UNCOMMITTED PROTOTYPE — REHEARSAL ONLY, NEVER COMMITTED.
 * Intentionally crosses BUILD-DECISIONS.md §0 for a local real-time demo
 * only. See `src/lib/agent-mock/bus.ts`. Do not edit BUILD-DECISIONS.md.
 *
 * Stands in for the real behavioural agent: here a human admin plays the
 * "agent" by clicking a button for a specific user instead of an AI model
 * deciding to. Behind the existing `/admin/*` middleware gate — no new
 * gate needed. Rehearses the plumbing only (in-memory SSE pub/sub — see
 * `src/lib/agent-mock/bus.ts`); production would need a real event source
 * driving `publish()` and a broker that survives multiple server instances.
 */
export default async function AdminAgentMockPage() {
  const users = await listMockUsers();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Agent mock (prototype)</h1>
        <p className="mt-1 text-sm text-slate-600">
          Uncommitted rehearsal prototype — proves the plumbing for a live agent-to-shopper
          moment, not a real feature. Four independent mocks share the same live connection
          below: &ldquo;Glow checkout&rdquo; pulses the cart page&apos;s checkout button (needs
          the user on <code>/cart</code>); &ldquo;Variant churn&rdquo; simulates the
          size/colour-indecision signal on a product page (needs the user on{" "}
          <code>/p/&lt;slug&gt;</code> — set the slug below to match); &ldquo;Shipping info
          hunt&rdquo; and &ldquo;Rage click&rdquo; need the user on any product page and don&apos;t
          depend on the slug field at all. Everything arrives over SSE with no refresh on the
          shopper&apos;s end.
        </p>
      </div>
      <AgentMockPanel users={users.map(({ _id, name, email }) => ({ _id, name, email }))} />
    </div>
  );
}
