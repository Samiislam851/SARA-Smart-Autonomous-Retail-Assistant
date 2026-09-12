// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import type { Address } from "@/lib/schemas";
import {
  claimCheckoutForOrder,
  clearCheckoutState,
  getCheckoutState,
  saveCheckoutAddress,
  saveCheckoutDeliveryMethod,
} from "./checkoutState";
import { TEST_PREFIX, assertJsonSafe } from "./test-helpers";

const usedCartIds: string[] = [];
function testCartId(): string {
  const id = `${TEST_PREFIX}checkout-${randomUUID()}`;
  usedCartIds.push(id);
  return id;
}

afterAll(async () => {
  const db = await getDb();
  await db.collection("checkoutStates").deleteMany({ cartId: { $in: usedCartIds } });
});

const ADDRESS: Address = {
  fullName: "Repo Test User",
  line1: "1 Repo Test Way",
  city: "Testville",
  state: "TS",
  postalCode: "00000",
  country: "Testland",
  phone: "+1 555 0100",
};

describe("getCheckoutState", () => {
  it("returns null for a cart with no checkout state yet", async () => {
    const state = await getCheckoutState(testCartId());
    expect(state).toBeNull();
  });
});

describe("saveCheckoutAddress / saveCheckoutDeliveryMethod", () => {
  it("upserts on first write and never leaks an ObjectId or Date", async () => {
    const cartId = testCartId();
    const state = await saveCheckoutAddress(cartId, ADDRESS);
    assertJsonSafe(state);
    expect(state.cartId).toBe(cartId);
    expect(state.address).toEqual(ADDRESS);
    expect(state.deliveryMethod).toBeUndefined();
    expect(state.orderClaimed).toBe(false);
  });

  it("saving the delivery method after the address keeps the address", async () => {
    const cartId = testCartId();
    await saveCheckoutAddress(cartId, ADDRESS);
    const withDelivery = await saveCheckoutDeliveryMethod(cartId, "express");

    expect(withDelivery.address).toEqual(ADDRESS);
    expect(withDelivery.deliveryMethod).toBe("express");
  });

  it("a later save of the same field overwrites, not duplicates, the document", async () => {
    const cartId = testCartId();
    await saveCheckoutAddress(cartId, ADDRESS);
    const updated = await saveCheckoutAddress(cartId, { ...ADDRESS, city: "New City" });

    expect(updated.address?.city).toBe("New City");
    const fetched = await getCheckoutState(cartId);
    expect(fetched?.address?.city).toBe("New City");
  });
});

describe("claimCheckoutForOrder", () => {
  it("returns true on the first claim and false on every subsequent claim for the same cart", async () => {
    const cartId = testCartId();
    await saveCheckoutAddress(cartId, ADDRESS);

    const first = await claimCheckoutForOrder(cartId);
    const second = await claimCheckoutForOrder(cartId);
    const third = await claimCheckoutForOrder(cartId);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(third).toBe(false);
  });

  it("returns false for a cart with no checkout state document at all", async () => {
    const claimed = await claimCheckoutForOrder(testCartId());
    expect(claimed).toBe(false);
  });
});

describe("clearCheckoutState", () => {
  it("deletes the document — a subsequent read returns null", async () => {
    const cartId = testCartId();
    await saveCheckoutAddress(cartId, ADDRESS);
    await clearCheckoutState(cartId);

    expect(await getCheckoutState(cartId)).toBeNull();
  });

  it("is a no-op (does not throw) for a cart with no checkout state", async () => {
    await expect(clearCheckoutState(testCartId())).resolves.toBeUndefined();
  });
});
