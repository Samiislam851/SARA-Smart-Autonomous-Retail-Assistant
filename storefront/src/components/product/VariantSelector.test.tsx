import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ProductVariant } from "@/lib/schemas";
import { VariantSelector } from "./VariantSelector";

const variants: ProductVariant[] = [
  { type: "colour", label: "Sunset Orange", value: "sunset-orange", available: true },
  { type: "colour", label: "Slate Grey", value: "slate-grey", available: false },
  { type: "colour", label: "Ocean Blue", value: "ocean-blue", available: true },
];

describe("VariantSelector", () => {
  it("renders every variant as a button, none as a link", () => {
    render(
      <VariantSelector type="colour" variants={variants} selected={undefined} onSelect={vi.fn()} />
    );
    expect(screen.getAllByRole("button")).toHaveLength(3);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  it("disables unavailable options instead of hiding them", () => {
    render(
      <VariantSelector type="colour" variants={variants} selected={undefined} onSelect={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: /Slate Grey/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sunset Orange" })).toBeEnabled();
  });

  it("calls onSelect with the chosen value and never navigates", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <VariantSelector type="colour" variants={variants} selected={undefined} onSelect={onSelect} />
    );

    await user.click(screen.getByRole("button", { name: "Ocean Blue" }));

    expect(onSelect).toHaveBeenCalledWith("ocean-blue");
    expect(window.location.pathname).toBe("/");
  });

  it("does not call onSelect when clicking a disabled option", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <VariantSelector type="colour" variants={variants} selected={undefined} onSelect={onSelect} />
    );

    await user.click(screen.getByRole("button", { name: /Slate Grey/ }));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks the selected option as pressed", () => {
    render(
      <VariantSelector
        type="colour"
        variants={variants}
        selected="sunset-orange"
        onSelect={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Sunset Orange" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
  });
});
