/**
 * ⚠️ UNCOMMITTED PROTOTYPE — REHEARSAL ONLY, NEVER COMMITTED.
 * Intentionally crosses BUILD-DECISIONS.md §0 for a local real-time demo
 * only. See `src/lib/agent-mock/bus.ts`. Do not edit BUILD-DECISIONS.md.
 *
 * Admin-only trigger, now covering four mocks that share the same SSE bus:
 *
 *  - `glow` / `clear` — the cart_hesitation mock. Always targets the cart page's
 *    `data-agent-target="begin-checkout"` button; unchanged from before.
 *  - `variantChurnOutOfStock` / `variantChurnFit` — the "size/colour
 *    indecision" mock. The admin also supplies which product's PDP the
 *    shopper is on (`slug`); the route loads that product server-side and
 *    computes the badge/chat copy from its REAL `variants`, then publishes
 *    a small sequence (`chat` + its paired `badge`/`reveal`) so the demo
 *    shows the agent doing two things at once. The client never gets to
 *    choose the target or the copy — same trust boundary as the original
 *    glow mock.
 *  - `shippingInfoHunt` — the "delivery uncertainty" mock. No product data
 *    needed: the route computes a REAL delivery-date estimate from today's
 *    date (`computeShippingEstimate`, never a hardcoded string) and
 *    publishes it as `chat`, paired with a `reveal` on the same
 *    shipping/returns accordion the `variantChurnFit` mock already targets.
 *  - `rageClick` — the "frustration burst" mock, and the demo's insurance
 *    beat: `chat` only, fixed acknowledging copy, no product/session
 *    history required. The SAME copy also fires from an optional
 *    client-side local detector in `PdpAgentMockListener` — both read it
 *    from `src/lib/agent-mock/rage-click.ts` so they can't drift apart.
 */
import { getSession } from "@/lib/session/auth";
import { objectIdSchema, slugSchema } from "@/lib/schemas";
import { getProductBySlug } from "@/lib/db/repositories";
import { publish } from "@/lib/agent-mock/bus";
import { fitChatCopy, outOfStockChatCopy, sizeStockBadgeText } from "@/lib/agent-mock/variant-churn";
import { shippingHuntChatCopy } from "@/lib/agent-mock/shipping-hunt";
import { RAGE_CLICK_CHAT_TEXT } from "@/lib/agent-mock/rage-click";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CHECKOUT_TARGET_SELECTOR = '[data-agent-target="begin-checkout"]';
const SIZE_SELECTOR_TARGET = '[data-agent-target="size-selector"]';
const SHIPPING_INFO_TARGET = '[data-agent-target="shipping-info"]';

// Spec value for cart_hesitation's prescribed response:
// {"action":"highlight","target":"begin-checkout","style":"pulse","ttlMs":8000}
const GLOW_TTL_MS = 8_000;
const REVEAL_TTL_MS = 4_000;

const CART_ACTIONS = ["glow", "clear"] as const;
const VARIANT_CHURN_ACTIONS = ["variantChurnOutOfStock", "variantChurnFit"] as const;
// Both new signals need no new command types — they only ever publish the
// existing `chat` (and, for `shippingInfoHunt`, `reveal`) actions the PDP
// listener already allow-lists.
const CHAT_ONLY_ACTIONS = ["shippingInfoHunt", "rageClick"] as const;
type CartAction = (typeof CART_ACTIONS)[number];
type VariantChurnAction = (typeof VARIANT_CHURN_ACTIONS)[number];
type ChatOnlyAction = (typeof CHAT_ONLY_ACTIONS)[number];

function isCartAction(value: unknown): value is CartAction {
  return typeof value === "string" && (CART_ACTIONS as readonly string[]).includes(value);
}

function isVariantChurnAction(value: unknown): value is VariantChurnAction {
  return typeof value === "string" && (VARIANT_CHURN_ACTIONS as readonly string[]).includes(value);
}

function isChatOnlyAction(value: unknown): value is ChatOnlyAction {
  return typeof value === "string" && (CHAT_ONLY_ACTIONS as readonly string[]).includes(value);
}

export async function POST(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session || session.role !== "admin") {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return new Response("Invalid body", { status: 400 });
  }

  const { userId, action, slug } = body as Record<string, unknown>;

  const parsedUserId = objectIdSchema.safeParse(userId);
  if (!parsedUserId.success) {
    return new Response("Invalid userId", { status: 400 });
  }

  if (isCartAction(action)) {
    const delivered = publish(parsedUserId.data, {
      action,
      target: CHECKOUT_TARGET_SELECTOR,
      ...(action === "glow" ? { ttlMs: GLOW_TTL_MS } : {}),
    });
    return Response.json({ delivered });
  }

  if (isVariantChurnAction(action)) {
    const parsedSlug = slugSchema.safeParse(slug);
    if (!parsedSlug.success) {
      return new Response("Invalid slug", { status: 400 });
    }

    const product = await getProductBySlug(parsedSlug.data);
    if (!product) {
      return new Response("Product not found", { status: 404 });
    }

    if (action === "variantChurnOutOfStock") {
      const { text, chips } = outOfStockChatCopy(product.variants);
      const badgeText = sizeStockBadgeText(product.variants);
      const chatDelivered = publish(parsedUserId.data, { action: "chat", text, chips });
      publish(parsedUserId.data, { action: "badge", target: SIZE_SELECTOR_TARGET, text: badgeText });
      return Response.json({ delivered: chatDelivered, badgeText });
    }

    // variantChurnFit
    const { text, chips } = fitChatCopy();
    const chatDelivered = publish(parsedUserId.data, { action: "chat", text, chips });
    publish(parsedUserId.data, { action: "reveal", target: SHIPPING_INFO_TARGET, ttlMs: REVEAL_TTL_MS });
    return Response.json({ delivered: chatDelivered });
  }

  if (isChatOnlyAction(action)) {
    if (action === "shippingInfoHunt") {
      // No product lookup needed — the estimate is computed from today's
      // date, not from anything product-specific.
      const { text, chips } = shippingHuntChatCopy();
      const chatDelivered = publish(parsedUserId.data, { action: "chat", text, chips });
      publish(parsedUserId.data, { action: "reveal", target: SHIPPING_INFO_TARGET, ttlMs: REVEAL_TTL_MS });
      return Response.json({ delivered: chatDelivered });
    }

    // rageClick — chat only, fixed copy, no paired DOM effect. The tone is
    // the entire point; see `src/lib/agent-mock/rage-click.ts`.
    const delivered = publish(parsedUserId.data, { action: "chat", text: RAGE_CLICK_CHAT_TEXT, chips: [] });
    return Response.json({ delivered });
  }

  return new Response("Invalid action", { status: 400 });
}
