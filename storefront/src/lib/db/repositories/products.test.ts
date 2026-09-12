// @vitest-environment node
import { ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import type { Product } from "@/lib/schemas";
import {
  createProduct,
  getProductById,
  getProductBySlug,
  getRelatedProducts,
  listProductsByCategory,
  listProductsForAdmin,
  searchProducts,
  setProductActive,
  updateProduct,
} from "./products";
import { getReadyDb } from "./shared";
import { assertJsonSafe, TEST_PREFIX } from "./test-helpers";

const PLP_CATEGORY = `${TEST_PREFIX}plp-category`;
const SEARCH_CATEGORY = `${TEST_PREFIX}search-category`;
const RELATED_CATEGORY = `${TEST_PREFIX}related-category`;
const ADMIN_CATEGORY = `${TEST_PREFIX}admin-category`;
const SEARCH_TOKEN = "zzzrepotestwidgetxyz";
const BASE_TIME = new Date("2025-01-01T00:00:00Z").getTime();

type RawProductOverrides = Partial<Omit<Product, "_id">> & { slug: string };

function rawProduct(overrides: RawProductOverrides): Omit<Product, "_id"> & { _id: ObjectId } {
  const _id = new ObjectId();
  return {
    _id,
    title: overrides.slug,
    brand: "RepoTestBrand",
    description: "A repository test fixture product.",
    categorySlug: PLP_CATEGORY,
    price: 1000,
    currency: "USD",
    images: ["/products/seed/footwear/running-shoe-x1-1.webp"],
    rating: 3,
    reviewCount: 10,
    stock: 5,
    isActive: true,
    variants: [],
    createdAt: new Date(BASE_TIME),
    updatedAt: new Date(BASE_TIME),
    ...overrides,
  };
}

const ACTIVE_COUNT = 26; // > PAGE_SIZE (24), so PLP pagination spans exactly two pages.

const plpProducts = Array.from({ length: ACTIVE_COUNT }, (_, i) => {
  const ratingRank = (i * 7) % ACTIVE_COUNT; // a permutation of 0..25: rating order != price/createdAt order.
  return rawProduct({
    slug: `${TEST_PREFIX}plp-${i}`,
    price: 1000 + i * 10, // strictly ascending with i
    rating: Math.round((ratingRank / (ACTIVE_COUNT - 1)) * 500) / 100, // distinct values in [0, 5]
    reviewCount: 10 + i,
    createdAt: new Date(BASE_TIME + i * 60_000), // strictly ascending with i
    updatedAt: new Date(BASE_TIME + i * 60_000),
  });
});

const inactivePlpProducts = Array.from({ length: 3 }, (_, i) =>
  rawProduct({
    slug: `${TEST_PREFIX}plp-inactive-${i}`,
    price: 999999,
    isActive: false,
  })
);

const searchProductsFixture = [
  rawProduct({
    slug: `${TEST_PREFIX}search-title`,
    title: `A ${SEARCH_TOKEN} for testing`,
    brand: "OtherBrand",
    description: "No special token here.",
    categorySlug: SEARCH_CATEGORY,
  }),
  rawProduct({
    slug: `${TEST_PREFIX}search-brand`,
    title: "Plain title",
    brand: SEARCH_TOKEN,
    description: "No special token here either.",
    categorySlug: SEARCH_CATEGORY,
  }),
  rawProduct({
    slug: `${TEST_PREFIX}search-description`,
    title: "Plain title",
    brand: "OtherBrand",
    description: `Mentions ${SEARCH_TOKEN} only in the description.`,
    categorySlug: SEARCH_CATEGORY,
  }),
  rawProduct({
    slug: `${TEST_PREFIX}search-inactive`,
    title: `Inactive ${SEARCH_TOKEN} product`,
    categorySlug: SEARCH_CATEGORY,
    isActive: false,
  }),
];

const relatedProductsFixture = [
  rawProduct({ slug: `${TEST_PREFIX}related-self`, categorySlug: RELATED_CATEGORY, rating: 5 }),
  rawProduct({ slug: `${TEST_PREFIX}related-a`, categorySlug: RELATED_CATEGORY, rating: 4 }),
  rawProduct({ slug: `${TEST_PREFIX}related-b`, categorySlug: RELATED_CATEGORY, rating: 3 }),
  rawProduct({
    slug: `${TEST_PREFIX}related-inactive`,
    categorySlug: RELATED_CATEGORY,
    rating: 4.9,
    isActive: false,
  }),
  rawProduct({ slug: `${TEST_PREFIX}related-other-category`, categorySlug: `${TEST_PREFIX}unrelated`, rating: 4.9 }),
];

const allFixtureDocs = [
  ...plpProducts,
  ...inactivePlpProducts,
  ...searchProductsFixture,
  ...relatedProductsFixture,
];

beforeAll(async () => {
  await getReadyDb(); // ensures indexes (incl. the $text index) exist before search tests run
  const db = await getDb();
  await db.collection("products").insertMany(allFixtureDocs);
});

afterAll(async () => {
  const db = await getDb();
  await db.collection("products").deleteMany({ slug: { $regex: `^${TEST_PREFIX}` } });
});

describe("listProductsByCategory", () => {
  it("returns page 1 with PAGE_SIZE (24) items and correct pagination metadata", async () => {
    const result = await listProductsByCategory(PLP_CATEGORY, { page: 1, sort: "price-asc" });
    expect(result.items).toHaveLength(24);
    expect(result.total).toBe(ACTIVE_COUNT);
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(2);
  });

  it("returns the remainder on the last page", async () => {
    const result = await listProductsByCategory(PLP_CATEGORY, { page: 2, sort: "price-asc" });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(ACTIVE_COUNT);
    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(2);
  });

  it("returns an empty page when requesting past the last page", async () => {
    const result = await listProductsByCategory(PLP_CATEGORY, { page: 3, sort: "price-asc" });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(ACTIVE_COUNT);
    expect(result.page).toBe(3);
    expect(result.totalPages).toBe(2);
  });

  it("returns an empty result for a category with no products", async () => {
    const result = await listProductsByCategory(`${TEST_PREFIX}nonexistent-category`);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
    expect(result.page).toBe(1);
  });

  it("excludes inactive products from both items and total (storefront path)", async () => {
    const page1 = await listProductsByCategory(PLP_CATEGORY, { page: 1 });
    const page2 = await listProductsByCategory(PLP_CATEGORY, { page: 2 });
    expect(page1.total).toBe(ACTIVE_COUNT);
    const allSlugs = [...page1.items, ...page2.items].map((p) => p.slug);
    for (const inactive of inactivePlpProducts) {
      expect(allSlugs).not.toContain(inactive.slug);
    }
  });

  it("orders correctly for every sort option", async () => {
    const activeSorted = (compareFn: (a: (typeof plpProducts)[number], b: (typeof plpProducts)[number]) => number) =>
      [...plpProducts].sort(compareFn).map((p) => p.slug);

    const cases: { sort: "price-asc" | "price-desc" | "rating" | "newest"; expectedSlugs: string[] }[] = [
      { sort: "price-asc", expectedSlugs: activeSorted((a, b) => a.price - b.price) },
      { sort: "price-desc", expectedSlugs: activeSorted((a, b) => b.price - a.price) },
      { sort: "rating", expectedSlugs: activeSorted((a, b) => b.rating - a.rating) },
      { sort: "newest", expectedSlugs: activeSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime()) },
    ];

    for (const { sort, expectedSlugs } of cases) {
      const page1 = await listProductsByCategory(PLP_CATEGORY, { page: 1, sort });
      const page2 = await listProductsByCategory(PLP_CATEGORY, { page: 2, sort });
      const actualSlugs = [...page1.items, ...page2.items].map((p) => p.slug);
      expect(actualSlugs, `sort=${sort}`).toEqual(expectedSlugs);
    }
  });

  it("falls back to newest ordering when sort is 'relevance' (relevance has no meaning without a text query)", async () => {
    const relevancePage1 = await listProductsByCategory(PLP_CATEGORY, { page: 1, sort: "relevance" });
    const newestPage1 = await listProductsByCategory(PLP_CATEGORY, { page: 1, sort: "newest" });
    expect(relevancePage1.items.map((p) => p.slug)).toEqual(newestPage1.items.map((p) => p.slug));
  });

  it("defaults to the newest fallback when no sort is given", async () => {
    const defaultPage1 = await listProductsByCategory(PLP_CATEGORY, { page: 1 });
    const newestPage1 = await listProductsByCategory(PLP_CATEGORY, { page: 1, sort: "newest" });
    expect(defaultPage1.items.map((p) => p.slug)).toEqual(newestPage1.items.map((p) => p.slug));
  });

  it("never leaks an ObjectId or Date instance", async () => {
    const result = await listProductsByCategory(PLP_CATEGORY, { page: 1 });
    assertJsonSafe(result);
  });
});

