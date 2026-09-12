import { describe, expect, it, vi } from "vitest";

const { mockReadCartId, mockUpdateCartItemQuantity, mockRemoveCartItem, mockRevalidatePath } =
  vi.hoisted(() => ({
    mockReadCartId: vi.fn(),
    mockUpdateCartItemQuantity: vi.fn(),
    mockRemoveCartItem: vi.fn(),
    mockRevalidatePath: vi.fn(),
  }));

vi.mock("@/lib/session/cart", () => ({ readCartId: mockReadCartId }));
vi.mock("@/lib/db/repositories", () => ({
  updateCartItemQuantity: mockUpdateCartItemQuantity,
  removeCartItem: mockRemoveCartItem,
}));
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

const { updateCartItemQuantityAction, removeCartItemAction } = await import("./actions");

describe("updateCartItemQuantityAction", () => {
  it("no-ops when there is no cart cookie", async () => {
    mockReadCartId.mockResolvedValueOnce(null);
    await updateCartItemQuantityAction("p1", {}, 3);
    expect(mockUpdateCartItemQuantity).not.toHaveBeenCalled();
  });

  it("updates the line and revalidates the cart page", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-123");
    await updateCartItemQuantityAction("p1", { size: "M" }, 3);
    expect(mockUpdateCartItemQuantity).toHaveBeenCalledWith("cart-123", "p1", { size: "M" }, 3);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/cart");
  });
});

describe("removeCartItemAction", () => {
  it("no-ops when there is no cart cookie", async () => {
    mockReadCartId.mockResolvedValueOnce(null);
    await removeCartItemAction("p1", {});
    expect(mockRemoveCartItem).not.toHaveBeenCalled();
  });

  it("removes the line and revalidates the cart page", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-123");
    await removeCartItemAction("p1", { size: "M" });
    expect(mockRemoveCartItem).toHaveBeenCalledWith("cart-123", "p1", { size: "M" });
    expect(mockRevalidatePath).toHaveBeenCalledWith("/cart");
  });
});
