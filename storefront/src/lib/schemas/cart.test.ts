import { describe, expect, it } from "vitest";
import { cartInputSchema, cartSchema, cartSubtotal, lineTotal } from "./cart";

const validItem = {
  productId: "507f1f77bcf86cd799439012",
  slug: "running-shoe-x1",
  title: "Running Shoe X1",
  price: 7999,
  quantity: 2,
  variantSelection: { size: "M", colour: "midnight-blue" },
  imagePath: "/products/seed/footwear/running-shoe-x1-1.webp",
};

const valid = {
  _id: "507f1f77bcf86cd799439011",
  cartId: "cart-abc123",
  currency: "USD",
  items: [validItem],
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("cartSchema", () => {
  it("accepts a valid cart", () => {
    const result = cartSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts an empty cart (no items yet)", () => {
    const result = cartSchema.safeParse({ ...valid, items: [] });
    expect(result.success).toBe(true);
  });

  it("defaults currency so a freshly created cart needs no currency field", () => {
    const { currency: _currency, ...rest } = valid;
    const result = cartSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.currency).toBe("USD");
  });

  it("rejects a lowercase currency code", () => {
    expect(cartSchema.safeParse({ ...valid, currency: "usd" }).success).toBe(
      false
    );
  });

  it("rejects a zero quantity", () => {
    const result = cartSchema.safeParse({
      ...valid,
      items: [{ ...validItem, quantity: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["above the per-line cap", 100],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("rejects a %s quantity", (_label, quantity) => {
    const result = cartSchema.safeParse({
      ...valid,
      items: [{ ...validItem, quantity }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts the maximum allowed quantity", () => {
    const result = cartSchema.safeParse({
      ...valid,
      items: [{ ...validItem, quantity: 99 }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a float item price (money must be integer minor units)", () => {
    const result = cartSchema.safeParse({
      ...valid,
      items: [{ ...validItem, price: 79.99 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown variant type in the selection", () => {
    const result = cartSchema.safeParse({
      ...valid,
      items: [{ ...validItem, variantSelection: { material: "cotton" } }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty-string variant value", () => {
    const result = cartSchema.safeParse({
      ...valid,
      items: [{ ...validItem, variantSelection: { size: "" } }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts a partial selection (product has sizes but no colours)", () => {
    const result = cartSchema.safeParse({
      ...valid,
      items: [{ ...validItem, variantSelection: { size: "M" } }],
    });
    expect(result.success).toBe(true);
  });

  it("defaults an omitted variantSelection to an empty object", () => {
    const { variantSelection: _sel, ...itemWithoutSelection } = validItem;
    const result = cartSchema.safeParse({
      ...valid,
      items: [itemWithoutSelection],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items[0].variantSelection).toEqual({});
    }
  });

  it("rejects a filesystem imagePath", () => {
    const result = cartSchema.safeParse({
      ...valid,
      items: [{ ...validItem, imagePath: "D:\\hackathon\\a.webp" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing cartId", () => {
    const { cartId: _cartId, ...rest } = valid;
    const result = cartSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });
});

describe("cartInputSchema", () => {
  it("omits _id and timestamps", () => {
    const { _id: _omitId, createdAt: _c, updatedAt: _u, ...input } = valid;
    const result = cartInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty("_id");
  });
});

describe("cart totals", () => {
  it("multiplies price by quantity in integer minor units", () => {
    expect(lineTotal({ price: 7999, quantity: 3 })).toBe(23997);
  });

  it("sums every line", () => {
    expect(
      cartSubtotal([
        { price: 7999, quantity: 2 },
        { price: 500, quantity: 1 },
      ])
    ).toBe(16498);
  });

  it("returns 0 for an empty cart", () => {
    expect(cartSubtotal([])).toBe(0);
  });

  it("stays an exact integer where float maths would drift", () => {
    // 0.1 + 0.2 !== 0.3 in floats; 10 + 20 === 30 in minor units, always.
    expect(
      cartSubtotal([
        { price: 10, quantity: 1 },
        { price: 20, quantity: 1 },
      ])
    ).toBe(30);
    expect(Number.isInteger(cartSubtotal([{ price: 333, quantity: 3 }]))).toBe(
      true
    );
  });
});
