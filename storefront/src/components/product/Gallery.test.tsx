import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Gallery } from "./Gallery";

const images = [
  "/products/seed/test-product-1.webp",
  "/products/seed/test-product-2.webp",
  "/products/seed/test-product-3.webp",
];

describe("Gallery", () => {
  it("shows the first image as the main image initially", () => {
    render(<Gallery images={images} title="Test Product" />);
    expect(screen.getByAltText("Test Product — image 1 of 3")).toBeInTheDocument();
  });

  it("switches the main image when a thumbnail is clicked", async () => {
    const user = userEvent.setup();
    render(<Gallery images={images} title="Test Product" />);

    await user.click(screen.getByRole("tab", { name: "Show image 3 of 3" }));

    expect(screen.getByAltText("Test Product — image 3 of 3")).toBeInTheDocument();
    expect(screen.queryByAltText("Test Product — image 1 of 3")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Show image 3 of 3" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("shows an image-count badge inset from the edge, not flush against it", () => {
    render(<Gallery images={images} title="Test Product" />);
    const badge = screen.getByText("1 / 3");
    // Inset (bottom-2/right-2), not flush against the corner (bottom-0/
    // right-0) — flush would clip the badge's own rounded corners against
    // the gallery's overflow-hidden edge.
    expect(badge.className).toContain("bottom-2");
    expect(badge.className).toContain("right-2");
  });

  it("does not show a count badge for a single-image gallery", () => {
    render(<Gallery images={[images[0]]} title="Test Product" />);
    expect(screen.queryByText("1 / 1")).not.toBeInTheDocument();
  });

  it("updates the badge when a different thumbnail is selected", async () => {
    const user = userEvent.setup();
    render(<Gallery images={images} title="Test Product" />);
    await user.click(screen.getByRole("tab", { name: "Show image 2 of 3" }));
    expect(screen.getByText("2 / 3")).toBeInTheDocument();
  });
});
