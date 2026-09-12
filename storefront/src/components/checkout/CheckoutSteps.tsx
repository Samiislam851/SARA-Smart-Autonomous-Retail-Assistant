import { CHECKOUT_STEPS, type CheckoutStep } from "@/lib/checkout/guard";

const LABELS: Record<CheckoutStep, string> = {
  address: "Address",
  delivery: "Delivery",
  payment: "Payment",
  review: "Review",
};

/** Checkout progress breadcrumb — purely presentational, no navigation of its own (steps are gated server-side). */
export function CheckoutSteps({ current }: { current: CheckoutStep }) {
  const currentIndex = CHECKOUT_STEPS.indexOf(current);

  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-label="Checkout steps">
      {CHECKOUT_STEPS.map((step, index) => (
        <li key={step} className="flex items-center gap-2">
          <span
            aria-current={step === current ? "step" : undefined}
            className={`rounded-full px-3 py-1 font-medium ${
              index < currentIndex
                ? "bg-slate-200 text-slate-600"
                : index === currentIndex
                  ? "bg-slate-900 text-white"
                  : "bg-slate-100 text-slate-400"
            }`}
          >
            {index + 1}. {LABELS[step]}
          </span>
          {index < CHECKOUT_STEPS.length - 1 && (
            <span aria-hidden="true" className="text-slate-300">
              ›
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