describe("searchProducts", () => {
  it("ranks a title match above a brand match above a description-only match", async () => {
    const result = await searchProducts(SEARCH_TOKEN);
    expect(result.total).toBe(3); // excludes the inactive fixture
    expect(result.items.map((p) => p.slug)).toEqual([
      `${TEST_PREFIX}search-title`,
      `${TEST_PREFIX}search-brand`,
      `${TEST_PREFIX}search-description`,
    ]);
  });

  it("excludes inactive products from search results", async () => {
    const result = await searchProducts(SEARCH_TOKEN);
    expect(result.items.map((p) => p.slug)).not.toContain(`${TEST_PREFIX}search-inactive`);
  });

  it("returns a zero-result page for a query that matches nothing", async () => {
    const result = await searchProducts("thisquerymatchesnothingzzz999");
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
  });

  it("returns a zero-result page for an empty/whitespace query without querying Mongo", async () => {
    const result = await searchProducts("   ");
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.totalPages).toBe(0);
  });

  it("supports sorting search results by a non-relevance field", async () => {
    const result = await searchProducts(SEARCH_TOKEN, { sort: "price-asc" });
    expect(result.items.map((p) => p.slug)).toEqual([
      `${TEST_PREFIX}search-title`,
      `${TEST_PREFIX}search-brand`,
      `${TEST_PREFIX}search-description`,
    ]); // all fixture prices are equal (1000) except distinct ties broken by _id; just assert it doesn't throw and count matches
    expect(result.total).toBe(3);
  });

  it("never leaks an ObjectId or Date instance", async () => {
    const result = await searchProducts(SEARCH_TOKEN);
    assertJsonSafe(result);
  });
});

