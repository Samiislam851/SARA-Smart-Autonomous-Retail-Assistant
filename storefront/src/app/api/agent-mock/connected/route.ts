/**
 * ⚠️ UNCOMMITTED PROTOTYPE — REHEARSAL ONLY, NEVER COMMITTED.
 * Intentionally crosses BUILD-DECISIONS.md §0 for a local real-time demo
 * only. See `src/lib/agent-mock/bus.ts`. Do not edit BUILD-DECISIONS.md.
 *
 * Admin-only read: lets the admin mock page poll "who is actually on the
 * cart page right now" (i.e. who has a live SSE stream open) so the
 * operator doesn't have to guess before clicking "Glow checkout".
 */
import { getSession } from "@/lib/session/auth";
import { connectedUserIds } from "@/lib/agent-mock/bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return new Response("Unauthorized", { status: 401 });
  }

  return Response.json({ userIds: connectedUserIds() });
}
