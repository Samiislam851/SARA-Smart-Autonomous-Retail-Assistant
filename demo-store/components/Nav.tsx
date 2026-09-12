"use client";

import Link from "next/link";
import { cartCount, useCart, useHydrated } from "@/lib/cart";

// Shared nav across all pages. Carries the two nav-level agent targets:
// a search box (data-agent-target="search") and the cart link
// (data-agent-target="cart-link").
export default function Nav() {
  const hydrated = useHydrated();
  const items = useCart();
  // Before hydration the real count is unknown (sessionStorage-backed) —
  // don't assert "(0)" only to flip a moment later; omit the count instead.
  const count = hydrated ? cartCount(items) : null;

  return (
    <nav className="shop-nav">
      <Link href="/" className="shop-nav-brand">
        <strong>Dokan</strong>
      </Link>
      <input
        type="search"
        className="nav-search"
        placeholder="Search products"
        aria-label="Search products"
        data-agent-target="search"
      />
      <Link href="/cart" data-agent-target="cart-link">
        Cart{count != null ? ` (${count})` : ""}
      </Link>
      {process.env.NEXT_PUBLIC_AGENT_RESEARCH_LINK !== "0" && (
        <Link href="/sessions">Research</Link>
      )}
    </nav>
  );
}
