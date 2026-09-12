import Link from "next/link";

/**
 * PDP shipping/returns disclosure. A native `<details>`/`<summary>` pair is
 * keyboard-operable and screen-reader friendly with zero JavaScript, so
 * this stays a Server Component — no client boundary needed for an
 * accordion this simple.
 */
export function ShippingAccordion() {
  return (
    <details className="group rounded-lg border border-slate-200">
      <summary
        data-agent-target="shipping-info"
        className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium text-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
      >
        Shipping &amp; returns
        <span aria-hidden="true" className="text-slate-400 transition group-open:rotate-180">
          ⌄
        </span>
      </summary>
      <div className="border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
        <p>
          Free standard shipping on eligible orders, with express delivery
          available at checkout. See the{" "}
          <Link href="/policies/shipping" className="text-blue-700 hover:underline">
            shipping policy
          </Link>{" "}
          for delivery estimates.
        </p>
        <p className="mt-2">
          Most items can be returned within 30 days of delivery. Read the{" "}
          <Link href="/policies/returns" className="text-blue-700 hover:underline">
            returns policy
          </Link>{" "}
          for full details and exclusions.
        </p>
      </div>
    </details>
  );
}
