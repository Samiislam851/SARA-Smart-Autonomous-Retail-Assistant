import Link from "next/link";

export const ELLIPSIS = "…" as const;
export type PageItem = number | typeof ELLIPSIS;

/**
 * Pure page-range calculator: always includes page 1 and the last page,
 * the current page and one sibling on each side, collapsing any gap into a
 * single ellipsis. Exported (and unit-tested) separately from the
 * component so prev/next/boundary logic can be verified without rendering.
 */
export function getPageItems(page: number, totalPages: number): PageItem[] {
  if (totalPages <= 1) return totalPages === 1 ? [1] : [];

  const siblingCount = 1;
  const first = 1;
  const last = totalPages;
  const start = Math.max(page - siblingCount, first);
  const end = Math.min(page + siblingCount, last);

  const items: PageItem[] = [];
  items.push(first);
  if (start > first + 1) items.push(ELLIPSIS);
  for (let p = Math.max(start, first + 1); p <= Math.min(end, last - 1); p++) {
    items.push(p);
  }
  if (end < last - 1) items.push(ELLIPSIS);
  if (last !== first) items.push(last);

  return items;
}

export interface PaginationInfo {
  hasPrev: boolean;
  hasNext: boolean;
  prevPage: number | null;
  nextPage: number | null;
  items: PageItem[];
}

export function getPaginationInfo(page: number, totalPages: number): PaginationInfo {
  return {
    hasPrev: page > 1,
    hasNext: page < totalPages,
    prevPage: page > 1 ? page - 1 : null,
    nextPage: page < totalPages ? page + 1 : null,
    items: getPageItems(page, totalPages),
  };
}

function hrefFor(
  basePath: string,
  page: number,
  preserveParams: Record<string, string | undefined>
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(preserveParams)) {
    if (value !== undefined && value !== "") params.set(key, value);
  }
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/**
 * URL-driven pagination — every page is a real link (`?page=N`), no client
 * JS required. `preserveParams` carries every other active query param
 * (e.g. `sort`, `q`) so paging never drops them.
 */
export function Pagination({
  page,
  totalPages,
  basePath,
  preserveParams = {},
}: {
  page: number;
  totalPages: number;
  basePath: string;
  preserveParams?: Record<string, string | undefined>;
}) {
  if (totalPages <= 1) return null;

  const info = getPaginationInfo(page, totalPages);
  const linkClass =
    "flex h-9 min-w-9 items-center justify-center rounded-md border border-slate-300 px-2 text-sm font-medium text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500";
  const currentClass =
    "flex h-9 min-w-9 items-center justify-center rounded-md border border-slate-900 bg-slate-900 px-2 text-sm font-semibold text-white";
  const disabledClass =
    "flex h-9 min-w-9 items-center justify-center rounded-md border border-slate-200 px-2 text-sm font-medium text-slate-400";

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-center gap-1.5">
      {info.hasPrev && info.prevPage !== null ? (
        <Link href={hrefFor(basePath, info.prevPage, preserveParams)} className={linkClass}>
          Prev
        </Link>
      ) : (
        <span aria-disabled="true" className={disabledClass}>
          Prev
        </span>
      )}

      {info.items.map((item, index) =>
        item === ELLIPSIS ? (
          <span key={`ellipsis-${index}`} className="px-1 text-sm text-slate-400">
            {ELLIPSIS}
          </span>
        ) : (
          <Link
            key={item}
            href={hrefFor(basePath, item, preserveParams)}
            aria-current={item === page ? "page" : undefined}
            className={item === page ? currentClass : linkClass}
          >
            {item}
          </Link>
        )
      )}

      {info.hasNext && info.nextPage !== null ? (
        <Link href={hrefFor(basePath, info.nextPage, preserveParams)} className={linkClass}>
          Next
        </Link>
      ) : (
        <span aria-disabled="true" className={disabledClass}>
          Next
        </span>
      )}
    </nav>
  );
}
