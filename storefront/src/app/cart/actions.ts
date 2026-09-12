"use server";

import { revalidatePath } from "next/cache";
import {
  getOrCreateCart,
  getPromoCodeByCode,
  removeCartItem,
  removeCartPromoCode,
  setCartPromoCode,
  updateCartItemQuantity,
} from "@/lib/db/repositories";
import { PROMO_ERROR_MESSAGES, validatePromoForCart } from "@/lib/promo/validate";
import { promoCodeStringSchema, type VariantSelection } from "@/lib/schemas";
import { readCartId } from "@/lib/session/cart";

/** No-ops if there is no cart cookie yet — there is nothing to update. */
export async function updateCartItemQuantityAction(
  productId: string,
  variantSelection: VariantSelection,
  quantity: number
): Promise<void> {
  const cartId = await readCartId();
  if (!cartId) return;
  await updateCartItemQuantity(cartId, productId, variantSelection, quantity);
  revalidatePath("/cart");
}

export async function removeCartItemAction(
  productId: string,
  variantSelection: VariantSelection
): Promise<void> {
  const cartId = await readCartId();
  if (!cartId) return;
  await removeCartItem(cartId, productId, variantSelection);
  revalidatePath("/cart");
}

export interface PromoCodeFormState {
  error?: string;
}

/**
 * "Have a promo code?" on the cart page. Validates the code against the
 * cart's CURRENT subtotal (never a stale/remembered one) before storing it
 * — an unknown, inactive, expired, maxUses-exhausted, or below-minimum code
 * is never persisted onto the cart, it just returns an error message for
 * the form to show. A code that validates here can still stop validating
 * later (it's re-checked on every read via `getCartPromoState` — see
 * `src/lib/promo/lookup.ts` — and again at order placement).
 */
export async function applyPromoCodeAction(
  _prevState: PromoCodeFormState,
  formData: FormData
): Promise<PromoCodeFormState> {
  const raw = String(formData.get("code") ?? "").trim().toUpperCase();
  const parsedCode = promoCodeStringSchema.safeParse(raw);
  if (!parsedCode.success) {
    return { error: "Enter a valid promo code." };
  }

  const cartId = await readCartId();
  if (!cartId) return { error: "Your cart is empty." };

  const cart = await getOrCreateCart(cartId);
  if (cart.items.length === 0) return { error: "Your cart is empty." };

  const promo = await getPromoCodeByCode(parsedCode.data);
  const result = validatePromoForCart(promo, cart.subtotal);
  if (!result.valid) {
    return { error: PROMO_ERROR_MESSAGES[result.reason] };
  }

  await setCartPromoCode(cartId, parsedCode.data);
  revalidatePath("/cart");
  return {};
}

export async function removePromoCodeAction(): Promise<void> {
  const cartId = await readCartId();
  if (!cartId) return;
  await removeCartPromoCode(cartId);
  revalidatePath("/cart");
}
