import type { Document, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import { checkoutStateSchema, type CheckoutState } from "@/lib/schemas/checkout";
import type { Address, DeliveryMethod } from "@/lib/schemas";
import { getReadyDb, isDuplicateKeyError } from "./shared";

/**
 * Feature 7/8's own repository — a NEW collection (`checkoutStates`), not a
 * modification of the locked `carts`/`orders` repositories. See
 * `schemas/checkout.ts` and BUILD-DECISIONS.md §11.13.
 *
 * Follows the same serialization convention as every other repository
 * (§11.11): `_id` round-trips as a string, `Date`s become ISO strings, nothing
 * is returned unvalidated.
 */
export type CheckoutStateDTO = Omit<CheckoutState, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

const COLLECTION = "checkoutStates";

function mapDoc(doc: WithId<Document>): CheckoutStateDTO {
  const { _id, ...rest } = doc;
  const parsed = checkoutStateSchema.parse({ _id: _id.toString(), ...rest });
  const { createdAt, updatedAt, ...restParsed } = parsed;
  return {
    ...restParsed,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

export async function getCheckoutState(cartId: string): Promise<CheckoutStateDTO | null> {
  const db = await getReadyDb();
  const doc = await db.collection(COLLECTION).findOne({ cartId });
  return doc ? mapDoc(doc) : null;
}

async function upsertCheckoutState(
  cartId: string,
  set: Partial<{ address: Address; deliveryMethod: DeliveryMethod }>
): Promise<CheckoutStateDTO> {
  const db = await getReadyDb();
  const collection = db.collection(COLLECTION);
  const now = new Date();

  try {
    const result = await collection.findOneAndUpdate(
      { cartId },
      {
        $set: { ...set, updatedAt: now },
        $setOnInsert: { _id: new ObjectId(), cartId, orderClaimed: false, createdAt: now },
      },
      { upsert: true, returnDocument: "after" }
    );
    if (!result) throw new Error(`Failed to upsert checkout state for cart "${cartId}"`);
    return mapDoc(result);
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Lost a race with a concurrent upsert for the same cartId — the
      // document now exists, so retry as a plain update.
      const result = await collection.findOneAndUpdate(
        { cartId },
        { $set: { ...set, updatedAt: new Date() } },
        { returnDocument: "after" }
      );
      if (!result) throw new Error(`Failed to update checkout state for cart "${cartId}"`);
      return mapDoc(result);
    }
    throw error;
  }
}

export async function saveCheckoutAddress(cartId: string, address: Address): Promise<CheckoutStateDTO> {
  return upsertCheckoutState(cartId, { address });
}

export async function saveCheckoutDeliveryMethod(
  cartId: string,
  deliveryMethod: DeliveryMethod
): Promise<CheckoutStateDTO> {
  return upsertCheckoutState(cartId, { deliveryMethod });
}

/**
 * Atomically claims this cart's checkout for order placement — the
 * double-submit guard. Returns `true` the first time (order creation should
 * proceed), `false` if this cart's checkout was already claimed (a
 * concurrent submit got there first — the caller must NOT create a second
 * order). Uses `findOneAndUpdate`'s filter as the compare-and-set: only one
 * concurrent caller can match `orderClaimed: { $ne: true }`.
 */
export async function claimCheckoutForOrder(cartId: string): Promise<boolean> {
  const db = await getReadyDb();
  const result = await db.collection(COLLECTION).findOneAndUpdate(
    { cartId, orderClaimed: { $ne: true } },
    { $set: { orderClaimed: true, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  return result !== null;
}

/** Deletes the checkout state entirely — called once an order has been placed and the cart cleared. */
export async function clearCheckoutState(cartId: string): Promise<void> {
  const db = await getReadyDb();
  await db.collection(COLLECTION).deleteOne({ cartId });
}
