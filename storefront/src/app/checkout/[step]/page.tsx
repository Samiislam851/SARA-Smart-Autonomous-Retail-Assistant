import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getOrCreateCart } from "@/lib/db/repositories";
import { getCheckoutState } from "@/lib/db/repositories/checkoutState";
import { readCartId } from "@/lib/session/cart";
import { isCheckoutStep, requiredStepFor } from "@/lib/checkout/guard";
import { getCartPromoState } from "@/lib/promo/lookup";
import { AddressForm } from "@/components/checkout/AddressForm";
import { CheckoutSteps } from "@/components/checkout/CheckoutSteps";
import { DeliveryForm } from "@/components/checkout/DeliveryForm";
import { PaymentStep } from "@/components/checkout/PaymentStep";
import { ReviewStep } from "@/components/checkout/ReviewStep";

interface PageProps {
  params: Promise<{ step: string }>;
}

/**
 * Feature A (promo codes): re-validates any code applied on the cart fresh
 * for the review step — never trusts whatever the cart page last computed.
 * Only called for `step === "review"`, so the other 3 steps never pay for a
 * promo lookup they don't render.
 */
async function getReviewPromoProps(
  cart: Awaited<ReturnType<typeof getOrCreateCart>>
): Promise<{ promoCode?: string; discount?: number }> {
  const promoState = await getCartPromoState(cart);
  if (!promoState?.result.valid) return {};
  return { promoCode: promoState.code, discount: promoState.result.discount };
}

const STEP_TITLE: Record<string, string> = {
  address: "Shipping address",
  delivery: "Delivery method",
  payment: "Payment",
  review: "Review your order",
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { step } = await params;
  return { title: `${STEP_TITLE[step] ?? "Checkout"} — NextCart` };
}

/**
 * Step guarding (BUILD-DECISIONS.md's "the thing to get right"): an empty
 * cart bounces to `/cart` from every step, and `requiredStepFor` sends a
 * deep link (e.g. `/checkout/review` with no address) to the earliest
 * incomplete step instead of ever rendering with missing data.
 */
export default async function CheckoutStepPage({ params }: PageProps) {
  const { step } = await params;
  if (!isCheckoutStep(step)) notFound();

  const cartId = await readCartId();
  if (!cartId) redirect("/cart");

  const cart = await getOrCreateCart(cartId);
  if (cart.items.length === 0) redirect("/cart");

  const checkoutState = await getCheckoutState(cartId);
  const hasAddress = Boolean(checkoutState?.address);
  const hasDelivery = Boolean(checkoutState?.deliveryMethod);

  const requiredStep = requiredStepFor(step, hasAddress, hasDelivery);
  if (requiredStep) redirect(`/checkout/${requiredStep}`);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <CheckoutSteps current={step} />
      <h1 className="text-2xl font-bold text-slate-900">{STEP_TITLE[step]}</h1>

      {step === "address" && <AddressForm initialAddress={checkoutState?.address} />}
      {step === "delivery" && <DeliveryForm selected={checkoutState?.deliveryMethod} />}
      {step === "payment" && <PaymentStep />}
      {step === "review" && (
        <ReviewStep
          cart={cart}
          address={checkoutState!.address!}
          deliveryMethod={checkoutState!.deliveryMethod!}
          {...(await getReviewPromoProps(cart))}
        />
      )}
    </div>
  );
}
