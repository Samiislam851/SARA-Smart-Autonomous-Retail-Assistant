import { getPromoCodeByCode, type CartWithTotals } from "@/lib/db/repositories";
import { validatePromoForCart, type PromoValidationResult } from "./validate";

export interface CartPromoState {
  /** The code as stored on the cart (already uppercase). */
  code: string;
  result: PromoValidationResult;
}

/**
 * The one place that turns "a cart with an applied `promoCode`" into
 * "the current, freshly-recomputed validation result." Used by the cart
 * page and the checkout review step so both agree, and re-run again (not
 * trusted from either of those) at order placement in
 * `src/app/checkout/actions.ts`. Returns `null` when no code is applied —
 * distinct from an applied-but-invalid code, which returns a `result` with
 * `valid: false`.
 */
export async function getCartPromoState(
  cart: Pick<CartWithTotals, "promoCode" | "subtotal">
): Promise<CartPromoState | null> {
  if (!cart.promoCode) return null;
  const promo = await getPromoCodeByCode(cart.promoCode);
  const result = validatePromoForCart(promo, cart.subtotal);
  return { code: cart.promoCode, result };
}
