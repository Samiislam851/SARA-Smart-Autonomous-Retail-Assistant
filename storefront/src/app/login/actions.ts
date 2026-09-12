"use server";

import { redirect } from "next/navigation";
import { clearCart, getUserById } from "@/lib/db/repositories";
import { clearSession, setSession } from "@/lib/session/auth";
import { clearCartCookie, readCartId } from "@/lib/session/cart";

/**
 * Mock login — no password (BUILD-DECISIONS.md §5). `userId`/`next` are
 * bound server-action arguments (`loginAction.bind(null, user._id, next)`),
 * set from the fixed, server-rendered list of seeded users — not typed by
 * the visitor — so there is no untrusted "pick any id" input here beyond
 * choosing which button to press.
 *
 * Cart/session relationship (§11.13): signing IN never touches the cart
 * cookie.
 * `Cart` has no `userId` field, so signing in doesn't create, swap, or drop
 * a cart — the same httpOnly `cartId` cookie keeps working before and after
 * login, which is how an anonymous cart "merges" into the signed-in
 * session: there is nothing to merge, because it was never a different
 * cart.
 */
export async function loginAction(userId: string, next: string | undefined): Promise<void> {
  const user = await getUserById(userId);
  if (!user) redirect("/login");

  await setSession({ userId: user._id, role: user.role });
  redirect(next && next.startsWith("/") ? next : "/");
}

/**
 * Signing out empties the cart and drops the cart cookie, so a signed-out
 * visitor always sees an empty cart and a zero badge (BUILD-DECISIONS.md
 * §11.16). The cart document is emptied as well as orphaned, so the id can
 * never be resurrected with items still in it.
 */
export async function logoutAction(): Promise<void> {
  const cartId = await readCartId();
  if (cartId) await clearCart(cartId);
  await clearCartCookie();
  await clearSession();
  redirect("/");
}
