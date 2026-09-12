import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { mockGetCurrentUser, mockReadCartId, mockGetOrCreateCart, mockCountUnreadForUser } =
  vi.hoisted(() => ({
    mockGetCurrentUser: vi.fn(),
    mockReadCartId: vi.fn(),
    mockGetOrCreateCart: vi.fn(),
    mockCountUnreadForUser: vi.fn().mockResolvedValue(0),
  }));

vi.mock("@/lib/session/auth", () => ({ getCurrentUser: mockGetCurrentUser }));
vi.mock("@/lib/session/cart", () => ({ readCartId: mockReadCartId }));
vi.mock("@/lib/db/repositories", () => ({
  getOrCreateCart: mockGetOrCreateCart,
  countUnreadForUser: mockCountUnreadForUser,
}));
vi.mock("@/app/login/actions", () => ({ logoutAction: vi.fn() }));

const { Header } = await import("./Header");

describe("Header", () => {
  it("renders the logo, search input hook and cart/account links when signed out with no cart", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null);
    mockReadCartId.mockResolvedValueOnce(null);

    const jsx = await Header();
    render(jsx);

    expect(screen.getByRole("link", { name: "NextCart" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /^Cart/ })).toBeInTheDocument();
    expect(screen.getByText("Hello, sign in")).toBeInTheDocument();

    const searchInput = screen.getByLabelText("Search NextCart");
    expect(searchInput).toBeInTheDocument();
    expect(searchInput).toHaveAttribute("data-agent-target", "search-input");
    expect(mockGetOrCreateCart).not.toHaveBeenCalled();
  });

  it("greets a signed-in user and offers sign out", async () => {
    mockGetCurrentUser.mockResolvedValueOnce({
      _id: "507f1f77bcf86cd799439011",
      name: "Ada Lovelace",
      email: "ada@example.com",
      role: "customer",
    });
    mockReadCartId.mockResolvedValueOnce(null);

    const jsx = await Header();
    render(jsx);

    expect(screen.getByText("Hello, Ada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("shows the cart item count only when a cart cookie already exists", async () => {
    mockGetCurrentUser.mockResolvedValueOnce(null);
    mockReadCartId.mockResolvedValueOnce("existing-cart-id");
    mockGetOrCreateCart.mockResolvedValueOnce({
      items: [
        { quantity: 2 },
        { quantity: 1 },
      ],
    });

    const jsx = await Header();
    render(jsx);

    expect(mockGetOrCreateCart).toHaveBeenCalledWith("existing-cart-id");
    expect(screen.getByText("3")).toBeInTheDocument();
  });
});
