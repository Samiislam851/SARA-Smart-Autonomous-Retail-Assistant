// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getCategoryBySlug, listCategories } from "./categories";
import { assertJsonSafe } from "./test-helpers";

/**
 * Read-only against the real seeded catalog (10 categories) — nothing here
 * writes, so there is nothing to clean up.
 */
describe("listCategories", () => {
  it("returns all seeded categories", async () => {
    const categories = await listCategories();
    expect(categories.length).toBeGreaterThanOrEqual(10);
  });

  it("is sorted by sortOrder ascending", async () => {
    const categories = await listCategories();
    const sortOrders = categories.map((c) => c.sortOrder);
    const sorted = [...sortOrders].sort((a, b) => a - b);
    expect(sortOrders).toEqual(sorted);
  });

  it("never leaks an ObjectId or Date instance", async () => {
    const categories = await listCategories();
    assertJsonSafe(categories);
  });
});

describe("getCategoryBySlug", () => {
  it("returns a seeded category by slug", async () => {
    const [first] = await listCategories();
    const found = await getCategoryBySlug(first.slug);
    expect(found?.slug).toBe(first.slug);
    expect(found?._id).toBe(first._id);
  });

  it("returns null for a nonexistent slug", async () => {
    const found = await getCategoryBySlug("this-category-does-not-exist-zzz");
    expect(found).toBeNull();
  });
});
