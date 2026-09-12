import { listCategories } from "@/lib/db/repositories";
import { getNewArrivalsRail, getTopRatedRail } from "@/lib/home-rails";
import { CategoryTile } from "@/components/category/CategoryTile";
import { ProductGrid } from "@/components/product/ProductGrid";

/**
 * Forced dynamic: this page has no dynamic route segment, so Next would
 * otherwise try to prerender it at build time — which would both require a
 * reachable MongoDB during `next build` and bake in stale category/product
 * data. Every other storefront route (`/c/[slug]`, `/p/[slug]`, `/search`)
 * is already dynamic by virtue of reading `params`/`searchParams`.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const categories = await listCategories();
  const [topRated, newArrivals] = await Promise.all([
    getTopRatedRail(categories),
    getNewArrivalsRail(categories),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-4 py-8">
      <section aria-labelledby="shop-by-category-heading">
        <h2 id="shop-by-category-heading" className="mb-4 text-xl font-semibold text-slate-900">
          Shop by category
        </h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-5">
          {categories.map((category) => (
            <CategoryTile key={category.slug} category={category} />
          ))}
        </div>
      </section>

      {topRated.length > 0 && (
        <section aria-labelledby="top-rated-heading">
          <h2 id="top-rated-heading" className="mb-4 text-xl font-semibold text-slate-900">
            Top rated
          </h2>
          <ProductGrid products={topRated} variant="rail" />
        </section>
      )}

      {newArrivals.length > 0 && (
        <section aria-labelledby="new-arrivals-heading">
          <h2 id="new-arrivals-heading" className="mb-4 text-xl font-semibold text-slate-900">
            New arrivals
          </h2>
          <ProductGrid products={newArrivals} variant="rail" />
        </section>
      )}
    </div>
  );
}
