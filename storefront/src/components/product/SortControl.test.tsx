import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SortControl } from "./SortControl";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

describe("SortControl", () => {
  it("reflects the current sort value", () => {
    render(<SortControl basePath="/c/electronics" currentSort="price-asc" />);
    expect(screen.getByLabelText("Sort by")).toHaveValue("price-asc");
  });

  it("navigates to basePath with the new sort param on change, preserving other params", async () => {
    const user = userEvent.setup();
    render(
      <SortControl
        basePath="/search"
        currentSort="relevance"
        preserveParams={{ q: "earbuds" }}
      />
    );

    await user.selectOptions(screen.getByLabelText("Sort by"), "rating");

    expect(push).toHaveBeenCalledWith("/search?q=earbuds&sort=rating");
  });
});
