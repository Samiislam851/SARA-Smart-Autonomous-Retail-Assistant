import type { ProductSortOption } from "@/lib/db/repositories";

const VALID_SORTS: readonly ProductSortOption[] = [
  "relevance",
  "price-asc",
  "price-desc",
  "rating",
  "newest",
];

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Parses a `?sort=` search param, falling back to `undefined` (repository default) for anything unrecognized. */
export function parseSort(value: string | string[] | undefined): ProductSortOption | undefined {
  const v = firstValue(value);
  return (VALID_SORTS as string[]).includes(v ?? "") ? (v as ProductSortOption) : undefined;
}

/** Parses a `?page=` search param, clamping to a positive integer (defaults to 1). */
export function parsePage(value: string | string[] | undefined): number {
  const v = firstValue(value);
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}
