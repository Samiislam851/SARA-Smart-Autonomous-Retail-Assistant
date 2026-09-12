"use client";

import { useState } from "react";
import Nav from "@/components/Nav";
import { cartTotal, totalPromoDiscount, useCart, useHydrated, usePromos } from "@/lib/cart";

export default function CheckoutPage() {
  const [placed, setPlaced] = useState(false);
  const hydrated = useHydrated();
  const items = useCart();
  const applied = usePromos();

  const subtotal = cartTotal(items);
  const discount = totalPromoDiscount(applied);
  const total = Math.max(0, subtotal - discount);

  return (
    <main className="shop">
      <Nav />

      <section className="checkout-page">
        <h1>Checkout</h1>

        <form className="address-form" data-agent-target="address-form" onSubmit={(e) => e.preventDefault()}>
          <label>Full name<input type="text" required /></label>
          <label>Address<input type="text" required /></label>
          <label>City<input type="text" defaultValue="Dhaka" required /></label>
          <label>Phone<input type="tel" required /></label>
        </form>

        <div className="payment-options" data-agent-target="payment-options">
          <label><input type="radio" name="payment" defaultChecked /> Cash on delivery</label>
          <label><input type="radio" name="payment" /> bKash</label>
          <label><input type="radio" name="payment" /> Card</label>
        </div>

        {hydrated &&
          applied.map((p) => (
            <div key={p.promo.id} className="cart-line promo-applied-line">
              <span>
                {p.auto
                  ? `${p.promo.id.toUpperCase()} applied automatically`
                  : `${p.promo.code} applied`}
              </span>
              <span>&minus; ৳ {p.discount.toLocaleString("en-BD")}</span>
            </div>
          ))}

        <div className="cart-total" data-agent-target="checkout-total">
          {hydrated ? `Total: ৳ ${total.toLocaleString("en-BD")}` : "Total: —"}
        </div>

        <button className="add-to-cart" data-agent-target="place-order" onClick={() => setPlaced(true)}>
          {placed ? "Order placed" : "Place order"}
        </button>
      </section>
    </main>
  );
}
