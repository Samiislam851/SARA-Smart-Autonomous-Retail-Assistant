import { describe, expect, it, vi } from "vitest";

const { mockEnsureCartId, mockAddCartItem, mockRevalidatePath } = vi.hoisted(() => ({
  mockEnsureCartId: vi.fn(),
  mockAddCartItem: vi.fn(),
  mockRevalidatePath: vi.fn(),
}));

vi.mock("@/lib/session/cart", () => ({ ensureCartId: mockEnsureCartId }));
vi.mock("@/lib/db/repositories", () => ({ addCartItem: mockAddCartItem }));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

const { addToCartAction } = await import("./actions");

const input = {
  productId: "507f1f77bcf86cd799439011",
  slug: "test-product",
  title: "Test Product",
  price: 1999,
  imagePath: "/products/seed/test-product-1.webp",
  variantSelection: { size: "M" },
};

describe("addToCartAction", () => {
  it("ensures a cart id (creating the cookie on this first write) and adds the item", async () => {
    mockEnsureCartId.mockResolvedValueOnce("cart-123");
    mockAddCartItem.mockResolvedValueOnce({ cartId: "cart-123", items: [], subtotal: 0 });

    const result = await addToCartAction(input);

    expect(mockEnsureCartId).toHaveBeenCalled();
    expect(mockAddCartItem).toHaveBeenCalledWith("cart-123", input);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/cart");
    expect(result).toEqual({ ok: true });
  });

  it("returns a friendly error instead of throwing when the repository rejects", async () => {
    mockEnsureCartId.mockResolvedValueOnce("cart-123");
    mockAddCartItem.mockRejectedValueOnce(new Error("Cart is full"));

    const result = await addToCartAction(input);

    expect(result).toEqual({ ok: false, error: "Cart is full" });
  });

  it("adds cleanly with an empty variant selection", async () => {
    mockEnsureCartId.mockResolvedValueOnce("cart-123");
    mockAddCartItem.mockResolvedValueOnce({ cartId: "cart-123", items: [], subtotal: 0 });

    const result = await addToCartAction({ ...input, variantSelection: {} });

    expect(mockAddCartItem).toHaveBeenCalledWith("cart-123", { ...input, variantSelection: {} });
    expect(result).toEqual({ ok: true });
  });
});
