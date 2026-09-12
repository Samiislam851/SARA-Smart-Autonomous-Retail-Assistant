import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProductVariant } from "@/lib/schemas";

const { mockAddToCartAction } = vi.hoisted(() => ({ mockAddToCartAction: vi.fn() }));
vi.mock("@/app/p/actions", () => ({ addToCartAction: mockAddToCartAction }));

const { ProductOptions } = await import("./ProductOptions");

const baseProps = {
  productId: "507f1f77bcf86cd799439011",
  slug: "test-product",
  title: "Test Product",
  price: 1999,
  imagePath: "/products/seed/test-product-1.webp",
};

describe("ProductOptions", () => {
  it("adds cleanly with no variants — no selection required", async () => {
    mockAddToCartAction.mockResolvedValueOnce({ ok: true });
    const user = userEvent.setup();
    render(<ProductOptions {...baseProps} variants={[]} stock={10} />);

    const button = screen.getByRole("button", { name: "Add to Cart" });
    expect(button).toBeEnabled();

    await user.click(button);

    expect(mockAddToCartAction).toHaveBeenCalledWith({
      ...baseProps,
      variantSelection: {},
    });
    expect(await screen.findByText("Added to cart.")).toBeInTheDocument();
  });

  it("auto-selects the first available option per variant type and enables the button", async () => {
    mockAddToCartAction.mockResolvedValueOnce({ ok: true });
    const variants: ProductVariant[] = [
      { type: "size", label: "Small", value: "S", available: true },
      { type: "size", label: "Medium", value: "M", available: true },
      { type: "colour", label: "Black", value: "black", available: true },
    ];
    const user = userEvent.setup();
    render(<ProductOptions {...baseProps} variants={variants} stock={10} />);

    const button = screen.getByRole("button", { name: "Add to Cart" });
    expect(button).toBeEnabled();

    await user.click(button);

    expect(mockAddToCartAction).toHaveBeenCalledWith({
      ...baseProps,
      variantSelection: { size: "S", colour: "black" },
    });
  });

  it("changing the variant selection sends the newly chosen value, never an explicit undefined for the other type", async () => {
    mockAddToCartAction.mockResolvedValueOnce({ ok: true });
    const variants: ProductVariant[] = [
      { type: "size", label: "Small", value: "S", available: true },
      { type: "size", label: "Large", value: "L", available: true },
    ];
    const user = userEvent.setup();
    render(<ProductOptions {...baseProps} variants={variants} stock={10} />);

    await user.click(screen.getByRole("button", { name: "Large" }));
    await user.click(screen.getByRole("button", { name: "Add to Cart" }));

    const call = mockAddToCartAction.mock.calls[0][0];
    expect(call.variantSelection).toEqual({ size: "L" });
    expect("colour" in call.variantSelection).toBe(false);
  });

  it("requires a selection before adding when no option is available to auto-select", () => {
    const variants: ProductVariant[] = [
      { type: "colour", label: "Discontinued Red", value: "red", available: false },
    ];
    render(<ProductOptions {...baseProps} variants={variants} stock={10} />);

    const button = screen.getByRole("button", { name: "Add to Cart" });
    expect(button).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Select a colour to continue.");
    expect(mockAddToCartAction).not.toHaveBeenCalled();
  });

  it("disables the button and shows 'Out of stock' when stock is 0", () => {
    render(<ProductOptions {...baseProps} variants={[]} stock={0} />);
    const button = screen.getByRole("button", { name: "Out of stock" });
    expect(button).toBeDisabled();
  });

  it("shows the repository's error message when adding fails", async () => {
    mockAddToCartAction.mockResolvedValueOnce({ ok: false, error: "Something went wrong." });
    const user = userEvent.setup();
    render(<ProductOptions {...baseProps} variants={[]} stock={10} />);

    await user.click(screen.getByRole("button", { name: "Add to Cart" }));

    expect(await screen.findByText("Something went wrong.")).toBeInTheDocument();
  });
});
