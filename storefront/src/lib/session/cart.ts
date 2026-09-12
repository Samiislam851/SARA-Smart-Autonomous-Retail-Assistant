import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

/**
 * The server-side cart is keyed by this httpOnly cookie's value (never a
 * user id — BUILD-DECISIONS.md §6/§11.5). Login does not touch this cookie
 * at all: `Cart` has no `userId` field, so there is nothing to "merge" on
 * sign-in beyond continuing to use the same cart — see BUILD-DECISIONS.md
 * §11.13. Logout is the exception: it clears both the cart and this
 * cookie, so a signed-out visitor always starts empty (§11.16).
 */
export const CART_COOKIE_NAME = "nextcart_cart_id";

const CART_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days

const CART_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: CART_COOKIE_MAX_AGE_SECONDS,
};

/**
 * Read-only — never creates a cookie. Use from Server Components (the cart
 * page, checkout pages, the header's item-count badge) so merely viewing a
 * page never mints a cart.
 */
export async function readCartId(): Promise<string | null> {
  const store = await cookies();
  return store.get(CART_COOKIE_NAME)?.value ?? null;
}

/**
 * Server Actions / Route Handlers only. Returns the existing cart id, or
 * mints and sets a new one. This is the ONLY function that ever creates the
 * cart cookie, and it is only ever called from a mutation (add-to-cart) —
 * never from a page view, per BUILD-DECISIONS.md's cart requirements.
 */
export async function ensureCartId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(CART_COOKIE_NAME)?.value;
  if (existing) return existing;

  const id = randomUUID();
  store.set(CART_COOKIE_NAME, id, CART_COOKIE_OPTIONS);
  return id;
}

/**
 * Server Actions / Route Handlers only. Drops the cart cookie entirely, so
 * the next request has no cart id at all and `readCartId` returns null.
 * Used by logout — a signed-out visitor must never see a previous session's
 * cart (BUILD-DECISIONS.md §11.16).
 */
export async function clearCartCookie(): Promise<void> {
  const store = await cookies();
  store.delete(CART_COOKIE_NAME);
}
