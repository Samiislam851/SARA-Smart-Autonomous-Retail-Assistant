import { describe, expect, it } from "vitest";
import {
  groupVariants,
  productInputSchema,
  productSchema,
  productVariantSchema,
} from "./product";

const valid = {
  _id: "507f1f77bcf86cd799439011",
  slug: "running-shoe-x1",
  title: "Running Shoe X1",
  brand: "Rok",
  description: "A fast running shoe.",
  categorySlug: "footwear",
  price: 7999,
  currency: "USD",
  images: ["/products/seed/footwear/running-shoe-x1-1.webp"],
  rating: 4.5,
  reviewCount: 120,
  stock: 42,
  isActive: true,
  variants: [
    { type: "size", label: "Medium", value: "M", available: true },
    { type: "colour", label: "Midnight Blue", value: "midnight-blue", available: false },
  ],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
};

describe("productSchema", () => {
  it("accepts a valid product with variants embedded on the document", () => {
    const result = productSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.variants).toHaveLength(2);
    }
  });

  it("rejects a float price (money must be integer minor units)", () => {
    const result = productSchema.safeParse({ ...valid, price: 79.99 });
    expect(result.success).toBe(false);
  });

  it("rejects a negative price", () => {
    const result = productSchema.safeParse({ ...valid, price: -100 });
    expect(result.success).toBe(false);
  });

  it("rejects an empty images array", () => {
    const result = productSchema.safeParse({ ...valid, images: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a variant with an invalid type", () => {
    const result = productSchema.safeParse({
      ...valid,
      variants: [{ type: "material", label: "Cotton", value: "cotton", available: true }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a currency code that is not 3 uppercase letters", () => {
    const result = productSchema.safeParse({ ...valid, currency: "usd" });
    expect(result.success).toBe(false);
  });

  it.each([
    ["Infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["a float that looks like dollars", 79.99],
    ["a float with a trailing fraction", 7999.0001],
  ])("rejects %s as a price", (_label, price) => {
    expect(productSchema.safeParse({ ...valid, price }).success).toBe(false);
  });

  it("accepts an integer-valued float (1999.0 is an integer)", () => {
    // Guards against an over-eager fix that starts rejecting 1999.0, which
    // JavaScript cannot distinguish from 1999.
    expect(productSchema.safeParse({ ...valid, price: 1999.0 }).success).toBe(
      true
    );
  });

  it.each([
    ["a Windows filesystem path", "D:\\hackathon\\NextCart\\public\\a.webp"],
    ["a POSIX filesystem path", "/var/www/public/products/seed/a.webp"],
    ["a traversal escape", "/products/uploads/../../../etc/passwd.webp"],
    ["an absolute URL", "https://evil.example.com/a.webp"],
    ["a protocol-relative URL", "//evil.example.com/a.webp"],
    ["a path outside /products/", "/uploads/a.webp"],
    ["a non-image extension", "/products/uploads/payload.svg"],
    ["an executable extension", "/products/uploads/payload.html"],
  ])("rejects %s in images (BUILD-DECISIONS §8)", (_label, path) => {
    expect(productSchema.safeParse({ ...valid, images: [path] }).success).toBe(
      false
    );
  });

  it.each([
    "/products/seed/footwear/running-shoe-x1-1.webp",
    "/products/uploads/ab12cd.webp",
    "/products/seed/a.jpeg",
  ])("accepts the sanctioned web path %s", (path) => {
    expect(productSchema.safeParse({ ...valid, images: [path] }).success).toBe(
      true
    );
  });

  it("rejects duplicate (type, value) variant pairs", () => {
    const result = productSchema.safeParse({
      ...valid,
      variants: [
        { type: "size", label: "Medium", value: "M", available: true },
        { type: "size", label: "Med.", value: "M", available: false },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("allows the same value under different variant types", () => {
    const result = productSchema.safeParse({
      ...valid,
      variants: [
        { type: "size", label: "Large", value: "l", available: true },
        { type: "colour", label: "Lilac", value: "l", available: true },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("defaults an omitted variants array to empty (products need not have variants)", () => {
    const { variants: _variants, ...rest } = valid;
    const result = productSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.variants).toEqual([]);
  });

  it("rejects a rating above 5", () => {
    expect(productSchema.safeParse({ ...valid, rating: 5.1 }).success).toBe(
      false
    );
  });

  it("rejects a non-slug categorySlug", () => {
    expect(
      productSchema.safeParse({ ...valid, categorySlug: "Foot Wear" }).success
    ).toBe(false);
  });
});

describe("productInputSchema", () => {
  it("omits _id and timestamps so the admin form can submit it directly", () => {
    const { _id: _omitId, createdAt: _c, updatedAt: _u, ...input } = valid;
    const result = productInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("_id");
      expect(result.data).not.toHaveProperty("createdAt");
    }
  });

  it("still enforces integer minor units", () => {
    const { _id: _omitId, createdAt: _c, updatedAt: _u, ...input } = valid;
    expect(
      productInputSchema.safeParse({ ...input, price: 79.99 }).success
    ).toBe(false);
  });
});

describe("groupVariants", () => {
  it("groups a flat variants array by type for the PDP controls", () => {
    const grouped = groupVariants(valid.variants as never);
    expect(grouped.size).toHaveLength(1);
    expect(grouped.colour).toHaveLength(1);
    expect(grouped.size?.[0].value).toBe("M");
  });

  it("omits a type the product has no variants for", () => {
    const grouped = groupVariants([
      { type: "size", label: "Small", value: "S", available: true },
    ]);
    expect(grouped.colour).toBeUndefined();
  });
});

describe("productVariantSchema", () => {
  it("accepts a size variant", () => {
    const result = productVariantSchema.safeParse({
      type: "size",
      label: "Large",
      value: "L",
      available: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a variant missing `available`", () => {
    const result = productVariantSchema.safeParse({
      type: "colour",
      label: "Red",
      value: "red",
    });
    expect(result.success).toBe(false);
  });
});
