import type { Collection, Document, WithId } from "mongodb";
import { ObjectId } from "mongodb";
import {
  DEFAULT_CURRENCY,
  MAX_LINE_QUANTITY,
  cartItemSchema,
  cartSchema,
  cartSubtotal,
  promoCodeStringSchema,
  quantitySchema,
  type Cart,
  type CartItem,
  type VariantSelection,
} from "@/lib/schemas";
import { getReadyDb, isDuplicateKeyError } from "./shared";

export type CartDTO = Omit<Cart, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
};

/**
 * Cart totals are never persisted on the document (the schema deliberately
 * has no `subtotal`/`total` field on `Cart` — only `cartSubtotal()` computes
 * one, from `items`). Every function here recomputes it fresh, from the
 * `items` that were just read or written, so a caller can never see a stale
 * or client-supplied total.
 */
export type CartWithTotals = CartDTO & { subtotal: number };

function toCartWithTotals(doc: WithId<Document>): CartWithTotals {
  const { _id, ...rest } = doc;
  const cart = cartSchema.parse({ _id: _id.toString(), ...rest });
  const { createdAt, updatedAt, ...cartRest } = cart;
  return {
    ...cartRest,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    subtotal: cartSubtotal(cart.items),
  };
}

/**
 * Line identity is `(productId, variantSelection)`, not just `productId`:
 * the same product in size M and size L are two distinct lines (§ variant-
 * aware line identity). `variantSelection` has no fixed key order and no
 * `_id` of its own, so equality is a plain key/value comparison, not a
 * reference or JSON-string compare (which would be sensitive to key order).
 */
function variantSelectionsEqual(a: VariantSelection, b: VariantSelection): boolean {
  const aKeys = Object.keys(a) as (keyof VariantSelection)[];
  const bKeys = Object.keys(b) as (keyof VariantSelection)[];
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

function findLineIndex(
  items: readonly CartItem[],
  productId: string,
  variantSelection: VariantSelection
): number {
  return items.findIndex(
    (line) =>
      line.productId === productId &&
      variantSelectionsEqual(line.variantSelection, variantSelection)
  );
}

async function findOrCreateRawCart(
  collection: Collection<Document>,
  cartId: string
): Promise<WithId<Document>> {
  const existing = await collection.findOne({ cartId });
  if (existing) return existing;

  const now = new Date();
  const doc = {
    _id: new ObjectId(),
    cartId,
    currency: DEFAULT_CURRENCY,
    items: [] as CartItem[],
    createdAt: now,
    updatedAt: now,
  };
  try {
    await collection.insertOne(doc);
    return doc;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      // Lost a race with a concurrent request creating the same cartId.
      const raced = await collection.findOne({ cartId });
      if (raced) return raced;
    }
    throw error;
  }
}

export async function getOrCreateCart(cartId: string): Promise<CartWithTotals> {
  const db = await getReadyDb();
  const doc = await findOrCreateRawCart(db.collection("carts"), cartId);
  return toCartWithTotals(doc);
}

export interface AddCartItemInput {
  productId: string;
  slug: string;
  title: string;
  price: number;
  imagePath: string;
  /** Defaults to 1. */
  quantity?: number;
  /** Defaults to {} (no variant selected). */
  variantSelection?: VariantSelection;
}

/**
 * Adds a line, or increments an existing one. The classic bug this guards
 * against: appending a second line for the same product because the
 * variant selection wasn't compared, or wasn't compared correctly. Adding
 * the same product with the *same* variant selection increments quantity in
 * place; a *different* selection (including no selection vs. a selection)
 * is a distinct line.
 *
 * The incoming `price`/`title`/`imagePath` are only used for a brand-new
 * line. An existing line keeps its original snapshot — incrementing
 * quantity must never silently change what price the shopper already
 * agreed to for the units already in the cart.
 */
