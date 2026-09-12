import Image from "next/image";
import Link from "next/link";
import type { ProductDTO } from "@/lib/db/repositories";
import { formatPrice } from "@/lib/format";
import { StarRating } from "./StarRating";

/**
 * Shared product card — used on the PLP, search results, home rails and
 * the PDP's related-products rail. A `sizes` string tuned to the grid it
 * renders in should be passed by the caller; it defaults to a sane guess
 * for a 2/3/4/6-column responsive grid.
 */
export function ProductCard({
  product,
  sizes = "(max-width: 480px) 50vw, (max-width: 768px) 33vw, (max-width: 1280px) 25vw, 200px",
  priority = false,
}: {
  product: ProductDTO;
  sizes?: string;
  priority?: boolean;
}) {
  const outOfStock = product.stock <= 0;

  return (
    <Link
      href={`/p/${product.slug}`}
      className="group flex h-full flex-col rounded-lg border border-slate-200 bg-white p-3 transition hover:border-slate-300 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
    >
      <div className="relative aspect-square w-full overflow-hidden rounded-md bg-slate-100">
        <Image
          src={product.images[0]}
          alt={product.title}
          fill
          sizes={sizes}
          priority={priority}
          className="object-cover transition group-hover:scale-105"
        />
        {outOfStock && (
          <span className="absolute left-2 top-2 rounded bg-slate-900/90 px-2 py-0.5 text-xs font-semibold text-white">
            Out of stock
          </span>
        )}
      </div>

      <div className="mt-3 flex flex-1 flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          {product.brand}
        </p>
        <h3 className="line-clamp-2 text-sm font-medium text-slate-800 group-hover:text-blue-700">
          {product.title}
        </h3>
        <StarRating rating={product.rating} reviewCount={product.reviewCount} />
        <div className="mt-auto flex items-baseline justify-between pt-2">
          <span className="text-lg font-semibold text-slate-900">
            {formatPrice(product.price, product.currency)}
          </span>
          {outOfStock && (
            <span className="text-xs font-medium text-red-600">Unavailable</span>
          )}
        </div>
      </div>
    </Link>
  );
}
