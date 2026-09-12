import type { ProductDTO } from "@/lib/db/repositories";
import { ProductCard } from "./ProductCard";

/**
 * Responsive product grid shared by the PLP and search results.
 * `variant="rail"` renders a horizontally-scrolling row (used on the home
 * page); `variant="grid"` (default) wraps into a standard responsive grid.
 */
export function ProductGrid({
  products,
  variant = "grid",
}: {
  products: ProductDTO[];
  variant?: "grid" | "rail";
}) {
  if (variant === "rail") {
    return (
      <ul className="flex snap-x gap-4 overflow-x-auto pb-2">
        {products.map((product) => (
          <li key={product._id} className="w-44 shrink-0 snap-start sm:w-52">
            <ProductCard product={product} sizes="208px" />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {products.map((product) => (
        <li key={product._id}>
          <ProductCard product={product} />
        </li>
      ))}
    </ul>
  );
}