export async function addCartItem(
  cartId: string,
  item: AddCartItemInput
): Promise<CartWithTotals> {
  const normalized = cartItemSchema.parse({
    productId: item.productId,
    slug: item.slug,
    title: item.title,
    price: item.price,
    imagePath: item.imagePath,
    quantity: item.quantity ?? 1,
    variantSelection: item.variantSelection ?? {},
  });

  const db = await getReadyDb();
  const collection = db.collection("carts");
  const rawCart = await findOrCreateRawCart(collection, cartId);
  const existingCart = cartSchema.parse({
    ...rawCart,
    _id: rawCart._id.toString(),
  });

  const items = [...existingCart.items];
  const idx = findLineIndex(items, normalized.productId, normalized.variantSelection);
  if (idx >= 0) {
    const existingLine = items[idx];
    items[idx] = {
      ...existingLine,
      quantity: Math.min(MAX_LINE_QUANTITY, existingLine.quantity + normalized.quantity),
    };
  } else {
    items.push(normalized);
  }

  const result = await collection.findOneAndUpdate(
    { cartId },
    { $set: { items, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) throw new Error(`Cart "${cartId}" not found`);
  return toCartWithTotals(result);
}

/** Sets a line's quantity outright (1..99, schema-enforced). Returns null if the cart or the line doesn't exist. */
export async function updateCartItemQuantity(
  cartId: string,
  productId: string,
  variantSelection: VariantSelection,
  quantity: number
): Promise<CartWithTotals | null> {
  const parsedQuantity = quantitySchema.parse(quantity);

  const db = await getReadyDb();
  const collection = db.collection("carts");
  const rawCart = await collection.findOne({ cartId });
  if (!rawCart) return null;
  const cart = cartSchema.parse({ ...rawCart, _id: rawCart._id.toString() });

  const items = [...cart.items];
  const idx = findLineIndex(items, productId, variantSelection);
  if (idx === -1) return null;
  items[idx] = { ...items[idx], quantity: parsedQuantity };

  const result = await collection.findOneAndUpdate(
    { cartId },
    { $set: { items, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  return result ? toCartWithTotals(result) : null;
}

/** Removes one line. Returns null if the cart doesn't exist; removing an absent line is a no-op that still returns the (unchanged) cart. */
export async function removeCartItem(
  cartId: string,
  productId: string,
  variantSelection: VariantSelection
): Promise<CartWithTotals | null> {
  const db = await getReadyDb();
  const collection = db.collection("carts");
  const rawCart = await collection.findOne({ cartId });
  if (!rawCart) return null;
  const cart = cartSchema.parse({ ...rawCart, _id: rawCart._id.toString() });

  const items = cart.items.filter(
    (line) => !(line.productId === productId && variantSelectionsEqual(line.variantSelection, variantSelection))
  );

  const result = await collection.findOneAndUpdate(
    { cartId },
    { $set: { items, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  return result ? toCartWithTotals(result) : null;
}

/**
 * Empties the cart (called once, right after a successful order placement —
 * see `placeOrderAction`). Also clears any applied `promoCode`: it was
 * either just spent on the order that was placed, or dropped as invalid
 * immediately before placement — either way, a promo code has no business
 * silently surviving onto the shopper's NEXT, unrelated shopping session.
 */
export async function clearCart(cartId: string): Promise<CartWithTotals | null> {
  const db = await getReadyDb();
  const result = await db.collection("carts").findOneAndUpdate(
    { cartId },
    { $set: { items: [], updatedAt: new Date() }, $unset: { promoCode: "" } },
    { returnDocument: "after" }
  );
  return result ? toCartWithTotals(result) : null;
}

/**
 * Stores an applied promo code on the cart (Feature A). Only the code
 * string is persisted — never a discount amount, never the promo document
 * itself. `code` is normalized to uppercase before it's validated/stored,
 * matching how `promoCodes.code` is stored (`repositories/promoCodes.ts`).
 * Whether the code is actually valid (active, not expired, `minSubtotal`
 * met, etc.) is NOT this function's job — it just records what the shopper
 * asked to apply. Validation happens on every read, via
 * `src/lib/promo/validate.ts`, so a code that stops qualifying between
 * being applied and being read is never silently honoured.
 */
export async function setCartPromoCode(cartId: string, code: string): Promise<CartWithTotals | null> {
  const normalized = promoCodeStringSchema.parse(code.toUpperCase());
  const db = await getReadyDb();
  const result = await db.collection("carts").findOneAndUpdate(
    { cartId },
    { $set: { promoCode: normalized, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  return result ? toCartWithTotals(result) : null;
}

/** Removes any applied promo code from the cart. A no-op (not an error) if none was applied. */
export async function removeCartPromoCode(cartId: string): Promise<CartWithTotals | null> {
  const db = await getReadyDb();
  const result = await db.collection("carts").findOneAndUpdate(
    { cartId },
    { $unset: { promoCode: "" }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  return result ? toCartWithTotals(result) : null;
}
