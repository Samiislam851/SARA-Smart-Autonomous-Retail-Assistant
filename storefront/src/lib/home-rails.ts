import {
  listProductsByCategory,
  type CategoryDTO,
  type ProductDTO,
  type ProductSortOption,
} from "@/lib/db/repositories";

/**
 * Home page rails ("Top rated", "New arrivals") are sitewide, but the
 * repository layer only exposes per-category listing (`listProductsByCategory`
 * — BUILD-DECISIONS §4/§11 name it explicitly for the PLP, and there is no
 * separate "list all products" storefront query to add without touching a
 * verified repository contract). Composing a sitewide rail from a few
 * products per category, drawn from every category, using the existing
 * function is the read-only way to do that.
 */
async function buildRail(
  categories: CategoryDTO[],
  sort: ProductSortOption,
  perCategory: number,
  limit: number
): Promise<ProductDTO[]> {
  const perCategoryResults = await Promise.all(
    categories.map((category) => listProductsByCategory(category.slug, { sort }))
  );
  const items = perCategoryResults.flatMap((result) => result.items.slice(0, perCategory));
  return items.slice(0, limit);
}

export function getTopRatedRail(
  categories: CategoryDTO[],
  limit = 10
): Promise<ProductDTO[]> {
  return buildRail(categories, "rating", 2, limit);
}

export function getNewArrivalsRail(
  categories: CategoryDTO[],
  limit = 10
): Promise<ProductDTO[]> {
  return buildRail(categories, "newest", 2, limit);
}
