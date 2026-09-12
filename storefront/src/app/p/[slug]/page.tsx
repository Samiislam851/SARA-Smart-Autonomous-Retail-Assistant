import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getProductBySlug, getRelatedProducts } from "@/lib/db/repositories";
import { formatPrice } from "@/lib/format";
import { Gallery } from "@/components/product/Gallery";
import { StarRating } from "@/components/product/StarRating";
import { ProductOptions } from "@/components/product/ProductOptions";
import { ShippingAccordion } from "@/components/product/ShippingAccordion";
import { ProductGrid } from "@/components/product/ProductGrid";
// ⚠️ UNCOMMITTED PROTOTYPE — REHEARSAL ONLY, NEVER COMMITTED. Intentionally
// crosses BUILD-DECISIONS.md §0. See src/lib/agent-mock/bus.ts. Mounted only
// on this page; renders nothing until a chat command arrives.
import { PdpAgentMockListener } from "@/components/agent-mock/PdpAgentMockListener";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  return { title: product ? `${product.title} — NextCart` : "NextCart" };
}

export default async function ProductPage({ params }: PageProps) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();

  const related = await getRelatedProducts(product, 8);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-10 px-4 py-8">
      <PdpAgentMockListener />
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        <Gallery images={product.images} title={product.title} />

        <div className="flex flex-col gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {product.brand}
            </p>
            <h1 data-agent-target="product-title" className="mt-1 text-2xl font-bold text-slate-900">
              {product.title}
            </h1>
          </div>

          <StarRating rating={product.rating} reviewCount={product.reviewCount} size="md" />

          <p data-agent-target="price" className="text-3xl font-semibold text-slate-900">
            {formatPrice(product.price, product.currency)}
          </p>

          {product.description && (
            <p className="text-sm leading-relaxed text-slate-600">{product.description}</p>
          )}

          <div className="border-t border-slate-200 pt-4">
            <ProductOptions
              productId={product._id}
              slug={product.slug}
              title={product.title}
              price={product.price}
              imagePath={product.images[0]}
              variants={product.variants}
              stock={product.stock}
            />
          </div>

          <ShippingAccordion />
        </div>
      </div>

      {related.length > 0 && (
        <section aria-labelledby="related-products-heading">
          <h2 id="related-products-heading" className="mb-4 text-xl font-semibold text-slate-900">
            Related products
          </h2>
          <ProductGrid products={related} variant="rail" />
        </section>
      )}
    </div>
  );
}
