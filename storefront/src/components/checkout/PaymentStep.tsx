import Link from "next/link";

/**
 * Checkout step 3 — Cash on Delivery only, a single pre-selected option.
 * No card fields, no payment provider, no PCI surface (BUILD-DECISIONS.md
 * §6). Nothing here needs to be saved: `createOrder` always defaults
 * `paymentMethod` to `"cod"`, the only value the schema accepts.
 */
export function PaymentStep() {
  return (
    <div className="flex flex-col gap-4">
      <div data-agent-target="payment-options" className="rounded-md border border-slate-900 bg-slate-50 p-4">
        <label className="flex items-center gap-3">
          <input
            type="radio"
            name="paymentMethod"
            value="cod"
            checked
            readOnly
            className="h-4 w-4"
            aria-label="Cash on Delivery"
          />
          <span>
            <span className="block text-sm font-medium text-slate-900">Cash on Delivery</span>
            <span className="block text-xs text-slate-500">
              Pay with cash when your order arrives. No card details needed.
            </span>
          </span>
        </label>
      </div>

      <Link
        href="/checkout/review"
        className="w-full rounded-md bg-amber-400 px-6 py-3 text-center text-sm font-semibold text-slate-900 transition hover:bg-amber-300 sm:w-auto sm:self-end"
      >
        Continue to review
      </Link>
    </div>
  );
}
