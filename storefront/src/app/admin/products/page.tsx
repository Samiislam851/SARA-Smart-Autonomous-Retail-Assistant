import Link from "next/link";
import type { Metadata } from "next";
import { listProductsForAdmin } from "@/lib/db/repositories";
import { formatPrice } from "@/lib/format";
import { Pagination } from "@/components/product/Pagination";
import { toggleProductActiveAction } from "./actions";

export const metadata: Metadata = { title: "Admin — Products — NextCart" };

interface PageProps {
  searchParams: Promise<{ q?: string; page?: string; includeInactive?: string }>;
}

function parsePage(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/**
 * REQUIREMENTS: paginated list via `listProductsForAdmin`, search box,
 * pagination, a clear active/inactive indicator, and inactive products
 * shown plainly (not filtered out by default the way the storefront does —
 * "the point of the admin list is seeing what the storefront hides"). The
 * `includeInactive` checkbox controls whether they're INCLUDED, but once
 * included they are never visually hidden or disguised as active.
 */
export default async function AdminProductsPage({ searchParams }: PageProps) {
  const search = await searchParams;
  const query = search.q?.trim() ?? "";
  const page = parsePage(search.page);
  const includeInactive = search.includeInactive === "1";

  const result = await listProductsForAdmin({
    query: query || undefined,
    page,
    includeInactive,
  });

  const basePath = "/admin/products";
  const preserveParams: Record<string, string | undefined> = {
    q: query || undefined,
    includeInactive: includeInactive ? "1" : undefined,
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Products</h1>
        <Link
          href="/admin/products/new"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
        >
          + New product
        </Link>
      </div>

      <form action={basePath} method="GET" className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col">
          <label htmlFor="q" className="text-xs font-medium text-slate-600">
            Search
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={query}
            placeholder="Title, brand, category…"
            className="w-64 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
        </div>
        <label className="flex items-center gap-2 pb-1.5 text-sm text-slate-700">
          <input type="checkbox" name="includeInactive" value="1" defaultChecked={includeInactive} />
          Include inactive
        </label>
        <button
          type="submit"
          className="rounded-md border border-slate-300 px-4 py-1.5 text-sm font-medium hover:bg-slate-100"
        >
          Apply
        </button>
      </form>

      <p className="text-sm text-slate-600" aria-live="polite">
        {result.total.toLocaleString()} product{result.total === 1 ? "" : "s"}
      </p>

      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-semibold text-slate-700">
                Title
              </th>
              <th scope="col" className="px-3 py-2 text-left font-semibold text-slate-700">
                Brand
              </th>
              <th scope="col" className="px-3 py-2 text-left font-semibold text-slate-700">
                Category
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold text-slate-700">
                Price
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold text-slate-700">
                Stock
              </th>
              <th scope="col" className="px-3 py-2 text-left font-semibold text-slate-700">
                Status
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold text-slate-700">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {result.items.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-slate-500">
                  No products found.
                </td>
              </tr>
            )}
            {result.items.map((product) => (
              <tr key={product._id} className={product.isActive ? "" : "bg-slate-50"}>
                <td className="px-3 py-2 font-medium text-slate-900">
                  <Link href={`/admin/products/${product._id}/edit`} className="hover:underline">
                    {product.title}
                  </Link>
                </td>
                <td className="px-3 py-2 text-slate-700">{product.brand}</td>
                <td className="px-3 py-2 text-slate-700">{product.categorySlug}</td>
                <td className="px-3 py-2 text-right text-slate-700">
                  {formatPrice(product.price, product.currency)}
                </td>
                <td className="px-3 py-2 text-right text-slate-700">{product.stock}</td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                      product.isActive
                        ? "bg-emerald-100 text-emerald-800"
                        : "bg-slate-200 text-slate-600"
                    }`}
                  >
                    {product.isActive ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-2">
                    <Link
                      href={`/admin/products/${product._id}/edit`}
                      className="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:bg-slate-100"
                    >
                      Edit
                    </Link>
                    <form action={toggleProductActiveAction.bind(null, product._id, !product.isActive)}>
                      <button
                        type="submit"
                        className="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:bg-slate-100"
                      >
                        {product.isActive ? "Deactivate" : "Activate"}
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        page={result.page}
        totalPages={result.totalPages}
        basePath={basePath}
        preserveParams={preserveParams}
      />
    </div>
  );
}
