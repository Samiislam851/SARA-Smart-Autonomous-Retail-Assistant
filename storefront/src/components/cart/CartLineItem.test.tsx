import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CartItem } from "@/lib/schemas";

const { mockUpdateQuantity, mockRemove } = vi.hoisted(() => ({
  mockUpdateQuantity: vi.fn(),
  mockRemove: vi.fn(),
}));

vi.mock("@/app/cart/actions", () => ({
  updateCartItemQuantityAction: mockUpdateQuantity,
  removeCartItemAction: mockRemove,
}));

const { CartLineItem } = await import("./CartLineItem");

const item: CartItem = {
  productId: "507f1f77bcf86cd799439011",
  slug: "test-product",
  title: "Test Product",
  price: 1999,
  quantity: 2,
  variantSelection: { size: "M" },
  imagePath: "/products/seed/test-product-1.webp",
};

describe("CartLineItem", () => {
  it("shows title, variant selection, unit price and line total", () => {
    render(<CartLineItem item={item} currency="USD" />);

    expect(screen.getByText("Test Product")).toBeInTheDocument();
    expect(screen.getByText("size: M")).toBeInTheDocument();
    expect(screen.getByText("$19.99")).toBeInTheDocument();
    expect(screen.getByText("$39.98")).toBeInTheDocument();
  });

  it("calls updateCartItemQuantityAction with the line identity and new quantity", async () => {
    const user = userEvent.setup();
    render(<CartLineItem item={item} currency="USD" />);

    await user.selectOptions(screen.getByLabelText("Quantity for Test Product"), "5");

    expect(mockUpdateQuantity).toHaveBeenCalledWith(item.productId, item.variantSelection, 5);
  });

  it("calls removeCartItemAction with the line identity when Remove is clicked", async () => {
    const user = userEvent.setup();
    render(<CartLineItem item={item} currency="USD" />);

    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(mockRemove).toHaveBeenCalledWith(item.productId, item.variantSelection);
  });

  it("offers quantities only up to the 99 cap", () => {
    render(<CartLineItem item={item} currency="USD" />);
    const select = screen.getByLabelText("Quantity for Test Product") as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => Number(o.value));
    expect(Math.max(...values)).toBe(99);
    expect(values).toHaveLength(99);
  });

  it("renders no variant line when the item has no variant selection", () => {
    render(<CartLineItem item={{ ...item, variantSelection: {} }} currency="USD" />);
    expect(screen.queryByText(/size:/)).not.toBeInTheDocument();
  });
});