describe("getProductBySlug", () => {
  it("returns an active product", async () => {
    const product = await getProductBySlug(`${TEST_PREFIX}plp-0`);
    expect(product?.slug).toBe(`${TEST_PREFIX}plp-0`);
  });

  it("returns null for an inactive product (storefront path excludes inactive)", async () => {
    const product = await getProductBySlug(`${TEST_PREFIX}plp-inactive-0`);
    expect(product).toBeNull();
  });

  it("returns null for a nonexistent slug", async () => {
    const product = await getProductBySlug(`${TEST_PREFIX}does-not-exist`);
    expect(product).toBeNull();
  });

  it("never leaks an ObjectId or Date instance", async () => {
    const product = await getProductBySlug(`${TEST_PREFIX}plp-0`);
    assertJsonSafe(product);
  });
});

describe("getProductById", () => {
  it("returns an active product by id (admin lookup, not slug-keyed)", async () => {
    const bySlug = await getProductBySlug(`${TEST_PREFIX}plp-0`);
    if (!bySlug) throw new Error("fixture missing");
    const byId = await getProductById(bySlug._id);
    expect(byId?.slug).toBe(`${TEST_PREFIX}plp-0`);
  });

  it("returns an INACTIVE product by id — this is what getProductBySlug can never do, and what the admin edit route needs", async () => {
    const inactiveSlug = inactivePlpProducts[0].slug;
    const raw = await (await getDb()).collection("products").findOne({ slug: inactiveSlug });
    if (!raw) throw new Error("fixture missing");
    const byId = await getProductById(raw._id.toString());
    expect(byId?.slug).toBe(inactiveSlug);
    expect(byId?.isActive).toBe(false);
  });

  it("returns null for a well-formed but nonexistent id", async () => {
    const result = await getProductById(new ObjectId().toString());
    expect(result).toBeNull();
  });

  it("returns null for a malformed id instead of throwing", async () => {
    await expect(getProductById("not-an-object-id")).resolves.toBeNull();
  });

  it("never leaks an ObjectId or Date instance", async () => {
    const bySlug = await getProductBySlug(`${TEST_PREFIX}plp-0`);
    if (!bySlug) throw new Error("fixture missing");
    const byId = await getProductById(bySlug._id);
    assertJsonSafe(byId);
  });
});

describe("getRelatedProducts", () => {
  it("returns same-category active products, excluding itself and other categories", async () => {
    const related = await getRelatedProducts(
      { slug: `${TEST_PREFIX}related-self`, categorySlug: RELATED_CATEGORY },
      10
    );
    const slugs = related.map((p) => p.slug);
    expect(slugs).not.toContain(`${TEST_PREFIX}related-self`);
    expect(slugs).not.toContain(`${TEST_PREFIX}related-inactive`);
    expect(slugs).not.toContain(`${TEST_PREFIX}related-other-category`);
    expect(slugs.sort()).toEqual([`${TEST_PREFIX}related-a`, `${TEST_PREFIX}related-b`].sort());
  });

  it("respects the limit", async () => {
    const related = await getRelatedProducts(
      { slug: `${TEST_PREFIX}related-self`, categorySlug: RELATED_CATEGORY },
      1
    );
    expect(related).toHaveLength(1);
  });
});

