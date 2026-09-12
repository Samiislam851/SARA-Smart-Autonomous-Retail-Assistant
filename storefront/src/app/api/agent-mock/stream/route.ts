/**
 * ⚠️ UNCOMMITTED PROTOTYPE — REHEARSAL ONLY, NEVER COMMITTED.
 * Intentionally crosses BUILD-DECISIONS.md §0 ("no sockets, SSE, or push")
 * for a local real-time demo only. See `src/lib/agent-mock/bus.ts` for the
 * full rationale. Do not edit BUILD-DECISIONS.md.
 *
 * Server-Sent Events endpoint: one shopper's browser opens this once (from
 * `AgentMockListener` on the cart page) and keeps it open. The user id is
 * read from the signed session cookie server-side — never from the query
 * string — so a visitor can only ever subscribe to their own commands.
 */
import { getSession } from "@/lib/session/auth";
import { subscribe, unsubscribe } from "@/lib/agent-mock/bus";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const KEEP_ALIVE_INTERVAL_MS = 20_000;

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  const userId = session.userId;

  const encoder = new TextEncoder();
  let keepAliveTimer: ReturnType<typeof setInterval> | undefined;
  let activeController: ReadableStreamDefaultController<Uint8Array> | undefined;

  function cleanup() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    if (activeController) unsubscribe(userId, activeController);
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      activeController = controller;
      subscribe(userId, controller);
      // Comment lines (":" prefix) are valid SSE and are ignored by
      // EventSource as data, but confirm the connection opened.
      controller.enqueue(encoder.encode(": agent-mock stream connected\n\n"));

      keepAliveTimer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, KEEP_ALIVE_INTERVAL_MS);
    },
    cancel() {
      cleanup();
    },
  });

  request.signal.addEventListener("abort", cleanup);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
