"use client";

import Link from "next/link";
import PromoBadge from "@/components/PromoBadge";
import { getProduct, type Product } from "@/lib/products";

// "Similar pieces" strip on the product page — the agent's cross-sell
// surface. Renders nothing when the product has no similar slugs.
export default function SimilarProducts({ product }: { product: Product }) {
  const similar = product.similar
    .map((slug) => getProduct(slug))
    .filter((p): p is Product => Boolean(p));

  if (similar.length === 0) return null;

  return (
    <section className="similar-strip" data-agent-target="similar-products">
      <h2>Similar pieces</h2>
      <div className="similar-strip-grid">
        {similar.map((p) => (
          <Link key={p.slug} href={`/product/${p.slug}`} className="product-card similar-card">
            <div className="product-card-image" />
            <div className="product-card-name">{p.name}</div>
            <div className="product-card-price">৳ {p.price.toLocaleString("en-BD")}</div>
            <PromoBadge slug={p.slug} />
          </Link>
        ))}
      </div>
    </section>
  );
}