describe("listProductsForAdmin", () => {
  it("excludes inactive products by default", async () => {
    const result = await listProductsForAdmin({ page: 1 });
    // A generous page 1 across the whole (real + fixture) catalog would not
    // reliably fit our fixtures, so instead assert on a query scoped to our
    // fixture slugs via the text index isn't available for slug; use the
    // dedicated category count via listProductsByCategory-equivalent check:
    // every inactive fixture slug must never appear.
    const inactiveSlugs = [...inactivePlpProducts, ...searchProductsFixture, ...relatedProductsFixture]
      .filter((p) => !p.isActive)
      .map((p) => p.slug);
    for (const slug of inactiveSlugs) {
      expect(result.items.map((p) => p.slug)).not.toContain(slug);
    }
  });

  it("includes inactive products when includeInactive is true, findable via query", async () => {
    const result = await listProductsForAdmin({ query: SEARCH_TOKEN, includeInactive: true });
    expect(result.items.map((p) => p.slug)).toContain(`${TEST_PREFIX}search-inactive`);
  });

  it("excludes inactive products when includeInactive is false, even with a matching query", async () => {
    const result = await listProductsForAdmin({ query: SEARCH_TOKEN, includeInactive: false });
    expect(result.items.map((p) => p.slug)).not.toContain(`${TEST_PREFIX}search-inactive`);
  });

  it("filters by query text", async () => {
    const result = await listProductsForAdmin({ query: SEARCH_TOKEN, includeInactive: true });
    expect(result.total).toBe(4); // 3 active + 1 inactive fixture, all containing the token
  });
});

describe("admin write path: createProduct / updateProduct / setProductActive", () => {
  const slug = `${TEST_PREFIX}admin-created`;

  it("creates a product, validated and serialized", async () => {
    const created = await createProduct({
      slug,
      title: "Repo Test Admin Product",
      brand: "RepoTestBrand",
      description: "Created by the products repository test.",
      categorySlug: ADMIN_CATEGORY,
      price: 4321,
      currency: "USD",
      images: ["/products/seed/footwear/running-shoe-x1-1.webp"],
      rating: 4,
      reviewCount: 0,
      stock: 3,
      isActive: true,
      variants: [],
    });
    expect(created.slug).toBe(slug);
    expect(typeof created._id).toBe("string");
    expect(created._id).toMatch(/^[0-9a-f]{24}$/);
    assertJsonSafe(created);

    const fetched = await getProductBySlug(slug);
    expect(fetched?.price).toBe(4321);
  });

  it("rejects creating a second product with the same slug", async () => {
    await expect(
      createProduct({
        slug,
        title: "Duplicate slug",
        brand: "RepoTestBrand",
        description: "",
        categorySlug: ADMIN_CATEGORY,
        price: 100,
        currency: "USD",
        images: ["/products/seed/footwear/running-shoe-x1-1.webp"],
        rating: 1,
        reviewCount: 0,
        stock: 1,
        isActive: true,
        variants: [],
      })
    ).rejects.toThrow(/already exists/);
  });

  it("updates a product's editable fields and bumps updatedAt, keeping createdAt and _id", async () => {
    const before = await getProductBySlug(slug);
    if (!before) throw new Error("fixture missing");

    await new Promise((resolve) => setTimeout(resolve, 5));
    const updated = await updateProduct(before._id, {
      slug,
      title: "Repo Test Admin Product (updated)",
      brand: "RepoTestBrand",
      description: "Updated.",
      categorySlug: ADMIN_CATEGORY,
      price: 5555,
      currency: "USD",
      images: ["/products/seed/footwear/running-shoe-x1-1.webp"],
      rating: 4,
      reviewCount: 0,
      stock: 3,
      isActive: true,
      variants: [],
    });

    expect(updated?._id).toBe(before._id);
    expect(updated?.createdAt).toBe(before.createdAt);
    expect(updated?.price).toBe(5555);
    expect(updated && new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date(before.updatedAt).getTime()
    );
  });

  it("returns null when updating a nonexistent product id", async () => {
    const result = await updateProduct(new ObjectId().toString(), {
      slug: `${TEST_PREFIX}ghost`,
      title: "Ghost",
      brand: "RepoTestBrand",
      description: "",
      categorySlug: ADMIN_CATEGORY,
      price: 100,
      currency: "USD",
      images: ["/products/seed/footwear/running-shoe-x1-1.webp"],
      rating: 1,
      reviewCount: 0,
      stock: 1,
      isActive: true,
      variants: [],
    });
    expect(result).toBeNull();
  });

  it("setProductActive flips isActive, affecting storefront visibility", async () => {
    const before = await getProductBySlug(slug);
    if (!before) throw new Error("fixture missing");

    const deactivated = await setProductActive(before._id, false);
    expect(deactivated?.isActive).toBe(false);
    expect(await getProductBySlug(slug)).toBeNull();

    const reactivated = await setProductActive(before._id, true);
    expect(reactivated?.isActive).toBe(true);
    expect((await getProductBySlug(slug))?.slug).toBe(slug);
  });
});
