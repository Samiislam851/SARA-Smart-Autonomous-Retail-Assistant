import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { mockReadCartId, mockGetOrCreateCart } = vi.hoisted(() => ({
  mockReadCartId: vi.fn(),
  mockGetOrCreateCart: vi.fn(),
}));

vi.mock("@/lib/session/cart", () => ({ readCartId: mockReadCartId }));
vi.mock("@/lib/db/repositories", () => ({ getOrCreateCart: mockGetOrCreateCart }));
vi.mock("@/app/cart/actions", () => ({
  updateCartItemQuantityAction: vi.fn(),
  removeCartItemAction: vi.fn(),
  applyPromoCodeAction: vi.fn(),
  removePromoCodeAction: vi.fn(),
}));

const { default: CartPage } = await import("./page");

describe("CartPage", () => {
  it("renders a real empty state when there is no cart cookie at all", async () => {
    mockReadCartId.mockResolvedValueOnce(null);

    const jsx = await CartPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    expect(screen.getByText("Your NextCart cart is empty")).toBeInTheDocument();
    expect(mockGetOrCreateCart).not.toHaveBeenCalled();
  });

  it("renders a real empty state when the cart exists but has no items", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-123");
    mockGetOrCreateCart.mockResolvedValueOnce({
      cartId: "cart-123",
      currency: "USD",
      items: [],
      subtotal: 0,
    });

    const jsx = await CartPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    expect(screen.getByText("Your NextCart cart is empty")).toBeInTheDocument();
  });

  it("renders line items and a server-recomputed order summary", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-123");
    mockGetOrCreateCart.mockResolvedValueOnce({
      cartId: "cart-123",
      currency: "USD",
      items: [
        {
          productId: "507f1f77bcf86cd799439011",
          slug: "test-product",
          title: "Test Product",
          price: 1999,
          quantity: 2,
          variantSelection: {},
          imagePath: "/products/seed/test-product-1.webp",
        },
      ],
      subtotal: 3998,
    });

    const jsx = await CartPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    expect(screen.getByText("Test Product")).toBeInTheDocument();
    // Subtotal is the server-computed value from the repository, not a
    // client total — it shows up both as the line total and the order
    // summary's subtotal/total (shipping is free by default here).
    expect(screen.getAllByText("$39.98").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Total")).toBeInTheDocument();

    const checkoutLink = screen.getByRole("link", { name: "Proceed to checkout" });
    expect(checkoutLink).toHaveAttribute("data-agent-target", "begin-checkout");
    expect(checkoutLink).toHaveAttribute("href", "/checkout/address");
  });
});
