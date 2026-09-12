import { describe, expect, it } from "vitest";
import { categorySchema, imagePathSchema, productSchema, userSchema } from "@/lib/schemas";
import { CATEGORY_TEMPLATES } from "./data/categories";
import { generateCategories, generateProducts, generateUsers, slugify, titleCase, titleFingerprint } from "./generate";

describe("generateCategories", () => {
  it("produces exactly 10 categories, every one schema-valid", () => {
    const categories = generateCategories();
    expect(categories).toHaveLength(10);
    for (const category of categories) {
      expect(categorySchema.safeParse(category).success).toBe(true);
    }
  });

  it("has 10 unique slugs matching BUILD-DECISIONS' suggested category set size", () => {
    const slugs = generateCategories().map((c) => c.slug);
    expect(new Set(slugs).size).toBe(10);
  });

  it("is deterministic across repeated calls", () => {
    expect(generateCategories()).toEqual(generateCategories());
  });
});

describe("generateProducts", () => {
  const categories = generateCategories();
  const products = generateProducts(categories);

  it("produces exactly 300 products, 30 per category", () => {
    expect(products).toHaveLength(300);
    const counts = new Map<string, number>();
    for (const p of products) {
      counts.set(p.categorySlug, (counts.get(p.categorySlug) ?? 0) + 1);
    }
    expect(counts.size).toBe(10);
    for (const [, count] of counts) {
      expect(count).toBe(30);
    }
  });

  it("every product validates against productSchema", () => {
    for (const product of products) {
      const result = productSchema.safeParse(product);
      expect(result.success).toBe(true);
    }
  });

  it("has unique slugs across all 300 products", () => {
    const slugs = products.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("is deterministic: generating twice from the same categories yields identical output", () => {
    const again = generateProducts(categories);
    expect(again).toEqual(products);
  });

  it("keeps every price an integer within that category's per-line bounds", () => {
    for (const template of CATEGORY_TEMPLATES) {
      const catProducts = products.filter((p) => p.categorySlug === template.slug);
      const min = Math.min(...template.productLines.map((l) => l.priceRange[0]));
      const max = Math.max(...template.productLines.map((l) => l.priceRange[1]));
      for (const p of catProducts) {
        expect(Number.isInteger(p.price)).toBe(true);
        expect(p.price).toBeGreaterThanOrEqual(min);
        expect(p.price).toBeLessThanOrEqual(max);
      }
    }
  });

  it("gives every product exactly 3 distinct image paths that satisfy imagePathSchema", () => {
    for (const p of products) {
      expect(p.images).toHaveLength(3);
      expect(new Set(p.images).size).toBe(3);
      for (const img of p.images) {
        expect(imagePathSchema.safeParse(img).success).toBe(true);
        expect(img).toMatch(new RegExp(`^/products/seed/${p.slug}-[123]\\.webp$`));
      }
    }
  });

  it("books never carry variants", () => {
    const books = products.filter((p) => p.categorySlug === "books");
    expect(books).toHaveLength(30);
    for (const book of books) {
      expect(book.variants).toEqual([]);
    }
  });

  it("grocery never carries variants", () => {
    const grocery = products.filter((p) => p.categorySlug === "grocery");
    for (const item of grocery) {
      expect(item.variants).toEqual([]);
    }
  });

  it("every clothing-shoes product has BOTH a size and a colour variant group", () => {
    const clothing = products.filter((p) => p.categorySlug === "clothing-shoes");
    expect(clothing).toHaveLength(30);
    for (const item of clothing) {
      const types = new Set(item.variants.map((v) => v.type));
      expect(types.has("size")).toBe(true);
      expect(types.has("colour")).toBe(true);
    }
  });

  it("footwear lines (runner/boot/sneaker) get numeric US sizes, never S/M/L/XL", () => {
    const footwear = products.filter(
      (p) =>
        p.categorySlug === "clothing-shoes" &&
        /runner|boot|sneaker/i.test(p.title)
    );
    expect(footwear.length).toBeGreaterThan(0);
    for (const item of footwear) {
      const sizeValues = item.variants.filter((v) => v.type === "size").map((v) => v.value);
      expect(sizeValues.length).toBeGreaterThan(0);
      for (const value of sizeValues) {
        expect(value).toMatch(/^us-\d+$/);
      }
    }
  });

  it("non-footwear clothing lines keep the S/M/L/XL apparel scale", () => {
    const apparel = products.filter(
      (p) =>
        p.categorySlug === "clothing-shoes" &&
        !/runner|boot|sneaker/i.test(p.title)
    );
    expect(apparel.length).toBeGreaterThan(0);
    for (const item of apparel) {
      const sizeValues = item.variants.filter((v) => v.type === "size").map((v) => v.value);
      expect(sizeValues).toEqual(["S", "M", "L", "XL"]);
    }
  });

  it("electronics/computers products have only 'colour' variants or none — never 'size'", () => {
    const scoped = products.filter(
      (p) => p.categorySlug === "electronics" || p.categorySlug === "computers-accessories"
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const item of scoped) {
      for (const v of item.variants) {
        expect(v.type).toBe("colour");
      }
    }
    // And the category as a whole actually exercises both branches of the policy.
    expect(scoped.some((p) => p.variants.length === 0)).toBe(true);
    expect(scoped.some((p) => p.variants.length > 0)).toBe(true);
  });

  it("keeps (type, value) unique within each product's variants array", () => {
    for (const p of products) {
      const keys = p.variants.map((v) => `${v.type}:${v.value}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("ratings stay within 3.2-4.9 and reviewCount is a non-negative integer", () => {
    for (const p of products) {
      expect(p.rating).toBeGreaterThanOrEqual(3.2);
      expect(p.rating).toBeLessThanOrEqual(4.9);
      expect(Number.isInteger(p.reviewCount)).toBe(true);
      expect(p.reviewCount).toBeGreaterThanOrEqual(0);
    }
  });

  it("includes at least a few out-of-stock and a few low-stock products", () => {
    expect(products.some((p) => p.stock === 0)).toBe(true);
    expect(products.some((p) => p.stock > 0 && p.stock <= 5)).toBe(true);
  });

  it("titles read as real product names, not placeholder text", () => {
    for (const p of products) {
      expect(p.title.toLowerCase()).not.toContain("lorem");
      expect(p.title).not.toMatch(/^Product \d+$/);
      expect(p.title.length).toBeGreaterThan(3);
    }
  });

  it("never doubles a word back-to-back in a title (e.g. an adjective overlapping its noun)", () => {
    for (const p of products) {
      expect(p.title).not.toMatch(/\b(\w+)\s+\1\b/i);
    }
  });

  it("has no near-duplicate titles: every title's bag-of-words fingerprint is unique", () => {
    // Catches what exact-string/slug uniqueness misses, e.g. two book titles
    // that are the same words in a different order ("Moonlight and Dust" vs
    // "Dust and Moonlight") — a shopper sees those as the same title.
    const fingerprints = products.map((p) => titleFingerprint(p.title));
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it("agrees the verb for plural-noun lines (earbuds, leggings, coffee beans, ...)", () => {
    // Description fragments are authored in the singular ("The {brand}
    // {noun} is built..."); plural lines must swap the verb, or you get "The
    // Wavecrest wireless earbuds *is* built..." — the single most visible
    // "this was generated" tell on a PDP. `noun` is interpolated lowercase
    // and unchanged by title-casing, so the last word of each plural noun is
    // a reliable substring to check directly against the composed sentence.
    const pluralNounEndings = ["earbuds", "headphones", "leggings", "pants", "beans", "bags", "towels", "mats"];
    const brokenVerbs = ["is", "pairs", "brings", "balances", "fits", "turns", "handles"];
    const matched = products.filter((p) => pluralNounEndings.some((ending) => p.title.toLowerCase().includes(ending)));
    expect(matched.length).toBeGreaterThan(0);
    for (const p of matched) {
      for (const ending of pluralNounEndings) {
        if (!p.title.toLowerCase().includes(ending)) continue;
        for (const verb of brokenVerbs) {
          expect(p.description.toLowerCase()).not.toContain(`${ending} ${verb} `);
        }
      }
    }
  });
});

describe("generateUsers", () => {
  const users = generateUsers();

  it("produces at least one admin and every user validates", () => {
    expect(users.length).toBeGreaterThan(0);
    expect(users.some((u) => u.role === "admin")).toBe(true);
    for (const u of users) {
      expect(userSchema.safeParse(u).success).toBe(true);
    }
  });

  it("has unique emails", () => {
    const emails = users.map((u) => u.email);
    expect(new Set(emails).size).toBe(emails.length);
  });

  it("is deterministic across repeated calls", () => {
    expect(generateUsers()).toEqual(generateUsers());
  });
});

describe("slugify / titleCase", () => {
  it("slugify strips punctuation and produces a valid slug shape", () => {
    expect(slugify(`Tom & Jerry's "Deluxe" Edition`)).toBe("tom-jerry-s-deluxe-edition");
    expect(slugify("Aurora Runner Mid")).toBe("aurora-runner-mid");
  });

  it("titleCase capitalizes each word, including hyphenated compounds", () => {
    expect(titleCase("usb-c charging cable")).toBe("Usb-C Charging Cable");
  });
});
