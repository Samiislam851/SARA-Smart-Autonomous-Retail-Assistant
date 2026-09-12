"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * Bridges NextCart's server-rendered cart (cookie + DB, no client-fetchable
 * cart JSON route — see agent-storefront/docs/NEXTCART.md "Cart mechanism")
 * to `window.__agentCart`, the shape `agent.js`'s `readCart()` checks first.
 *
 * Reads the `data-agent-cart` JSON attribute `Header.tsx` renders on every
 * page's `<header>` (`{total, items:[{name, variant, quantity, price}]}`,
 * already in major units). Re-reads on:
 *  - mount
 *  - every route pathname change (covers full navigations + the
 *    post-Server-Action re-render triggered by `revalidatePath("/cart")`)
 *  - a 2s poll fallback, matching TrendMerch's bridge cadence
 *
 * Renders nothing.
 */
export function AgentCartBridge() {
  const pathname = usePathname();

  useEffect(() => {
    function syncFromHeader() {
      const header = document.querySelector("header[data-agent-cart]");
      if (!header) return;
      const raw = header.getAttribute("data-agent-cart");
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        (window as unknown as { __agentCart?: unknown }).__agentCart = parsed;
      } catch {
        // Malformed JSON should never throw here — leave __agentCart as-is.
      }
    }

    syncFromHeader();
    const interval = setInterval(syncFromHeader, 2000);
    return () => clearInterval(interval);
  }, [pathname]);

  return null;
}
