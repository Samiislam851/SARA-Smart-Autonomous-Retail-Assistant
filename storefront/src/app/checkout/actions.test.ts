import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  mockReadCartId,
  mockGetOrCreateCart,
  mockCreateOrder,
  mockClearCart,
  mockGetCheckoutState,
  mockSaveCheckoutAddress,
  mockSaveCheckoutDeliveryMethod,
  mockClaimCheckoutForOrder,
  mockClearCheckoutState,
  mockGetSession,
  mockRedirect,
} = vi.hoisted(() => ({
  mockReadCartId: vi.fn(),
  mockGetOrCreateCart: vi.fn(),
  mockCreateOrder: vi.fn(),
  mockClearCart: vi.fn(),
  mockGetCheckoutState: vi.fn(),
  mockSaveCheckoutAddress: vi.fn(),
  mockSaveCheckoutDeliveryMethod: vi.fn(),
  mockClaimCheckoutForOrder: vi.fn(),
  mockClearCheckoutState: vi.fn(),
  mockGetSession: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/session/cart", () => ({ readCartId: mockReadCartId }));
vi.mock("@/lib/session/auth", () => ({ getSession: mockGetSession }));
vi.mock("@/lib/db/repositories", () => ({
  getOrCreateCart: mockGetOrCreateCart,
  createOrder: mockCreateOrder,
  clearCart: mockClearCart,
}));
vi.mock("@/lib/db/repositories/checkoutState", () => ({
  getCheckoutState: mockGetCheckoutState,
  saveCheckoutAddress: mockSaveCheckoutAddress,
  saveCheckoutDeliveryMethod: mockSaveCheckoutDeliveryMethod,
  claimCheckoutForOrder: mockClaimCheckoutForOrder,
  clearCheckoutState: mockClearCheckoutState,
}));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

const { saveAddressAction, saveDeliveryAction, placeOrderAction } = await import("./actions");

const VALID_ADDRESS = {
  fullName: "Ada Lovelace",
  line1: "123 Analytical Engine Way",
  city: "London",
  state: "Greater London",
  postalCode: "SW1A 1AA",
  country: "United Kingdom",
  phone: "+44 20 7946 0000",
};

function addressFormData(overrides: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries({ ...VALID_ADDRESS, ...overrides })) {
    fd.set(key, value);
  }
  return fd;
}

const NONEMPTY_CART = { cartId: "cart-1", currency: "USD", items: [{ price: 1000, quantity: 1 }], subtotal: 1000 };

beforeEach(() => {
  vi.clearAllMocks();
  mockRedirect.mockImplementation((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  });
});

describe("saveAddressAction", () => {
  it("rejects an empty submission with field errors and does not touch the repository", async () => {
    const state = await saveAddressAction(
      { errors: {}, values: {} },
      addressFormData({ fullName: "", line1: "", city: "", state: "", postalCode: "", country: "", phone: "" })
    );
    expect(state.errors.fullName).toBeTruthy();
    expect(state.errors.line1).toBeTruthy();
    expect(mockSaveCheckoutAddress).not.toHaveBeenCalled();
  });

  it("saves a valid address and redirects to delivery", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce(NONEMPTY_CART);

    await expect(
      saveAddressAction({ errors: {}, values: {} }, addressFormData())
    ).rejects.toThrow("REDIRECT:/checkout/delivery");

    expect(mockSaveCheckoutAddress).toHaveBeenCalledWith("cart-1", VALID_ADDRESS);
  });

  it("omits an empty optional line2 rather than saving an explicit empty string", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce(NONEMPTY_CART);

    await expect(
      saveAddressAction({ errors: {}, values: {} }, addressFormData({ line2: "" }))
    ).rejects.toThrow("REDIRECT:/checkout/delivery");

    const [, savedAddress] = mockSaveCheckoutAddress.mock.calls[0];
    expect("line2" in savedAddress).toBe(false);
  });

  it("redirects to /cart instead of saving when the cart is empty", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce({ ...NONEMPTY_CART, items: [] });

    await expect(
      saveAddressAction({ errors: {}, values: {} }, addressFormData())
    ).rejects.toThrow("REDIRECT:/cart");
    expect(mockSaveCheckoutAddress).not.toHaveBeenCalled();
  });
});

