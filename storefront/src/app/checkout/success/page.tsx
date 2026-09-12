import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getOrderByNumber } from "@/lib/db/repositories";
import { DELIVERY_OPTIONS } from "@/lib/checkout/delivery";
import { formatPrice } from "@/lib/format";

export const metadata: Metadata = { title: "Order placed — NextCart" };

interface PageProps {
  searchParams: Promise<{ order?: string }>;
}

/**
 * Reads the order back by number rather than relying on any transient
 * state — the order number travels in the URL (`?order=...`), so a refresh
 * re-runs this exact lookup and renders identically. Reaching this page
 * without a real order (missing/garbage `order`, or a number that doesn't
 * exist) redirects home instead of ever throwing/500ing.
 */
export default async function CheckoutSuccessPage({ searchParams }: PageProps) {
  const { order: orderNumber } = await searchParams;
  if (!orderNumber) redirect("/");

  const order = await getOrderByNumber(orderNumber);
  if (!order) redirect("/");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-12">
      <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center">
        <h1 className="text-2xl font-bold text-slate-900">Thank you — your order is placed!</h1>
        <p className="mt-2 text-sm text-slate-600">
          Order number <span className="font-semibold">{order.orderNumber}</span>
        </p>
      </div>

      <section className="rounded-md border border-slate-200 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Cash on Delivery</h2>
        <p className="mt-1 text-sm text-slate-600">
          Please have {formatPrice(order.total, order.currency)} ready in cash when your order
          arrives.
        </p>
      </section>

      <section className="rounded-md border border-slate-200 p-4">
        <h2 className="text-sm font-semibold text-slate-900">Delivery method</h2>
        <p className="mt-1 text-sm text-slate-600">{DELIVERY_OPTIONS[order.deliveryMethod].label}</p>
      </section>

      <section className="rounded-md border border-slate-200 p-4">
        <h2 className="mb-3 text-sm font-semibold text-slate-900">Items</h2>
        <ul className="flex flex-col gap-3">
          {order.items.map((item) => (
            <li
              key={`${item.productId}-${JSON.stringify(item.variantSelection)}`}
              className="flex justify-between text-sm"
            >
              <span className="text-slate-600">
                {item.title} × {item.quantity}
              </span>
              <span className="font-medium text-slate-900">
                {formatPrice(item.price * item.quantity, order.currency)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-md border border-slate-200 bg-slate-50 p-4">
        <dl className="flex flex-col gap-1 text-sm text-slate-700">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd>{formatPrice(order.subtotal, order.currency)}</dd>
          </div>
          {order.discount > 0 && (
            <div className="flex justify-between text-emerald-700">
              <dt>Discount{order.promoCode ? ` (${order.promoCode})` : ""}</dt>
              <dd>{formatPrice(-order.discount, order.currency)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt>Shipping</dt>
            <dd>{order.shipping === 0 ? "Free" : formatPrice(order.shipping, order.currency)}</dd>
          </div>
          <div className="mt-2 flex justify-between border-t border-slate-300 pt-2 text-base font-semibold text-slate-900">
            <dt>Total</dt>
            <dd>{formatPrice(order.total, order.currency)}</dd>
          </div>
        </dl>
      </section>

      <Link href="/" className="text-center text-sm font-medium text-blue-700 hover:underline">
        Continue shopping
      </Link>
    </div>
  );
}
