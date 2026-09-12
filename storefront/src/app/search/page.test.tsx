import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeProduct } from "@/test/fixtures";

const { mockSearchProducts } = vi.hoisted(() => ({ mockSearchProducts: vi.fn() }));

vi.mock("@/lib/db/repositories", () => ({
  searchProducts: mockSearchProducts,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { default: SearchPage } = await import("./page");

describe("SearchPage", () => {
  it("shows a sensible prompt for an empty query, without querying the repository", async () => {
    const jsx = await SearchPage({ searchParams: Promise.resolve({}) });
    render(jsx);

    expect(screen.getByText("Search NextCart")).toBeInTheDocument();
    expect(mockSearchProducts).not.toHaveBeenCalled();
  });

  it("renders a real empty state for zero results", async () => {
    mockSearchProducts.mockResolvedValueOnce({ items: [], total: 0, page: 1, totalPages: 0 });

    const jsx = await SearchPage({ searchParams: Promise.resolve({ q: "zzznoresults" }) });
    render(jsx);

    const emptyStateMessage = screen.getByText(/No products matched/);
    expect(emptyStateMessage).toBeInTheDocument();
    expect(emptyStateMessage.textContent).toContain("zzznoresults");
  });

  it("renders results when the repository returns products", async () => {
    mockSearchProducts.mockResolvedValueOnce({
      items: [makeProduct({ title: "Wireless Earbuds" })],
      total: 1,
      page: 1,
      totalPages: 1,
    });

    const jsx = await SearchPage({ searchParams: Promise.resolve({ q: "earbuds" }) });
    render(jsx);

    expect(screen.getByText("Wireless Earbuds")).toBeInTheDocument();
  });
});
