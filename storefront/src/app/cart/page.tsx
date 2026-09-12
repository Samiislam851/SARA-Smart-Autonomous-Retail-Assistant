import Link from "next/link";
import type { Metadata } from "next";
import { getOrCreateCart } from "@/lib/db/repositories";
import { readCartId } from "@/lib/session/cart";
import { DEFAULT_DELIVERY_METHOD, DELIVERY_OPTIONS } from "@/lib/checkout/delivery";
import { computeOrderTotal, DEFAULT_CURRENCY } from "@/lib/schemas";
import { formatPrice } from "@/lib/format";
import { getCartPromoState } from "@/lib/promo/lookup";
import { PROMO_ERROR_MESSAGES } from "@/lib/promo/validate";
import { CartLineItem } from "@/components/cart/CartLineItem";
import { PromoCodeForm } from "@/components/cart/PromoCodeForm";
import { removePromoCodeAction } from "./actions";
// ⚠️ UNCOMMITTED PROTOTYPE — REHEARSAL ONLY, NEVER COMMITTED. Intentionally
// crosses BUILD-DECISIONS.md §0. See src/lib/agent-mock/bus.ts. Mounted only
// on this page; renders nothing itself.
import { AgentMockListener } from "@/components/agent-mock/AgentMockListener";

export const metadata: Metadata = { title: "Cart — NextCart" };

interface PageProps {
  searchParams: Promise<{ promoRemoved?: string }>;
}

export default async function CartPage({ searchParams }: PageProps) {
  const { promoRemoved } = await searchParams;
  // Read-only: viewing the cart never creates the cart cookie.
  const cartId = await readCartId();
  const cart = cartId ? await getOrCreateCart(cartId) : null;
  const items = cart?.items ?? [];

  if (items.length === 0) {
    return (
      <>
        <AgentMockListener />
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-4 px-4 py-20 text-center">
          <h1 className="text-2xl font-bold text-slate-900">Your NextCart cart is empty</h1>
          <p className="text-slate-600">Looks like you haven&apos;t added anything yet.</p>
          <Link
            href="/"
            className="rounded-md bg-amber-400 px-6 py-3 text-sm font-semibold text-slate-900 transition hover:bg-amber-300"
          >
            Continue shopping
          </Link>
        </div>
      </>
    );
  }

  const currency = cart?.currency ?? DEFAULT_CURRENCY;
  // The cart page shows an estimate using the standard (default) delivery
  // rate — the real shipping cost is chosen and recomputed at checkout step
  // 2 ("delivery"), once a method is actually picked. See
  // BUILD-DECISIONS.md §11.13.
  const shippingEstimate = DELIVERY_OPTIONS[DEFAULT_DELIVERY_METHOD].cost;
  const subtotal = cart!.subtotal;
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  // Feature A (promo codes): re-validated fresh on every render — never
  // trusts that the code was still good the moment it was applied. See
  // `src/lib/promo/lookup.ts`.
  const promoState = await getCartPromoState(cart!);
  const discount = promoState?.result.valid ? promoState.result.discount : 0;
  const total = computeOrderTotal(subtotal, shippingEstimate, discount);

  return (
    <>
      <AgentMockListener />
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 lg:flex-row lg:items-start">
      <div className="flex flex-1 flex-col gap-4">
        <h1 className="text-2xl font-bold text-slate-900">Shopping Cart</h1>
        {promoRemoved === "1" && (
          <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            Your promo code was removed because it&apos;s no longer valid. You can check out at
            full price, or apply a different code below.
          </p>
        )}
        <ul data-agent-target="cart-items" className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {items.map((item) => (
            <CartLineItem
              key={`${item.productId}-${JSON.stringify(item.variantSelection)}`}
              item={item}
              currency={currency}
            />
          ))}
        </ul>
      </div>

      <aside className="w-full shrink-0 rounded-lg border border-slate-200 bg-slate-50 p-5 lg:w-80">
        <h2 className="sr-only">Order summary</h2>
        <dl className="flex flex-col gap-2 text-sm text-slate-700">
          <div className="flex justify-between">
            <dt>
              Subtotal ({itemCount} item{itemCount === 1 ? "" : "s"})
            </dt>
            <dd>{formatPrice(subtotal, currency)}</dd>
          </div>
          {promoState?.result.valid && (
            <div className="flex justify-between text-emerald-700">
              <dt>Discount ({promoState.code})</dt>
              <dd>{formatPrice(-promoState.result.discount, currency)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt>Shipping (estimated)</dt>
            <dd>{shippingEstimate === 0 ? "Free" : formatPrice(shippingEstimate, currency)}</dd>
          </div>
          <div className="mt-2 flex justify-between border-t border-slate-300 pt-2 text-base font-semibold text-slate-900">
            <dt>Total</dt>
            <dd data-agent-target="cart-total">{formatPrice(total, currency)}</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-slate-500">
          Shipping shown is the standard rate; choose express delivery at checkout if you need it sooner.
        </p>

        {promoState ? (
          <div className="mt-4 border-t border-slate-200 pt-4">
            {promoState.result.valid ? (
              <p className="text-sm text-emerald-700">
                Promo code <span className="font-semibold">{promoState.code}</span> applied.
              </p>
            ) : (
              <p role="alert" className="text-sm text-red-600">
                Promo code <span className="font-semibold">{promoState.code}</span>:{" "}
                {PROMO_ERROR_MESSAGES[promoState.result.reason]}
              </p>
            )}
            <form action={removePromoCodeAction} className="mt-2">
              <button
                type="submit"
                className="text-sm font-medium text-blue-700 hover:underline"
              >
                Remove code
              </button>
            </form>
          </div>
        ) : (
          <PromoCodeForm />
        )}

        <Link
          href="/checkout/address"
          data-agent-target="begin-checkout"
          className="mt-4 block rounded-md bg-amber-400 px-6 py-3 text-center text-sm font-semibold text-slate-900 transition hover:bg-amber-300"
        >
          Proceed to checkout
        </Link>
      </aside>
      </div>
    </>
  );
}
