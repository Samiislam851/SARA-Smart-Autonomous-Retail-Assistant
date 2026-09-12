import Image from "next/image";
import Link from "next/link";
import { placeOrderAction } from "@/app/checkout/actions";
import { DELIVERY_OPTIONS } from "@/lib/checkout/delivery";
import type { CartWithTotals } from "@/lib/db/repositories";
import { formatPrice } from "@/lib/format";
import { computeOrderTotal, type Address, type DeliveryMethod } from "@/lib/schemas";

export function ReviewStep({
  cart,
  address,
  deliveryMethod,
  promoCode,
  discount = 0,
}: {
  cart: CartWithTotals;
  address: Address;
  deliveryMethod: DeliveryMethod;
  /**
   * Feature A (promo codes). Computed by the caller (`[step]/page.tsx`) via
   * `getCartPromoState` — freshly re-validated against `cart.subtotal`, not
   * trusted from anywhere else. `undefined`/`0` renders exactly like the
   * pre-promo-codes review step.
   */
  promoCode?: string;
  discount?: number;
}) {
  const shipping = DELIVERY_OPTIONS[deliveryMethod].cost;
  const total = computeOrderTotal(cart.subtotal, shipping, discount);

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="review-address-heading" className="rounded-md border border-slate-200 p-4">
        <div className="flex items-center justify-between">
          <h2 id="review-address-heading" className="text-sm font-semibold text-slate-900">
            Shipping address
          </h2>
          <Link href="/checkout/address" className="text-sm text-blue-700 hover:underline">
            Edit
          </Link>
        </div>
        <address className="mt-2 flex flex-col text-sm not-italic text-slate-600">
          <span className="font-medium text-slate-900">{address.fullName}</span>
          <span>
            {address.line1}
            {address.line2 ? `, ${address.line2}` : ""}
          </span>
          <span>
            {address.city}, {address.state} {address.postalCode}
          </span>
          <span>{address.country}</span>
          <span>{address.phone}</span>
        </address>
      </section>

      <section aria-labelledby="review-delivery-heading" className="rounded-md border border-slate-200 p-4">
        <div className="flex items-center justify-between">
          <h2 id="review-delivery-heading" className="text-sm font-semibold text-slate-900">
            Delivery method
          </h2>
          <Link href="/checkout/delivery" className="text-sm text-blue-700 hover:underline">
            Edit
          </Link>
        </div>
        <p className="mt-2 text-sm text-slate-600">
          {DELIVERY_OPTIONS[deliveryMethod].label} —{" "}
          {shipping === 0 ? "Free" : formatPrice(shipping, cart.currency)}
        </p>
      </section>

      <section aria-labelledby="review-payment-heading" className="rounded-md border border-slate-200 p-4">
        <h2 id="review-payment-heading" className="text-sm font-semibold text-slate-900">
          Payment method
        </h2>
        <p className="mt-2 text-sm text-slate-600">Cash on Delivery</p>
      </section>

      <section aria-labelledby="review-items-heading" className="rounded-md border border-slate-200 p-4">
        <h2 id="review-items-heading" className="mb-3 text-sm font-semibold text-slate-900">
          Items ({cart.items.length})
        </h2>
        <ul className="flex flex-col gap-4">
          {cart.items.map((item) => {
            const variantEntries = Object.entries(item.variantSelection);
            return (
              <li
                key={`${item.productId}-${JSON.stringify(item.variantSelection)}`}
                className="flex gap-3"
              >
                <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-md bg-slate-100">
                  <Image src={item.imagePath} alt="" fill sizes="64px" className="object-cover" />
                </div>
                <div className="flex-1 text-sm">
                  <p className="font-medium text-slate-900">{item.title}</p>
                  {variantEntries.length > 0 && (
                    <p className="text-slate-500">
                      {variantEntries.map(([key, value]) => `${key}: ${value}`).join(", ")}
                    </p>
                  )}
                  <p className="text-slate-500">Qty {item.quantity}</p>
                </div>
                <p className="shrink-0 text-sm font-medium text-slate-900">
                  {formatPrice(item.price * item.quantity, cart.currency)}
                </p>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="review-summary-heading" className="rounded-md border border-slate-200 bg-slate-50 p-4">
        <h2 id="review-summary-heading" className="sr-only">
          Order summary
        </h2>
        <dl className="flex flex-col gap-1 text-sm text-slate-700">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd>{formatPrice(cart.subtotal, cart.currency)}</dd>
          </div>
          {discount > 0 && (
            <div className="flex justify-between text-emerald-700">
              <dt>Discount{promoCode ? ` (${promoCode})` : ""}</dt>
              <dd>{formatPrice(-discount, cart.currency)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt>Shipping</dt>
            <dd>{shipping === 0 ? "Free" : formatPrice(shipping, cart.currency)}</dd>
          </div>
          <div className="mt-2 flex justify-between border-t border-slate-300 pt-2 text-base font-semibold text-slate-900">
            <dt>Total</dt>
            <dd data-agent-target="checkout-total">{formatPrice(total, cart.currency)}</dd>
          </div>
        </dl>
      </section>

      <form action={placeOrderAction}>
        <button
          type="submit"
          data-agent-target="place-order"
          className="w-full rounded-md bg-amber-400 px-6 py-3 text-sm font-semibold text-slate-900 transition hover:bg-amber-300"
        >
          Place your order (Cash on Delivery)
        </button>
      </form>
    </div>
  );
}
