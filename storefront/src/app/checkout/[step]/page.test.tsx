import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { mockReadCartId, mockGetOrCreateCart, mockGetCheckoutState, mockRedirect, mockNotFound } =
  vi.hoisted(() => ({
    mockReadCartId: vi.fn(),
    mockGetOrCreateCart: vi.fn(),
    mockGetCheckoutState: vi.fn(),
    mockRedirect: vi.fn((url: string) => {
      throw new Error(`REDIRECT:${url}`);
    }),
    mockNotFound: vi.fn(() => {
      throw new Error("NOT_FOUND");
    }),
  }));

vi.mock("@/lib/session/cart", () => ({ readCartId: mockReadCartId }));
vi.mock("@/lib/db/repositories", () => ({ getOrCreateCart: mockGetOrCreateCart }));
vi.mock("@/lib/db/repositories/checkoutState", () => ({ getCheckoutState: mockGetCheckoutState }));
vi.mock("next/navigation", () => ({ redirect: mockRedirect, notFound: mockNotFound }));

vi.mock("@/components/checkout/AddressForm", () => ({
  AddressForm: () => <div data-testid="address-form" />,
}));
vi.mock("@/components/checkout/DeliveryForm", () => ({
  DeliveryForm: () => <div data-testid="delivery-form" />,
}));
vi.mock("@/components/checkout/PaymentStep", () => ({
  PaymentStep: () => <div data-testid="payment-step" />,
}));
vi.mock("@/components/checkout/ReviewStep", () => ({
  ReviewStep: () => <div data-testid="review-step" />,
}));

const { default: CheckoutStepPage } = await import("./page");

const NONEMPTY_CART = { cartId: "cart-1", currency: "USD", items: [{ price: 1000, quantity: 1 }], subtotal: 1000 };
const VALID_ADDRESS = { fullName: "Ada", line1: "1 Way", city: "London", state: "LDN", postalCode: "AA1", country: "UK", phone: "123" };

async function renderStep(step: string) {
  const jsx = await CheckoutStepPage({ params: Promise.resolve({ step }) });
  return render(jsx);
}

describe("CheckoutStepPage — 404 for unknown steps", () => {
  it("404s on a step that isn't one of the 4", async () => {
    await expect(CheckoutStepPage({ params: Promise.resolve({ step: "shipping" }) })).rejects.toThrow(
      "NOT_FOUND"
    );
  });
});

describe("CheckoutStepPage — empty-cart guard", () => {
  it("redirects to /cart when there is no cart cookie at all", async () => {
    mockReadCartId.mockResolvedValueOnce(null);
    await expect(CheckoutStepPage({ params: Promise.resolve({ step: "address" }) })).rejects.toThrow(
      "REDIRECT:/cart"
    );
  });

  it("redirects to /cart when the cart has no items", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce({ ...NONEMPTY_CART, items: [] });
    await expect(CheckoutStepPage({ params: Promise.resolve({ step: "review" }) })).rejects.toThrow(
      "REDIRECT:/cart"
    );
  });
});

describe("CheckoutStepPage — step guards", () => {
  it("address step renders with just a non-empty cart", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce(NONEMPTY_CART);
    mockGetCheckoutState.mockResolvedValueOnce(null);

    await renderStep("address");
    expect(screen.getByTestId("address-form")).toBeInTheDocument();
  });

  it("deep-linking to /checkout/review with no address redirects to /checkout/address, not a broken page", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce(NONEMPTY_CART);
    mockGetCheckoutState.mockResolvedValueOnce(null);

    await expect(CheckoutStepPage({ params: Promise.resolve({ step: "review" }) })).rejects.toThrow(
      "REDIRECT:/checkout/address"
    );
  });

  it("deep-linking to /checkout/review with an address but no delivery method redirects to /checkout/delivery", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce(NONEMPTY_CART);
    mockGetCheckoutState.mockResolvedValueOnce({ address: VALID_ADDRESS });

    await expect(CheckoutStepPage({ params: Promise.resolve({ step: "review" }) })).rejects.toThrow(
      "REDIRECT:/checkout/delivery"
    );
  });

  it("renders review once both address and delivery method are set", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce(NONEMPTY_CART);
    mockGetCheckoutState.mockResolvedValueOnce({ address: VALID_ADDRESS, deliveryMethod: "standard" });

    await renderStep("review");
    expect(screen.getByTestId("review-step")).toBeInTheDocument();
  });

  it("payment step also requires a delivery method first", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce(NONEMPTY_CART);
    mockGetCheckoutState.mockResolvedValueOnce({ address: VALID_ADDRESS });

    await expect(CheckoutStepPage({ params: Promise.resolve({ step: "payment" }) })).rejects.toThrow(
      "REDIRECT:/checkout/delivery"
    );
  });
});
