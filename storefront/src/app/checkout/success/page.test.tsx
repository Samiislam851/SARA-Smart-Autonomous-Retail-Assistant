import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { mockGetOrderByNumber, mockRedirect } = vi.hoisted(() => ({
  mockGetOrderByNumber: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/db/repositories", () => ({ getOrderByNumber: mockGetOrderByNumber }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

const { default: CheckoutSuccessPage } = await import("./page");

const REAL_ORDER = {
  _id: "507f1f77bcf86cd799439011",
  orderNumber: "RK-20260101-ABCDEF",
  items: [
    {
      productId: "507f1f77bcf86cd799439012",
      slug: "test-product",
      title: "Test Product",
      price: 1999,
      quantity: 2,
      variantSelection: {},
      imagePath: "/products/seed/test-product-1.webp",
    },
  ],
  currency: "USD",
  subtotal: 3998,
  shipping: 0,
  total: 3998,
  address: {
    fullName: "Ada",
    line1: "1 Way",
    city: "London",
    state: "LDN",
    postalCode: "AA1",
    country: "UK",
    phone: "123",
  },
  deliveryMethod: "standard" as const,
  paymentMethod: "cod" as const,
  status: "placed" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("CheckoutSuccessPage", () => {
  it("redirects home without querying the repository when there is no order param", async () => {
    await expect(
      CheckoutSuccessPage({ searchParams: Promise.resolve({}) })
    ).rejects.toThrow("REDIRECT:/");
    expect(mockGetOrderByNumber).not.toHaveBeenCalled();
  });

  it("redirects home instead of 500ing when the order number doesn't exist", async () => {
    mockGetOrderByNumber.mockResolvedValueOnce(null);
    await expect(
      CheckoutSuccessPage({ searchParams: Promise.resolve({ order: "RK-NOPE" }) })
    ).rejects.toThrow("REDIRECT:/");
  });

  it("renders the order — number, items, delivery method, COD notice, total — read back by number", async () => {
    mockGetOrderByNumber.mockResolvedValueOnce(REAL_ORDER);

    const jsx = await CheckoutSuccessPage({
      searchParams: Promise.resolve({ order: "RK-20260101-ABCDEF" }),
    });
    render(jsx);

    expect(mockGetOrderByNumber).toHaveBeenCalledWith("RK-20260101-ABCDEF");
    expect(screen.getByText("RK-20260101-ABCDEF")).toBeInTheDocument();
    expect(screen.getByText(/Test Product/)).toBeInTheDocument();
    expect(screen.getByText("Standard Shipping")).toBeInTheDocument();
    expect(screen.getByText("Cash on Delivery")).toBeInTheDocument();
    expect(screen.getAllByText("$39.98").length).toBeGreaterThan(0);
  });
});
