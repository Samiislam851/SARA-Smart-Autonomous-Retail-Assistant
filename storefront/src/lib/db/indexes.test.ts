// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { closeMongoClient, getDb } from "./client";
import { ensureIndexes } from "./indexes";

/**
 * Requires a running `docker compose up -d` (see client.test.ts's DEAD_URI
 * tests for the hermetic half of this file's coverage — this half
 * deliberately exercises the real MongoDB idempotency guarantee that a
 * mocked/dead connection cannot).
 */

afterAll(async () => {
  await closeMongoClient();
});

describe("ensureIndexes", () => {
  it("is safe to call twice in a row and leaves the expected index set", async () => {
    const db = await getDb();

    await ensureIndexes(db);
    await ensureIndexes(db); // idempotency: must not throw, must not duplicate

    const productIndexes = await db.collection("products").indexes();
    const productIndexNames = productIndexes.map((i) => i.name).sort();
    expect(productIndexNames).toEqual(
      [
        "_id_",
        "products_categorySlug_isActive",
        "products_slug_unique",
        "products_text_search",
      ].sort()
    );

    const slugIndex = productIndexes.find((i) => i.name === "products_slug_unique");
    expect(slugIndex?.unique).toBe(true);

    const textIndex = productIndexes.find((i) => i.name === "products_text_search");
    expect(textIndex?.weights).toEqual({ title: 10, brand: 5, description: 1 });

    const categoryIndexNames = (await db.collection("categories").indexes())
      .map((i) => i.name)
      .sort();
    expect(categoryIndexNames).toEqual(["_id_", "categories_slug_unique"].sort());

    const cartIndexNames = (await db.collection("carts").indexes()).map((i) => i.name).sort();
    expect(cartIndexNames).toEqual(["_id_", "carts_cartId_unique"].sort());

    const orderIndexNames = (await db.collection("orders").indexes()).map((i) => i.name).sort();
    expect(orderIndexNames).toEqual(["_id_", "orders_orderNumber_unique"].sort());

    const userIndexNames = (await db.collection("users").indexes()).map((i) => i.name).sort();
    expect(userIndexNames).toEqual(["_id_", "users_email_unique"].sort());
  }, 20000);
});
