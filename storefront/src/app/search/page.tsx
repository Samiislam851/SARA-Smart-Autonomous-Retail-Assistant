import type { Metadata } from "next";
import { searchProducts } from "@/lib/db/repositories";
import { parsePage, parseSort } from "@/lib/query-params";
import { ProductGrid } from "@/components/product/ProductGrid";
import { Pagination } from "@/components/product/Pagination";
import { SortControl } from "@/components/product/SortControl";

interface PageProps {
  searchParams: Promise<{ q?: string; page?: string; sort?: string }>;
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { q } = await searchParams;
  return { title: q ? `“${q}” — Search results — NextCart` : "Search — NextCart" };
}

export default async function SearchPage({ searchParams }: PageProps) {
  const search = await searchParams;
  const query = (search.q ?? "").trim();
  const page = parsePage(search.page);
  const sort = parseSort(search.sort) ?? "relevance";

  const basePath = "/search";
  const preserveParams = { q: query, sort };

  if (!query) {
    return (
      <div className="mx-auto flex w-full max-w-7xl flex-col items-center gap-2 px-4 py-24 text-center">
        <h1 className="text-xl font-semibold text-slate-900">Search NextCart</h1>
        <p className="max-w-md text-sm text-slate-600">
          Use the search bar above to find products by title, brand or description.
        </p>
      </div>
    );
  }

  const result = await searchProducts(query, { page, sort });

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <header className="border-b border-slate-200 pb-4" data-agent-search-results={result.total}>
        <h1 className="text-xl font-bold text-slate-900">
          Results for &ldquo;{query}&rdquo;
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          {result.total.toLocaleString()} result{result.total === 1 ? "" : "s"}
        </p>
      </header>

      {result.items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <p className="text-base font-medium text-slate-800">
            No products matched &ldquo;{query}&rdquo;
          </p>
          <p className="max-w-md text-sm text-slate-600">
            Try a different search term, check your spelling, or browse a category from the
            home page instead.
          </p>
        </div>
      ) : (
        <>
          <div className="flex justify-end">
            <SortControl basePath={basePath} currentSort={sort} preserveParams={preserveParams} />
          </div>
          <ProductGrid products={result.items} />
          <Pagination
            page={result.page}
            totalPages={result.totalPages}
            basePath={basePath}
            preserveParams={preserveParams}
          />
        </>
      )}
    </div>
  );
}
