// @vitest-environment node
import { ObjectId } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { cartSubtotal, type Address, type CartItem } from "@/lib/schemas";
import { createOrder, getOrderByNumber, type CreateOrderInput } from "./orders";
import { assertJsonSafe } from "./test-helpers";

const createdOrderIds: string[] = [];

afterAll(async () => {
  if (createdOrderIds.length === 0) return;
  const db = await getDb();
  await db
    .collection("orders")
    .deleteMany({ _id: { $in: createdOrderIds.map((id) => new ObjectId(id)) } });
});

const address: Address = {
  fullName: "Ada Lovelace",
  line1: "1 Analytical Engine Way",
  city: "London",
  state: "London",
  postalCode: "SW1A 1AA",
  country: "UK",
  phone: "+44 20 7946 0958",
};

function makeItem(overrides: Partial<CartItem> = {}): CartItem {
  return {
    productId: new ObjectId().toString(),
    slug: "repo-test-order-item",
    title: "Repo Test Order Item",
    price: 2500,
    quantity: 2,
    variantSelection: {},
    imagePath: "/products/seed/footwear/running-shoe-x1-1.webp",
    ...overrides,
  };
}

async function makeOrder(overrides: Partial<CreateOrderInput> = {}) {
  const order = await createOrder({
    items: [makeItem()],
    currency: "USD",
    shipping: 500,
    address,
    deliveryMethod: "standard",
    ...overrides,
  });
  createdOrderIds.push(order._id);
  return order;
}

describe("createOrder", () => {
  it("computes subtotal and total from the items (never trusting a client-supplied total)", async () => {
    const items = [makeItem({ price: 1000, quantity: 3 }), makeItem({ price: 750, quantity: 1 })];
    const order = await makeOrder({ items, shipping: 400 });

    expect(order.subtotal).toBe(cartSubtotal(items));
    expect(order.subtotal).toBe(1000 * 3 + 750 * 1);
    expect(order.total).toBe(order.subtotal + 400);
  });

  it("generates an orderNumber matching the expected shape", async () => {
    const order = await makeOrder();
    expect(order.orderNumber).toMatch(/^RK-\d{8}-[A-Z0-9]{6}(-\d+)?$/);
  });

  it("generates unique order numbers across many concurrent orders", async () => {
    const orders = await Promise.all(Array.from({ length: 20 }, () => makeOrder()));
    const orderNumbers = new Set(orders.map((o) => o.orderNumber));
    expect(orderNumbers.size).toBe(orders.length);
  });

  it("defaults status to 'placed' and paymentMethod to 'cod'", async () => {
    const order = await makeOrder();
    expect(order.status).toBe("placed");
    expect(order.paymentMethod).toBe("cod");
  });

  it("supports guest checkout (no userId)", async () => {
    const order = await makeOrder();
    expect(order.userId).toBeUndefined();
  });

  it("stores userId for a signed-in checkout", async () => {
    const userId = new ObjectId().toString();
    const order = await makeOrder({ userId });
    expect(order.userId).toBe(userId);
  });

  it("never leaks an ObjectId or Date instance", async () => {
    const order = await makeOrder();
    assertJsonSafe(order);
    expect(typeof order.createdAt).toBe("string");
    expect(typeof order._id).toBe("string");
  });
});

describe("getOrderByNumber", () => {
  it("fetches a created order by its orderNumber", async () => {
    const created = await makeOrder();
    const found = await getOrderByNumber(created.orderNumber);
    expect(found?._id).toBe(created._id);
    expect(found?.subtotal).toBe(created.subtotal);
  });

  it("returns null for a nonexistent orderNumber", async () => {
    const found = await getOrderByNumber("RK-00000000-ZZZZZZ");
    expect(found).toBeNull();
  });
});
