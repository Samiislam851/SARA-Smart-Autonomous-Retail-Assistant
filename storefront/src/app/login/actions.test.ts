import { describe, expect, it, vi } from "vitest";

const {
  mockGetUserById,
  mockSetSession,
  mockClearSession,
  mockClearCart,
  mockReadCartId,
  mockClearCartCookie,
  mockRedirect,
} = vi.hoisted(() => ({
  mockGetUserById: vi.fn(),
  mockSetSession: vi.fn(),
  mockClearSession: vi.fn(),
  mockClearCart: vi.fn(),
  mockReadCartId: vi.fn(),
  mockClearCartCookie: vi.fn(),
  mockRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("@/lib/db/repositories", () => ({ getUserById: mockGetUserById, clearCart: mockClearCart }));
vi.mock("@/lib/session/auth", () => ({ setSession: mockSetSession, clearSession: mockClearSession }));
vi.mock("@/lib/session/cart", () => ({
  readCartId: mockReadCartId,
  clearCartCookie: mockClearCartCookie,
}));
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

const { loginAction, logoutAction } = await import("./actions");

describe("loginAction", () => {
  it("sets the session and redirects home when no next param is given", async () => {
    mockGetUserById.mockResolvedValueOnce({
      _id: "507f1f77bcf86cd799439011",
      name: "Ada Lovelace",
      email: "ada@example.com",
      role: "customer",
    });

    await expect(loginAction("507f1f77bcf86cd799439011", undefined)).rejects.toThrow("REDIRECT:/");

    expect(mockSetSession).toHaveBeenCalledWith({
      userId: "507f1f77bcf86cd799439011",
      role: "customer",
    });
  });

  it("redirects to a same-origin next path when given one", async () => {
    mockGetUserById.mockResolvedValueOnce({
      _id: "507f1f77bcf86cd799439011",
      name: "Admin User",
      email: "admin@example.com",
      role: "admin",
    });

    await expect(loginAction("507f1f77bcf86cd799439011", "/admin/products")).rejects.toThrow(
      "REDIRECT:/admin/products"
    );
  });

  it("ignores an off-site next value", async () => {
    mockGetUserById.mockResolvedValueOnce({
      _id: "507f1f77bcf86cd799439011",
      name: "Ada Lovelace",
      email: "ada@example.com",
      role: "customer",
    });

    await expect(loginAction("507f1f77bcf86cd799439011", "https://evil.example")).rejects.toThrow(
      "REDIRECT:/"
    );
  });

  it("redirects back to /login without setting a session when the user doesn't exist", async () => {
    mockGetUserById.mockResolvedValueOnce(null);

    await expect(loginAction("507f1f77bcf86cd799439099", undefined)).rejects.toThrow(
      "REDIRECT:/login"
    );
    expect(mockSetSession).not.toHaveBeenCalled();
  });
});

describe("logoutAction", () => {
  it("empties the cart, drops the cart cookie, clears the session and redirects home", async () => {
    mockReadCartId.mockResolvedValueOnce("cart-abc");

    await expect(logoutAction()).rejects.toThrow("REDIRECT:/");

    expect(mockClearCart).toHaveBeenCalledWith("cart-abc");
    expect(mockClearCartCookie).toHaveBeenCalled();
    expect(mockClearSession).toHaveBeenCalled();
  });

  it("still drops the cookie and clears the session when there is no cart", async () => {
    mockReadCartId.mockResolvedValueOnce(null);

    await expect(logoutAction()).rejects.toThrow("REDIRECT:/");

    expect(mockClearCart).not.toHaveBeenCalled();
    expect(mockClearCartCookie).toHaveBeenCalled();
    expect(mockClearSession).toHaveBeenCalled();
  });
});
