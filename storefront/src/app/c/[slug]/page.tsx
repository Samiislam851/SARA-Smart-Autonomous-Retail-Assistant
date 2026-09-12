import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getCategoryBySlug, listProductsByCategory } from "@/lib/db/repositories";
import { parsePage, parseSort } from "@/lib/query-params";
import { ProductGrid } from "@/components/product/ProductGrid";
import { Pagination } from "@/components/product/Pagination";
import { SortControl } from "@/components/product/SortControl";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ page?: string; sort?: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const category = await getCategoryBySlug(slug);
  return { title: category ? `${category.name} — NextCart` : "NextCart" };
}

export default async function CategoryPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const search = await searchParams;

  const category = await getCategoryBySlug(slug);
  if (!category) notFound();

  const page = parsePage(search.page);
  const sort = parseSort(search.sort) ?? "relevance";
  const result = await listProductsByCategory(slug, { page, sort });

  const basePath = `/c/${slug}`;
  const preserveParams = { sort };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8">
      <header className="border-b border-slate-200 pb-4">
        <h1 className="text-2xl font-bold text-slate-900">{category.name}</h1>
        {category.description && (
          <p className="mt-1 max-w-2xl text-sm text-slate-600">{category.description}</p>
        )}
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-600">
          {result.total.toLocaleString()} result{result.total === 1 ? "" : "s"}
        </p>
        <SortControl basePath={basePath} currentSort={sort} preserveParams={preserveParams} />
      </div>

      {result.items.length === 0 ? (
        <p className="py-16 text-center text-slate-600">
          No products are currently available in this category.
        </p>
      ) : (
        <ProductGrid products={result.items} />
      )}

      <Pagination
        page={result.page}
        totalPages={result.totalPages}
        basePath={basePath}
        preserveParams={preserveParams}
      />
    </div>
  );
}
