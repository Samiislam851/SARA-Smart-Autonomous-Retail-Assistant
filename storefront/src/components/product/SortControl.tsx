"use client";

import { useId } from "react";
import { useRouter } from "next/navigation";
import type { ProductSortOption } from "@/lib/db/repositories";

const SORT_OPTIONS: { value: ProductSortOption; label: string }[] = [
  { value: "relevance", label: "Featured" },
  { value: "newest", label: "Newest Arrivals" },
  { value: "price-asc", label: "Price: Low to High" },
  { value: "price-desc", label: "Price: High to Low" },
  { value: "rating", label: "Avg. Customer Review" },
];

/**
 * Sort dropdown — navigates to `basePath` with `sort` set to the chosen
 * value, preserving every other active param (`q`, etc.) and resetting
 * `page` back to 1 (a page number from the old sort order is meaningless
 * once the order changes). Client-only piece of an otherwise server page.
 */
export function SortControl({
  basePath,
  currentSort,
  preserveParams = {},
}: {
  basePath: string;
  currentSort: ProductSortOption;
  preserveParams?: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const id = useId();

  function handleChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(preserveParams)) {
      if (value !== undefined && value !== "") params.set(key, value);
    }
    params.set("sort", event.target.value);
    router.push(`${basePath}?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <label htmlFor={id} className="text-slate-600">
        Sort by
      </label>
      <select
        id={id}
        name="sort"
        value={currentSort}
        onChange={handleChange}
        className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
