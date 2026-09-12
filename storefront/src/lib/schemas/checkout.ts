import { z } from "zod";
import { objectIdSchema } from "./common";
import { addressSchema, deliveryMethodSchema } from "./order";

/**
 * In-progress checkout state, feature 7/8's own addition — NOT part of the
 * locked `Cart`/`Order` contracts in BUILD-DECISIONS.md §11 (do not edit
 * `schemas/cart.ts` or `schemas/order.ts` for this; both are verified).
 * Lives in its own `checkoutStates` collection, one document per cart,
 * keyed by the same `cartId` cookie value the cart itself uses — see
 * BUILD-DECISIONS.md §11.13 for why a separate collection was chosen over
 * extending the `Cart` document.
 *
 * `address`/`deliveryMethod` are optional because they're filled in one
 * checkout step at a time; `orderClaimed` is the double-submit guard
 * (`claimCheckoutForOrder` in the repository) — set exactly once, the first
 * time `placeOrderAction` successfully claims this cart for order creation.
 */
export const checkoutStateSchema = z.object({
  _id: objectIdSchema,
  cartId: z.string().min(1).max(200),
  address: addressSchema.optional(),
  deliveryMethod: deliveryMethodSchema.optional(),
  orderClaimed: z.boolean().default(false),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type CheckoutState = z.infer<typeof checkoutStateSchema>;
