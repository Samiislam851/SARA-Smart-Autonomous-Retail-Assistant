import { describe, expect, it } from "vitest";
import { addressSchema, orderInputSchema, orderSchema } from "./order";

const item = {
  productId: "507f1f77bcf86cd799439012",
  slug: "running-shoe-x1",
  title: "Running Shoe X1",
  price: 7999,
  quantity: 1,
  variantSelection: { size: "M" },
  imagePath: "/products/seed/footwear/running-shoe-x1-1.webp",
};

const validAddress = {
  fullName: "Ada Lovelace",
  line1: "1 Analytical Engine Way",
  city: "London",
  state: "London",
  postalCode: "SW1A 1AA",
  country: "UK",
  phone: "+44 20 7946 0958",
};

const valid = {
  _id: "507f1f77bcf86cd799439011",
  orderNumber: "RK-20260101-0001",
  items: [item],
  currency: "USD",
  subtotal: 7999,
  shipping: 500,
  total: 8499,
  address: validAddress,
  deliveryMethod: "standard",
  paymentMethod: "cod",
  status: "placed",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("orderSchema", () => {
  it("accepts a valid COD order", () => {
    const result = orderSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts an order without a userId (guest checkout)", () => {
    const { userId: _userId, ...guest } = { ...valid, userId: undefined };
    expect(orderSchema.safeParse(guest).success).toBe(true);
  });

  it("accepts an order with a userId (signed-in checkout)", () => {
    const result = orderSchema.safeParse({
      ...valid,
      userId: "507f1f77bcf86cd799439099",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-cod payment method", () => {
    const result = orderSchema.safeParse({ ...valid, paymentMethod: "card" });
    expect(result.success).toBe(false);
  });

  it("rejects an order with no items", () => {
    const result = orderSchema.safeParse({ ...valid, items: [] });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const result = orderSchema.safeParse({ ...valid, status: "teleporting" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown delivery method", () => {
    const result = orderSchema.safeParse({
      ...valid,
      deliveryMethod: "teleport",
    });
    expect(result.success).toBe(false);
  });

  it("requires a delivery method (checkout step 2 must record the choice)", () => {
    const { deliveryMethod: _dm, ...rest } = valid;
    expect(orderSchema.safeParse(rest).success).toBe(false);
  });

  it("requires a currency (a stored order must render correctly forever)", () => {
    const { currency: _currency, ...rest } = valid;
    expect(orderSchema.safeParse(rest).success).toBe(false);
  });

  describe("totals arithmetic", () => {
    it("rejects a total that is not subtotal + shipping", () => {
      const result = orderSchema.safeParse({ ...valid, total: 9999 });
      expect(result.success).toBe(false);
    });

    it("rejects a subtotal that does not match the line items", () => {
      const result = orderSchema.safeParse({
        ...valid,
        subtotal: 1,
        total: 501,
      });
      expect(result.success).toBe(false);
    });

    it("recomputes across multiple lines and quantities", () => {
      const result = orderSchema.safeParse({
        ...valid,
        items: [
          { ...item, quantity: 3 },
          { ...item, productId: "507f1f77bcf86cd799439013", price: 500, quantity: 2 },
        ],
        subtotal: 7999 * 3 + 500 * 2,
        shipping: 0,
        total: 7999 * 3 + 500 * 2,
      });
      expect(result.success).toBe(true);
    });

    it("accepts free shipping (shipping = 0)", () => {
      const result = orderSchema.safeParse({
        ...valid,
        shipping: 0,
        total: 7999,
      });
      expect(result.success).toBe(true);
    });

    it("reports the failure on the `total` path so a form can show it", () => {
      const result = orderSchema.safeParse({ ...valid, total: 1 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path.includes("total"))).toBe(
          true
        );
      }
    });

    it("rejects float money even when the arithmetic is self-consistent", () => {
      const result = orderSchema.safeParse({
        ...valid,
        items: [{ ...item, price: 79.99 }],
        subtotal: 79.99,
        shipping: 5.0,
        total: 84.99,
      });
      expect(result.success).toBe(false);
    });
  });

  it("rejects an address missing a required field", () => {
    const { phone: _phone, ...addressWithoutPhone } = valid.address;
    const result = orderSchema.safeParse({
      ...valid,
      address: addressWithoutPhone,
    });
    expect(result.success).toBe(false);
  });
});

describe("addressSchema", () => {
  it("accepts an address without the optional line2", () => {
    expect(addressSchema.safeParse(validAddress).success).toBe(true);
  });

  it("accepts an address with line2", () => {
    expect(
      addressSchema.safeParse({ ...validAddress, line2: "Flat 4" }).success
    ).toBe(true);
  });

  it.each(["fullName", "line1", "city", "state", "postalCode", "country", "phone"])(
    "rejects a blank %s",
    (field) => {
      const result = addressSchema.safeParse({ ...validAddress, [field]: "" });
      expect(result.success).toBe(false);
    }
  );
});

describe("orderInputSchema", () => {
  it("omits _id and createdAt, matching the other input schemas", () => {
    const { _id: _omitId, createdAt: _c, ...input } = valid;
    const result = orderInputSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("_id");
      expect(result.data).not.toHaveProperty("createdAt");
    }
  });

  it("still enforces the totals arithmetic", () => {
    const { _id: _omitId, createdAt: _c, ...input } = valid;
    expect(orderInputSchema.safeParse({ ...input, total: 1 }).success).toBe(
      false
    );
  });
});
