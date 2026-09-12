/**
 * The 4 checkout steps, in order. Cart emptiness is NOT one of these checks
 * — an empty cart redirects to `/cart`, which is outside this route
 * entirely; this module only orders the steps once a non-empty cart is
 * established (see `src/app/checkout/[step]/page.tsx`).
 */
export const CHECKOUT_STEPS = ["address", "delivery", "payment", "review"] as const;
export type CheckoutStep = (typeof CHECKOUT_STEPS)[number];

export function isCheckoutStep(value: string): value is CheckoutStep {
  return (CHECKOUT_STEPS as readonly string[]).includes(value);
}

/**
 * Given what checkout state exists so far, returns the step to redirect to
 * if `step` is not yet reachable, or `null` if it is allowed:
 *
 * - `delivery` requires an address.
 * - `payment` and `review` require both an address and a delivery method.
 *
 * This is what stops a deep link to `/checkout/review` (or `/checkout/
 * payment`) from ever rendering with missing data — it always sends the
 * shopper to the earliest step they haven't completed instead.
 */
export function requiredStepFor(
  step: CheckoutStep,
  hasAddress: boolean,
  hasDelivery: boolean
): CheckoutStep | null {
  if (!hasAddress && step !== "address") return "address";
  if (!hasDelivery && (step === "payment" || step === "review")) return "delivery";
  return null;
}
