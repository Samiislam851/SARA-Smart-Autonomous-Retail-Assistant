"use client";

import Link from "next/link";
import Nav from "@/components/Nav";
import PromoBadge from "@/components/PromoBadge";
import { PRODUCTS } from "@/lib/products";

// Home / listing page. Product detail lives at /product/[slug].
export default function HomePage() {
  return (
    <main className="shop">
      <Nav />

      <section className="products-grid">
        {PRODUCTS.map((p) => (
          <Link
            key={p.slug}
            href={`/product/${p.slug}`}
            className="product-card"
            data-agent-target={`product-card-${p.slug}`}
          >
            <div className="product-card-image" />
            <div className="product-card-name">{p.name}</div>
            <div className="product-card-price">৳ {p.price.toLocaleString("en-BD")}</div>
            <PromoBadge slug={p.slug} />
          </Link>
        ))}
      </section>
    </main>
  );
}
