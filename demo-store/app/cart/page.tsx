"use client";

import { useState } from "react";
import Link from "next/link";
import Nav from "@/components/Nav";
import {
  applyPromo,
  cartTotal,
  clearPromo,
  totalPromoDiscount,
  useCart,
  useHydrated,
  usePromos,
} from "@/lib/cart";

const FREE_DELIVERY_THRESHOLD = 2000;

export default function CartPage() {
  const hydrated = useHydrated();
  const items = useCart();
  const applied = usePromos();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const subtotal = cartTotal(items);
  const discount = totalPromoDiscount(applied);
  const total = Math.max(0, subtotal - discount);
  const gap = Math.max(0, FREE_DELIVERY_THRESHOLD - total);

  function handleApply() {
    const result = applyPromo(code);
    if (result.ok) {
      setError(null);
      setCode("");
    } else {
      setError(result.error);
    }
  }

  return (
    <main className="shop">
      <Nav />

      <section className="cart-page">
        <h1>Your cart</h1>

        <div className="cart-items" data-agent-target="cart-items">
          {!hydrated ? (
            <p className="cart-loading">Loading cart…</p>
          ) : (
            <>
              {items.length === 0 && <p className="cart-empty">Cart is empty.</p>}
              {items.map((i) => (
                <div key={i.sku} className="cart-line">
                  <span>{i.name}</span>
                  <span>x{i.qty}</span>
                  <span>৳ {(i.price * i.qty).toLocaleString("en-BD")}</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="promo-code-row" data-agent-target="promo-code">
          <input
            type="text"
            placeholder="Promo code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            aria-label="Promo code"
          />
          <button className="add-to-cart" onClick={handleApply} disabled={!code.trim()}>
            Apply
          </button>
        </div>
        {error && <p className="promo-error">{error}</p>}

        {hydrated &&
          applied.map((p) => (
            <div key={p.promo.id} className="cart-line promo-applied-line">
              <span>
                {p.auto
                  ? `${p.promo.id.toUpperCase()} applied automatically`
                  : `${p.promo.code} applied`}
              </span>
              <span>&minus; ৳ {p.discount.toLocaleString("en-BD")}</span>
              {!p.auto && (
                <button className="promo-remove" onClick={clearPromo} aria-label="Remove promo code">
                  Remove
                </button>
              )}
            </div>
          ))}

        <div className="cart-total" data-agent-target="cart-total">
          {hydrated ? `Total: ৳ ${total.toLocaleString("en-BD")}` : "Total: —"}
        </div>

        <div className="shipping" data-agent-target="shipping-banner">
          {!hydrated
            ? ""
            : gap > 0
              ? `৳ ${gap} more for free Dhaka delivery.`
              : "Free Dhaka delivery unlocked."}
        </div>

        <Link href="/checkout" className="add-to-cart checkout-btn" data-agent-target="checkout-btn">
          Proceed to checkout
        </Link>
      </section>
    </main>
  );
}
