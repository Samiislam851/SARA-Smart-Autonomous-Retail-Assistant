import type { Document, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import {
  cartSubtotal,
  computeOrderTotal,
  orderInputSchema,
  orderSchema,
  type Address,
  type CartItem,
  type DeliveryMethod,
  type Order,
  type PaymentMethod,
} from "@/lib/schemas";
import { getReadyDb, isDuplicateKeyError } from "./shared";

export type OrderDTO = Omit<Order, "createdAt"> & { createdAt: string };

function toOrderDTO(order: Order): OrderDTO {
  const { createdAt, ...rest } = order;
  return { ...rest, createdAt: createdAt.toISOString() };
}

function mapOrderDoc(doc: WithId<Document>): OrderDTO {
  const { _id, ...rest } = doc;
  const order = orderSchema.parse({ _id: _id.toString(), ...rest });
  return toOrderDTO(order);
}

export interface CreateOrderInput {
  /** Absent for guest checkout. */
  userId?: string;
  items: CartItem[];
  currency: string;
  /** Integer minor units. `subtotal`/`total` are computed here, never accepted from the caller. */
  shipping: number;
  address: Address;
  deliveryMethod: DeliveryMethod;
  /** Defaults to "cod" — the only value the schema accepts (§6: Cash on Delivery only). */
  paymentMethod?: PaymentMethod;
  /**
   * Feature A (promo codes). Integer minor units, already computed by the
   * caller (`placeOrderAction`) from a freshly re-validated promo code —
   * this function does not itself look up or validate a promo code, it only
   * applies the number it's given to the totals arithmetic. Defaults to 0.
   */
  discount?: number;
  /** The code that produced `discount`, if any. Omit for a discount-free order. */
  promoCode?: string;
}

function generateOrderNumber(attempt: number): string {
  const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();
  const suffix = attempt > 0 ? `-${attempt}` : "";
  return `RK-${datePart}-${randomPart}${suffix}`;
}

const MAX_ORDER_NUMBER_ATTEMPTS = 5;

/**
 * Generates a unique `orderNumber`, validates the full document through
 * `orderInputSchema` (which re-checks `subtotal === Σ(price × quantity)`
 * and `total === subtotal + shipping` even though this function is what
 * computed those numbers — defense in depth at the write boundary), and
 * inserts. `subtotal`/`total` are always derived from `items` via
 * `cartSubtotal()` — never taken from the caller, per §HARD REQUIREMENTS.
 *
 * `orders.orderNumber` has a unique index (`lib/db/indexes.ts`); on the rare
 * collision this retries with a fresh random suffix rather than failing the
 * checkout.
 */
export async function createOrder(input: CreateOrderInput): Promise<OrderDTO> {
  const db = await getReadyDb();
  const collection = db.collection("orders");

  const subtotal = cartSubtotal(input.items);
  const discount = input.discount ?? 0;
  const total = computeOrderTotal(subtotal, input.shipping, discount);
  const now = new Date();

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ORDER_NUMBER_ATTEMPTS; attempt++) {
    const candidate = {
      orderNumber: generateOrderNumber(attempt),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      items: input.items,
      currency: input.currency,
      subtotal,
      shipping: input.shipping,
      discount,
      ...(input.promoCode !== undefined ? { promoCode: input.promoCode } : {}),
      total,
      address: input.address,
      deliveryMethod: input.deliveryMethod,
      paymentMethod: input.paymentMethod ?? "cod",
      status: "placed" as const,
    };
    const validatedInput = orderInputSchema.parse(candidate);
    const _id = new ObjectId();
    const validatedOrder = orderSchema.parse({
      _id: _id.toString(),
      ...validatedInput,
      createdAt: now,
    });

    try {
      await collection.insertOne({ ...validatedOrder, _id });
      return toOrderDTO(validatedOrder);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw new Error(
    `Failed to generate a unique order number after ${MAX_ORDER_NUMBER_ATTEMPTS} attempts`,
    { cause: lastError }
  );
}

export async function getOrderByNumber(orderNumber: string): Promise<OrderDTO | null> {
  const db = await getReadyDb();
  const doc = await db.collection("orders").findOne({ orderNumber });
  return doc ? mapOrderDoc(doc) : null;
}
