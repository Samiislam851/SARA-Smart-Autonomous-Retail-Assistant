// @vitest-environment node
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { MAX_LINE_QUANTITY, cartSubtotal } from "@/lib/schemas";
import {
  addCartItem,
  clearCart,
  getOrCreateCart,
  removeCartItem,
  updateCartItemQuantity,
} from "./carts";
import { TEST_PREFIX, assertJsonSafe } from "./test-helpers";

const usedCartIds: string[] = [];
function testCartId(): string {
  const id = `${TEST_PREFIX}cart-${randomUUID()}`;
  usedCartIds.push(id);
  return id;
}

afterAll(async () => {
  const db = await getDb();
  await db.collection("carts").deleteMany({ cartId: { $in: usedCartIds } });
});

const PRODUCT_A = new ObjectId().toString();
const PRODUCT_B = new ObjectId().toString();

function itemInput(overrides: Partial<Parameters<typeof addCartItem>[1]> = {}) {
  return {
    productId: PRODUCT_A,
    slug: "repo-test-cart-product-a",
    title: "Repo Test Cart Product A",
    price: 2500,
    imagePath: "/products/seed/footwear/running-shoe-x1-1.webp",
    ...overrides,
  };
}

describe("getOrCreateCart", () => {
  it("creates an empty cart on first call", async () => {
    const cartId = testCartId();
    const cart = await getOrCreateCart(cartId);
    expect(cart.cartId).toBe(cartId);
    expect(cart.items).toEqual([]);
    expect(cart.subtotal).toBe(0);
    expect(cart.currency).toBe("USD");
  });

  it("returns the same cart on a second call (idempotent)", async () => {
    const cartId = testCartId();
    const first = await getOrCreateCart(cartId);
    const second = await getOrCreateCart(cartId);
    expect(second._id).toBe(first._id);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("never leaks an ObjectId or Date instance", async () => {
    const cart = await getOrCreateCart(testCartId());
    assertJsonSafe(cart);
  });
});

describe("addCartItem — variant-aware line identity", () => {
  it("adding the same product with the same (empty) variant selection increments quantity, not a new line", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 2 }));
    const cart = await addCartItem(cartId, itemInput({ quantity: 3 }));

    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(5);
  });

  it("adding the same product with the same non-empty variant selection increments quantity", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 1, variantSelection: { size: "M" } }));
    const cart = await addCartItem(cartId, itemInput({ quantity: 1, variantSelection: { size: "M" } }));

    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(2);
  });

  it("adding the same product with a DIFFERENT variant selection creates a new line", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 1, variantSelection: { size: "M" } }));
    const cart = await addCartItem(cartId, itemInput({ quantity: 1, variantSelection: { size: "L" } }));

    expect(cart.items).toHaveLength(2);
    const sizes = cart.items.map((i) => i.variantSelection.size).sort();
    expect(sizes).toEqual(["L", "M"]);
  });

  it("no variant selection vs. a variant selection are distinct lines", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 1 }));
    const cart = await addCartItem(cartId, itemInput({ quantity: 1, variantSelection: { size: "M" } }));
    expect(cart.items).toHaveLength(2);
  });

  it("a different product always creates a new line, regardless of variant selection", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 1 }));
    const cart = await addCartItem(cartId, itemInput({ productId: PRODUCT_B, quantity: 1 }));
    expect(cart.items).toHaveLength(2);
  });

  it("caps the incremented quantity at MAX_LINE_QUANTITY (99)", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 60 }));
    const cart = await addCartItem(cartId, itemInput({ quantity: 60 }));
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(MAX_LINE_QUANTITY);
  });

  it("keeps the original line's price snapshot when incrementing (does not overwrite with a later add's price)", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 1, price: 1000 }));
    const cart = await addCartItem(cartId, itemInput({ quantity: 1, price: 9999 }));
    expect(cart.items[0].price).toBe(1000);
  });

  it("recomputes subtotal from cartSubtotal() on every mutation", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 2, price: 1000 }));
    const cart = await addCartItem(cartId, itemInput({ productId: PRODUCT_B, quantity: 3, price: 500 }));
    expect(cart.subtotal).toBe(cartSubtotal(cart.items));
    expect(cart.subtotal).toBe(2 * 1000 + 3 * 500);
  });
});

describe("updateCartItemQuantity", () => {
  it("sets a line's quantity", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 1 }));
    const cart = await updateCartItemQuantity(cartId, PRODUCT_A, {}, 7);
    expect(cart?.items[0].quantity).toBe(7);
  });

  it("rejects a quantity above the 99 cap", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 1 }));
    await expect(updateCartItemQuantity(cartId, PRODUCT_A, {}, 100)).rejects.toThrow();
  });

  it("rejects a zero/negative quantity", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 1 }));
    await expect(updateCartItemQuantity(cartId, PRODUCT_A, {}, 0)).rejects.toThrow();
  });

  it("returns null for a line that doesn't exist on an existing cart", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 1 }));
    const result = await updateCartItemQuantity(cartId, PRODUCT_B, {}, 5);
    expect(result).toBeNull();
  });

  it("returns null for a nonexistent cart", async () => {
    const result = await updateCartItemQuantity(testCartId(), PRODUCT_A, {}, 5);
    expect(result).toBeNull();
  });
});

describe("removeCartItem", () => {
  it("removes one line, leaving the others", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 1 }));
    await addCartItem(cartId, itemInput({ productId: PRODUCT_B, quantity: 1 }));
    const cart = await removeCartItem(cartId, PRODUCT_A, {});
    expect(cart?.items).toHaveLength(1);
    expect(cart?.items[0].productId).toBe(PRODUCT_B);
  });

  it("only removes the matching variant line, not every line for that product", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 1, variantSelection: { size: "M" } }));
    await addCartItem(cartId, itemInput({ quantity: 1, variantSelection: { size: "L" } }));
    const cart = await removeCartItem(cartId, PRODUCT_A, { size: "M" });
    expect(cart?.items).toHaveLength(1);
    expect(cart?.items[0].variantSelection.size).toBe("L");
  });

  it("returns null for a nonexistent cart", async () => {
    const result = await removeCartItem(testCartId(), PRODUCT_A, {});
    expect(result).toBeNull();
  });
});

describe("clearCart", () => {
  it("empties all items and resets subtotal to 0", async () => {
    const cartId = testCartId();
    await addCartItem(cartId, itemInput({ quantity: 2 }));
    const cart = await clearCart(cartId);
    expect(cart?.items).toEqual([]);
    expect(cart?.subtotal).toBe(0);
  });

  it("returns null for a nonexistent cart", async () => {
    const result = await clearCart(testCartId());
    expect(result).toBeNull();
  });
});
