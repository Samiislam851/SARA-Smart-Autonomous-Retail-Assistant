import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CartWithTotals } from "@/lib/db/repositories";
import type { Address } from "@/lib/schemas";

vi.mock("@/app/checkout/actions", () => ({ placeOrderAction: vi.fn() }));

const { ReviewStep } = await import("./ReviewStep");

const address: Address = {
  fullName: "Ada Lovelace",
  line1: "1 Analytical Way",
  city: "London",
  state: "LDN",
  postalCode: "AA1 1AA",
  country: "UK",
  phone: "123",
};

const cart: CartWithTotals = {
  _id: "507f1f77bcf86cd799439011",
  cartId: "cart-1",
  currency: "USD",
  items: [
    {
      productId: "507f1f77bcf86cd799439012",
      slug: "test-product",
      title: "Test Product",
      price: 1000,
      quantity: 2,
      variantSelection: {},
      imagePath: "/products/seed/test-product-1.webp",
    },
  ],
  subtotal: 2000,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("ReviewStep", () => {
  it("shows the place-order button with the agent hook attribute", () => {
    render(<ReviewStep cart={cart} address={address} deliveryMethod="standard" />);
    const button = screen.getByRole("button", { name: /Place your order/ });
    expect(button).toHaveAttribute("data-agent-target", "place-order");
  });

  it("total reflects free standard shipping", () => {
    render(<ReviewStep cart={cart} address={address} deliveryMethod="standard" />);
    // Subtotal $20.00 + free shipping = $20.00 total.
    expect(screen.getAllByText("$20.00").length).toBeGreaterThanOrEqual(2);
  });

  it("total changes when express delivery is chosen — shipping is added on top of subtotal", () => {
    render(<ReviewStep cart={cart} address={address} deliveryMethod="express" />);
    // Subtotal $20.00 + $9.99 express = $29.99 total.
    expect(screen.getByText("$29.99")).toBeInTheDocument();
  });

  it("renders the shipping address and item details", () => {
    render(<ReviewStep cart={cart} address={address} deliveryMethod="standard" />);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("Test Product")).toBeInTheDocument();
    expect(screen.getByText("Qty 2")).toBeInTheDocument();
  });
});