describe("saveDeliveryAction", () => {
  it("rejects a missing/invalid method without saving", async () => {
    const fd = new FormData();
    const state = await saveDeliveryAction({}, fd);
    expect(state.error).toBeTruthy();
    expect(mockSaveCheckoutDeliveryMethod).not.toHaveBeenCalled();
  });

  it("redirects to address when there's no address yet", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce(NONEMPTY_CART);
    mockGetCheckoutState.mockResolvedValueOnce(null);

    const fd = new FormData();
    fd.set("deliveryMethod", "express");

    await expect(saveDeliveryAction({}, fd)).rejects.toThrow("REDIRECT:/checkout/address");
    expect(mockSaveCheckoutDeliveryMethod).not.toHaveBeenCalled();
  });

  it("saves the chosen method (which determines shipping cost) and redirects to payment", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce(NONEMPTY_CART);
    mockGetCheckoutState.mockResolvedValueOnce({ address: VALID_ADDRESS });

    const fd = new FormData();
    fd.set("deliveryMethod", "express");

    await expect(saveDeliveryAction({}, fd)).rejects.toThrow("REDIRECT:/checkout/payment");
    expect(mockSaveCheckoutDeliveryMethod).toHaveBeenCalledWith("cart-1", "express");
  });
});

describe("placeOrderAction", () => {
  it("redirects to /cart without creating an order when the cart is empty", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce({ ...NONEMPTY_CART, items: [] });

    await expect(placeOrderAction()).rejects.toThrow("REDIRECT:/cart");
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("redirects to address/delivery when checkout state is incomplete", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce(NONEMPTY_CART);
    mockGetCheckoutState.mockResolvedValueOnce(null);

    await expect(placeOrderAction()).rejects.toThrow("REDIRECT:/checkout/address");
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it("creates the order, clears the cart and checkout state, and redirects to success with the order number", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce(NONEMPTY_CART);
    mockGetCheckoutState.mockResolvedValueOnce({
      address: VALID_ADDRESS,
      deliveryMethod: "standard",
    });
    mockClaimCheckoutForOrder.mockResolvedValueOnce(true);
    mockGetSession.mockResolvedValueOnce({ userId: "507f1f77bcf86cd799439011", role: "customer" });
    mockCreateOrder.mockResolvedValueOnce({ orderNumber: "RK-20260101-ABCDEF" });

    await expect(placeOrderAction()).rejects.toThrow("REDIRECT:/checkout/success?order=RK-20260101-ABCDEF");

    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "507f1f77bcf86cd799439011",
        items: NONEMPTY_CART.items,
        currency: "USD",
        shipping: 0,
        address: VALID_ADDRESS,
        deliveryMethod: "standard",
      })
    );
    expect(mockClearCart).toHaveBeenCalledWith("cart-1");
    expect(mockClearCheckoutState).toHaveBeenCalledWith("cart-1");
  });

  it("supports guest checkout — omits userId entirely when there is no session", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce(NONEMPTY_CART);
    mockGetCheckoutState.mockResolvedValueOnce({
      address: VALID_ADDRESS,
      deliveryMethod: "express",
    });
    mockClaimCheckoutForOrder.mockResolvedValueOnce(true);
    mockGetSession.mockResolvedValueOnce(null);
    mockCreateOrder.mockResolvedValueOnce({ orderNumber: "RK-20260101-GUEST1" });

    await expect(placeOrderAction()).rejects.toThrow(/REDIRECT:\/checkout\/success/);

    const orderInput = mockCreateOrder.mock.calls[0][0];
    expect("userId" in orderInput).toBe(false);
    expect(orderInput.shipping).toBe(999); // express
  });

  it("never creates a second order on a double-submit — the loser redirects to /cart instead", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-1");
    mockGetOrCreateCart.mockResolvedValueOnce(NONEMPTY_CART);
    mockGetCheckoutState.mockResolvedValueOnce({
      address: VALID_ADDRESS,
      deliveryMethod: "standard",
    });
    // Simulates a concurrent submit having already claimed this checkout.
    mockClaimCheckoutForOrder.mockResolvedValueOnce(false);

    await expect(placeOrderAction()).rejects.toThrow("REDIRECT:/cart");
    expect(mockCreateOrder).not.toHaveBeenCalled();
    expect(mockClearCart).not.toHaveBeenCalled();
  });
});
