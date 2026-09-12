import { z } from "zod";
import {
  DEFAULT_CURRENCY,
  currencySchema,
  imagePathSchema,
  moneyMinorUnitsSchema,
  objectIdSchema,
  promoCodeStringSchema,
  quantitySchema,
  slugSchema,
} from "./common";
import { variantTypeSchema } from "./product";

/**
 * The variant options the shopper picked on the PDP, e.g. { size: "M",
 * colour: "midnight-blue" }. Keys are `VariantType`s, values are the matching
 * `ProductVariant.value`, so the bounds here mirror `productVariantSchema`.
 *
 * Partial, not full: a product may have sizes but no colours, and an
 * unselected control must not be forced to invent a value.
 */
export const variantSelectionSchema = z.partialRecord(
  variantTypeSchema,
  z.string().min(1).max(80)
);
export type VariantSelection = z.infer<typeof variantSelectionSchema>;

export const cartItemSchema = z.object({
  productId: objectIdSchema,
  slug: slugSchema,
  title: z.string().min(1).max(300),
  /** Integer minor units, snapshotted at time of add-to-cart. */
  price: moneyMinorUnitsSchema,
  quantity: quantitySchema,
  variantSelection: variantSelectionSchema.default({}),
  imagePath: imagePathSchema,
});
export type CartItem = z.infer<typeof cartItemSchema>;

export const cartSchema = z.object({
  _id: objectIdSchema,
  /** Value of the httpOnly cart-id cookie — not a user id. */
  cartId: z.string().min(1).max(200),
  /**
   * Currency for every line in this cart. Held once at cart level rather
   * than per item, which makes a mixed-currency cart unrepresentable.
   */
  currency: currencySchema.default(DEFAULT_CURRENCY),
  items: z.array(cartItemSchema).max(100),
  /**
   * Feature A (promo codes): the code applied to this cart, if any. Only
   * the code string is stored here — never a discount amount. The discount
   * itself is never persisted on the cart; it is recomputed server-side
   * from this code against the current line items on every read (cart
   * page, checkout review, order placement), so a stale/expired/deactivated
   * code can never keep silently applying a discount it no longer earns.
   * See `src/lib/promo/validate.ts`.
   */
  promoCode: promoCodeStringSchema.optional(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type Cart = z.infer<typeof cartSchema>;

/** Shape for creating a cart — server assigns `_id` and timestamps. */
export const cartInputSchema = cartSchema.omit({
  _id: true,
  createdAt: true,
  updatedAt: true,
});
export type CartInput = z.infer<typeof cartInputSchema>;

/**
 * Line total and cart subtotal in integer minor units. The only sanctioned
 * way to total a cart — features 6, 7 and 8 must call these rather than
 * re-implementing the arithmetic, so the cart page and the order document
 * can never disagree.
 */
export function lineTotal(item: Pick<CartItem, "price" | "quantity">): number {
  return item.price * item.quantity;
}

export function cartSubtotal(
  items: readonly Pick<CartItem, "price" | "quantity">[]
): number {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}
