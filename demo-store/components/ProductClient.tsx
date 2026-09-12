"use client";

import { useState } from "react";
import Nav from "@/components/Nav";
import PromoBadge from "@/components/PromoBadge";
import SimilarProducts from "@/components/SimilarProducts";
import { addToCart } from "@/lib/cart";
import { discountedUnitPrice, findPromoForSlug } from "@/lib/promos";
import type { Product } from "@/lib/products";

// Product detail. Every hotspot the agent may act on carries data-agent-target.
export default function ProductClient({ product }: { product: Product }) {
  const [size, setSize] = useState<string | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const [added, setAdded] = useState(false);

  const needsSize = Boolean(product.sizes);
  const canAdd = !needsSize || Boolean(size);
  const promo = findPromoForSlug(product.slug);

  return (
    <main className="shop">
      <Nav />

      <section className="product">
        <div className="product-image" data-agent-target="product-image" />

        <div>
          <h1>{product.name}</h1>
          <p className="price">
            {promo && promo.auto_apply ? (
              <>
                <span className="price-strike">৳ {product.price.toLocaleString("en-BD")}</span>{" "}
                ৳ {discountedUnitPrice(promo, product.price).toLocaleString("en-BD")}
              </>
            ) : (
              <>৳ {product.price.toLocaleString("en-BD")}</>
            )}
          </p>
          <PromoBadge slug={product.slug} />
          <p className="desc">{product.desc}</p>

          {needsSize && (
            <div className="sizes" data-agent-target="size-picker">
              {product.sizes!.map((s) => (
                <button key={s} aria-pressed={size === s} onClick={() => setSize(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}

          <button className="size-guide" data-agent-target="size-guide" onClick={() => setGuideOpen(true)}>
            Size guide
          </button>

          <button
            className="add-to-cart"
            data-agent-target="cart-add"
            disabled={!canAdd}
            onClick={() => {
              addToCart(product.slug, product.name, product.price, 1);
              setAdded(true);
            }}
          >
            {added ? "Added" : canAdd ? "Add to cart" : "Pick a size"}
          </button>

          <div className="shipping" data-agent-target="shipping-banner">
            Free delivery in Dhaka on orders over ৳ 2,000. Elsewhere ৳ 120.
          </div>
        </div>
      </section>

      <SimilarProducts product={product} />

      {guideOpen && (
        <div className="size-modal" onClick={() => setGuideOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} data-agent-target="size-chart">
            <strong>Size guide</strong>
            <table>
              <thead>
                <tr>
                  <th>Size</th>
                  <th>Chest</th>
                  <th>Shoulder</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>S</td><td>96 cm</td><td>42 cm</td></tr>
                <tr><td>M</td><td>102 cm</td><td>44 cm</td></tr>
                <tr><td>L</td><td>108 cm</td><td>46 cm</td></tr>
                <tr><td>XL</td><td>114 cm</td><td>48 cm</td></tr>
              </tbody>
            </table>
            <button className="add-to-cart" onClick={() => setGuideOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </main>
  );
}
