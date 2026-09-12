import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeProduct } from "@/test/fixtures";
import { ProductCard } from "./ProductCard";

describe("ProductCard", () => {
  it("renders title, brand, formatted price and rating", () => {
    render(
      <ProductCard
        product={makeProduct({ title: "Wireless Earbuds", brand: "Wavecrest", price: 5399 })}
      />
    );

    expect(screen.getByRole("link")).toHaveAttribute("href", "/p/test-product");
    expect(screen.getByText("Wireless Earbuds")).toBeInTheDocument();
    expect(screen.getByText("Wavecrest")).toBeInTheDocument();
    expect(screen.getByText("$53.99")).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Rated 4\.2 out of 5 stars, 128 reviews/)
    ).toBeInTheDocument();
  });

  it("shows an out-of-stock badge and no unavailable marker when in stock", () => {
    render(<ProductCard product={makeProduct({ stock: 10 })} />);
    expect(screen.queryByText("Out of stock")).not.toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).not.toBeInTheDocument();
  });

  it("shows an out-of-stock badge when stock is zero", () => {
    render(<ProductCard product={makeProduct({ stock: 0 })} />);
    expect(screen.getByText("Out of stock")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });
});
