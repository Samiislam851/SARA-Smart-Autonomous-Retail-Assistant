import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ELLIPSIS, getPageItems, getPaginationInfo, Pagination } from "./Pagination";

describe("getPaginationInfo", () => {
  it("has no prev on page 1 and no next on the last page", () => {
    const first = getPaginationInfo(1, 5);
    expect(first.hasPrev).toBe(false);
    expect(first.prevPage).toBeNull();
    expect(first.hasNext).toBe(true);
    expect(first.nextPage).toBe(2);

    const last = getPaginationInfo(5, 5);
    expect(last.hasNext).toBe(false);
    expect(last.nextPage).toBeNull();
    expect(last.hasPrev).toBe(true);
    expect(last.prevPage).toBe(4);
  });

  it("computes prev/next for a middle page", () => {
    const middle = getPaginationInfo(3, 5);
    expect(middle.hasPrev).toBe(true);
    expect(middle.prevPage).toBe(2);
    expect(middle.hasNext).toBe(true);
    expect(middle.nextPage).toBe(4);
  });

  it("always includes the boundary pages (1 and last)", () => {
    const items = getPageItems(5, 10);
    expect(items[0]).toBe(1);
    expect(items[items.length - 1]).toBe(10);
  });

  it("collapses a large gap into a single ellipsis", () => {
    const items = getPageItems(1, 10);
    expect(items).toEqual([1, 2, ELLIPSIS, 10]);
  });

  it("renders no ellipsis when every page fits", () => {
    const items = getPageItems(2, 3);
    expect(items).toEqual([1, 2, 3]);
  });

  it("returns a single page for totalPages === 1 and nothing for 0", () => {
    expect(getPageItems(1, 1)).toEqual([1]);
    expect(getPageItems(1, 0)).toEqual([]);
  });
});

describe("Pagination component", () => {
  it("renders nothing for a single page", () => {
    const { container } = render(
      <Pagination page={1} totalPages={1} basePath="/c/electronics" />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("disables Prev on the first page and links Next forward, preserving other params", () => {
    render(
      <Pagination
        page={1}
        totalPages={3}
        basePath="/c/electronics"
        preserveParams={{ sort: "price-asc" }}
      />
    );

    expect(screen.getByText("Prev")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      "/c/electronics?sort=price-asc&page=2"
    );
    expect(screen.getByRole("link", { name: "2" })).toHaveAttribute(
      "href",
      "/c/electronics?sort=price-asc&page=2"
    );
  });

  it("disables Next on the last page", () => {
    render(<Pagination page={3} totalPages={3} basePath="/c/electronics" />);
    expect(screen.getByText("Next")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("link", { name: "Prev" })).toHaveAttribute(
      "href",
      "/c/electronics?page=2"
    );
  });

  it("marks the current page with aria-current", () => {
    render(<Pagination page={2} totalPages={3} basePath="/c/electronics" />);
    expect(screen.getByRole("link", { name: "2" })).toHaveAttribute("aria-current", "page");
  });
});
