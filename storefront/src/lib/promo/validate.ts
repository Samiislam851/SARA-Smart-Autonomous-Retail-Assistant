import type { PromoCodeDTO } from "@/lib/db/repositories";

/**
 * Feature A (promo codes) — pure validation/arithmetic, no database access.
 * `src/lib/promo/lookup.ts` is the thin async wrapper that fetches a
 * `PromoCodeDTO` and calls into here; this module is deliberately kept
 * synchronous and side-effect-free so it can be unit tested and reused
 * anywhere (cart page, checkout review, order placement) without repeating
 * the rules.
 */

export type PromoInvalidReason =
  | "not_found"
  | "inactive"
  | "expired"
  | "max_uses"
  | "below_minimum";

export type PromoValidationResult =
  | { valid: true; discount: number }
  | { valid: false; reason: PromoInvalidReason };

export const PROMO_ERROR_MESSAGES: Record<PromoInvalidReason, string> = {
  not_found: "That promo code doesn't exist.",
  inactive: "That promo code is no longer active.",
  expired: "That promo code has expired.",
  max_uses: "That promo code has reached its usage limit.",
  below_minimum: "Your order doesn't meet the minimum subtotal for this promo code.",
};

/**
 * `percent` discounts a share of `subtotal` only, never `shipping` (per the
 * feature brief). Rounded DOWN to the nearest whole minor unit — the
 * rounding direction is deliberately in the store's favour and applied
 * consistently everywhere a percent discount is computed, so the cart page,
 * checkout review and the placed order can never disagree by a cent.
 * `fixed` is the code's raw face value, unclamped here — only the final
 * order `total` is clamped to 0 (`computeOrderTotal` in `schemas/order.ts`).
 */
export function computePromoDiscount(
  promo: Pick<PromoCodeDTO, "type" | "value">,
  subtotal: number
): number {
  if (promo.type === "percent") {
    return Math.floor((subtotal * promo.value) / 100);
  }
  return promo.value;
}

/**
 * Re-validates a promo code against the current cart subtotal. Never trusts
 * a stored/previously-computed discount — every field checked here
 * (`isActive`, `expiresAt`, `usedCount`/`maxUses`, `minSubtotal`) is read
 * fresh from the promo document passed in, which callers must fetch fresh
 * (see `lookup.ts`). `promo: null` covers both "no such code" and "the code
 * was applied but has since been deleted."
 */
export function validatePromoForCart(
  promo: PromoCodeDTO | null,
  subtotal: number,
  now: Date = new Date()
): PromoValidationResult {
  if (!promo) return { valid: false, reason: "not_found" };
  if (!promo.isActive) return { valid: false, reason: "inactive" };
  if (promo.expiresAt && Date.parse(promo.expiresAt) < now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  if (promo.maxUses !== undefined && promo.usedCount >= promo.maxUses) {
    return { valid: false, reason: "max_uses" };
  }
  if (subtotal < promo.minSubtotal) return { valid: false, reason: "below_minimum" };
  return { valid: true, discount: computePromoDiscount(promo, subtotal) };
}
