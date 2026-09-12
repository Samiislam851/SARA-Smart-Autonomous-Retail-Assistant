import { z } from "zod";
import { cartItemSchema, cartSubtotal } from "./cart";
import {
  currencySchema,
  moneyMinorUnitsSchema,
  objectIdSchema,
  promoCodeStringSchema,
} from "./common";

/**
 * Shipping address, captured at checkout step 1. BUILD-DECISIONS.md does not
 * specify the field list; this is the locked shape — see §11. It is
 * deliberately country-agnostic (free-text `state`/`country`, loose
 * `postalCode`) because a COD demo store must not reject a valid foreign
 * address on a format technicality.
 *
 * There is no separate billing address: COD has no payment instrument to
 * bill, so one address is the whole story.
 */
export const addressSchema = z.object({
  fullName: z.string().min(1).max(200),
  line1: z.string().min(1).max(300),
  line2: z.string().max(300).optional(),
  city: z.string().min(1).max(120),
  state: z.string().min(1).max(120),
  postalCode: z.string().min(1).max(20),
  country: z.string().min(1).max(120),
  phone: z.string().min(1).max(40),
});
export type Address = z.infer<typeof addressSchema>;

/**
 * Order lifecycle. Not specified in BUILD-DECISIONS.md — locked in §11 as the
 * minimal COD lifecycle. `placed` is the only status the storefront ever
 * writes; the rest exist for the admin panel to move an order through.
 */
export const orderStatusSchema = z.enum([
  "placed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;

/**
 * Delivery option chosen at checkout step 2. Without this the order document
 * records a `shipping` cost but not *what the shopper chose*, so the review
 * step and the confirmation page cannot name the delivery speed back to them.
 */
export const deliveryMethodSchema = z.enum(["standard", "express"]);
export type DeliveryMethod = z.infer<typeof deliveryMethodSchema>;

/** Cash on delivery only — BUILD-DECISIONS.md §6. No card surface, ever. */
export const paymentMethodSchema = z.literal("cod");
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

const orderShape = {
  _id: objectIdSchema,
  orderNumber: z.string().min(1).max(40),
  /** Absent for guest checkout. */
  userId: objectIdSchema.optional(),
  items: z.array(cartItemSchema).min(1).max(100),
  currency: currencySchema,
  /** All money fields are integer minor units. */
  subtotal: moneyMinorUnitsSchema,
  shipping: moneyMinorUnitsSchema,
  /**
   * Feature A (promo codes) — see BUILD-DECISIONS.md §11 for the record of
   * this deliberate change to a previously-locked contract. Integer minor
   * units, defaults to 0 so every pre-existing order/test that never knew
   * about discounts still validates unchanged. This is the *applied*
   * discount amount (e.g. a fixed-value code's face value, or a percent
   * code's computed share of `subtotal`) — it is not itself clamped to
   * `subtotal + shipping`; only `total` is clamped, below.
   */
  discount: moneyMinorUnitsSchema.default(0),
  /** The code that produced `discount`, if any. Absent for a discount-free order. */
  promoCode: promoCodeStringSchema.optional(),
  total: moneyMinorUnitsSchema,
  address: addressSchema,
  deliveryMethod: deliveryMethodSchema,
  paymentMethod: paymentMethodSchema,
  status: orderStatusSchema,
  createdAt: z.date(),
};

/**
 * An order whose totals do not add up is a corrupt order. Checking the
 * arithmetic in the schema means a miscalculation in the checkout flow fails
 * loudly at the write boundary instead of being persisted and discovered by
 * a customer.
 *
 * Widened for Feature A (promo codes) — was `total === subtotal + shipping`.
 * Now `total === max(0, subtotal + shipping - discount)`: a discount larger
 * than `subtotal + shipping` caps `total` at 0 rather than going negative or
 * implying a refund. `discount` defaults to 0, so this is exactly the old
 * invariant for every order that carries no discount.
 */
type OrderTotals = {
  items: readonly { price: number; quantity: number }[];
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
};

export function computeOrderTotal(
  subtotal: number,
  shipping: number,
  discount: number
): number {
  return Math.max(0, subtotal + shipping - discount);
}

function totalsAreConsistent(order: OrderTotals): boolean {
  return (
    order.subtotal === cartSubtotal(order.items) &&
    order.total === computeOrderTotal(order.subtotal, order.shipping, order.discount)
  );
}

const totalsRefinement: { message: string; path: PropertyKey[] } = {
  message:
    "Order totals must add up: subtotal = sum(price x quantity), total = max(0, subtotal + shipping - discount)",
  path: ["total"],
};

export const orderSchema = z
  .object(orderShape)
  .refine(totalsAreConsistent, totalsRefinement);
export type Order = z.infer<typeof orderSchema>;

/**
 * Shape for creating an order — the server assigns `_id` and `createdAt`,
 * matching how `productInputSchema` and `cartInputSchema` treat timestamps.
 *
 * Built from the raw shape rather than `orderSchema.omit()` so the totals
 * refinement is re-applied to the narrowed object explicitly, instead of
 * depending on whether `.omit()` carries checks across a given Zod version.
 */
const { _id: _omittedId, createdAt: _omittedCreatedAt, ...orderInputShape } =
  orderShape;

export const orderInputSchema = z
  .object(orderInputShape)
  .refine(totalsAreConsistent, totalsRefinement);
export type OrderInput = z.infer<typeof orderInputSchema>;
