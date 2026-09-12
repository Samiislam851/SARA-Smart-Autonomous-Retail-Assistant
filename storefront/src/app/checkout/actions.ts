"use server";

import { redirect } from "next/navigation";
import {
  createOrder,
  getOrCreateCart,
  clearCart,
  incrementPromoUse,
  removeCartPromoCode,
} from "@/lib/db/repositories";
import {
  claimCheckoutForOrder,
  clearCheckoutState,
  getCheckoutState,
  saveCheckoutAddress,
  saveCheckoutDeliveryMethod,
} from "@/lib/db/repositories/checkoutState";
import { DELIVERY_OPTIONS } from "@/lib/checkout/delivery";
import { getCartPromoState } from "@/lib/promo/lookup";
import { addressSchema, deliveryMethodSchema, type Address } from "@/lib/schemas";
import { getSession } from "@/lib/session/auth";
import { readCartId } from "@/lib/session/cart";

const ADDRESS_FIELDS = [
  "fullName",
  "line1",
  "line2",
  "city",
  "state",
  "postalCode",
  "country",
  "phone",
] as const;

export interface AddressFormState {
  errors: Partial<Record<(typeof ADDRESS_FIELDS)[number] | "form", string>>;
  values: Partial<Record<(typeof ADDRESS_FIELDS)[number], string>>;
}

/** Checkout step 1: validates the address against the locked `Order.address` shape (`addressSchema`) and saves it. */
export async function saveAddressAction(
  _prevState: AddressFormState,
  formData: FormData
): Promise<AddressFormState> {
  const raw: Record<string, string> = {};
  for (const field of ADDRESS_FIELDS) {
    raw[field] = String(formData.get(field) ?? "").trim();
  }

  // `line2` is optional on `addressSchema` — an absent key, not an empty
  // string, is what "not provided" means to the schema.
  const candidate: Record<string, string> = { ...raw };
  if (!candidate.line2) delete candidate.line2;

  const parsed = addressSchema.safeParse(candidate);
  if (!parsed.success) {
    const errors: AddressFormState["errors"] = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !(key in errors)) {
        errors[key as (typeof ADDRESS_FIELDS)[number]] = issue.message;
      }
    }
    return { errors, values: raw };
  }

  const cartId = await readCartId();
  if (!cartId) redirect("/cart");
  const cart = await getOrCreateCart(cartId);
  if (cart.items.length === 0) redirect("/cart");

  await saveCheckoutAddress(cartId, parsed.data as Address);
  redirect("/checkout/delivery");
}

export interface DeliveryFormState {
  error?: string;
}

/** Checkout step 2: picks `standard | express`, which sets the shipping cost used from here on. */
export async function saveDeliveryAction(
  _prevState: DeliveryFormState,
  formData: FormData
): Promise<DeliveryFormState> {
  const parsed = deliveryMethodSchema.safeParse(formData.get("deliveryMethod"));
  if (!parsed.success) {
    return { error: "Choose a delivery method to continue." };
  }

  const cartId = await readCartId();
  if (!cartId) redirect("/cart");
  const cart = await getOrCreateCart(cartId);
  if (cart.items.length === 0) redirect("/cart");

  const checkoutState = await getCheckoutState(cartId);
  if (!checkoutState?.address) redirect("/checkout/address");

  await saveCheckoutDeliveryMethod(cartId, parsed.data);
  redirect("/checkout/payment");
}

/**
 * Checkout step 4's final submit. Re-validates everything server-side
 * (never trusts that the page's own guard already ran) and is safe to
 * submit twice: `claimCheckoutForOrder` atomically claims this cart's
 * checkout before `createOrder` is ever called, so a double-click or a
 * second concurrent submit for the same cart can never create two orders —
 * the loser (claim returns `false`) redirects to `/cart` instead, which by
 * then the winner is in the process of clearing anyway.
 *
 * Promo code (Feature A): re-validated here even though it was already
 * validated when applied on the cart page and again on the review step —
 * neither of those runs is trusted at placement, because a code can expire
 * or hit its `maxUses` cap in the gap between "added to cart" and "checking
 * out." An applied-but-now-invalid code is DROPPED (the cart's `promoCode`
 * is cleared) and the shopper is sent back to `/cart` to see why and
 * continue without it — it is never silently honoured, and it never blocks
 * the cart from being checked out again at full price.
 */
export async function placeOrderAction(): Promise<void> {
  const cartId = await readCartId();
  if (!cartId) redirect("/cart");

  const cart = await getOrCreateCart(cartId);
  if (cart.items.length === 0) {
    // Either genuinely nothing to order, or this is a refresh/double-submit
    // arriving after the winning submit already cleared the cart — either
    // way there is nothing left to place, and /cart is never a broken page.
    redirect("/cart");
  }

  const checkoutState = await getCheckoutState(cartId);
  if (!checkoutState?.address) redirect("/checkout/address");
  if (!checkoutState.deliveryMethod) redirect("/checkout/delivery");

  const promoState = await getCartPromoState(cart);
  if (promoState && !promoState.result.valid) {
    await removeCartPromoCode(cartId);
    redirect("/cart?promoRemoved=1");
  }
  const discount = promoState?.result.valid ? promoState.result.discount : 0;
  const promoCode = promoState?.result.valid ? promoState.code : undefined;

  const claimed = await claimCheckoutForOrder(cartId);
  if (!claimed) redirect("/cart");

  const session = await getSession();
  const shipping = DELIVERY_OPTIONS[checkoutState.deliveryMethod].cost;

  const order = await createOrder({
    ...(session ? { userId: session.userId } : {}),
    items: cart.items,
    currency: cart.currency,
    shipping,
    discount,
    ...(promoCode !== undefined ? { promoCode } : {}),
    address: checkoutState.address,
    deliveryMethod: checkoutState.deliveryMethod,
  });

  if (promoCode !== undefined) {
    await incrementPromoUse(promoCode);
  }

  await clearCart(cartId);
  await clearCheckoutState(cartId);

  redirect(`/checkout/success?order=${encodeURIComponent(order.orderNumber)}`);
}
