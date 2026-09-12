import { describe, expect, it } from "vitest";
import { categorySchema } from "./category";

const valid = {
  _id: "507f1f77bcf86cd799439011",
  slug: "electronics",
  name: "Electronics",
  description: "Phones, laptops and more.",
  imagePath: "/products/seed/categories/electronics.webp",
  sortOrder: 1,
};

describe("categorySchema", () => {
  it("accepts a valid category", () => {
    const result = categorySchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("defaults an omitted description to an empty string", () => {
    const { description: _description, ...rest } = valid;
    const result = categorySchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("");
    }
  });

  it("rejects a non-slug value for slug", () => {
    const result = categorySchema.safeParse({ ...valid, slug: "Not A Slug!" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed _id", () => {
    const result = categorySchema.safeParse({ ...valid, _id: "not-an-object-id" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer sortOrder", () => {
    const result = categorySchema.safeParse({ ...valid, sortOrder: 1.5 });
    expect(result.success).toBe(false);
  });

  it.each([
    ["a Windows filesystem path", "D:\\hackathon\\NextCart\\public\\a.webp"],
    ["an absolute URL", "https://example.com/a.webp"],
    ["a traversal escape", "/products/seed/../../secret.webp"],
    ["a path outside /products/", "/images/electronics.webp"],
  ])("rejects %s as imagePath (BUILD-DECISIONS §8)", (_label, imagePath) => {
    expect(categorySchema.safeParse({ ...valid, imagePath }).success).toBe(
      false
    );
  });

  it("rejects a negative sortOrder", () => {
    expect(categorySchema.safeParse({ ...valid, sortOrder: -1 }).success).toBe(
      false
    );
  });

  it("rejects a missing name", () => {
    const { name: _name, ...rest } = valid;
    const result = categorySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});
