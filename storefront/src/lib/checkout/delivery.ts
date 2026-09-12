import { DEFAULT_CURRENCY, type DeliveryMethod } from "@/lib/schemas";

export interface DeliveryOption {
  method: DeliveryMethod;
  label: string;
  description: string;
  /** Integer minor units, in `DEFAULT_CURRENCY` — this storefront trades in one currency (§11.3). */
  cost: number;
}

/**
 * Checkout step 2 ("delivery") chooses one of these; `Order.deliveryMethod`
 * only records *which* the shopper picked (BUILD-DECISIONS.md §11.6) — the
 * price of each option is this feature's to own, so it lives here rather
 * than in the schema.
 */
export const DELIVERY_OPTIONS: Record<DeliveryMethod, DeliveryOption> = {
  standard: {
    method: "standard",
    label: "Standard Shipping",
    description: "5–7 business days",
    cost: 0,
  },
  express: {
    method: "express",
    label: "Express Shipping",
    description: "1–2 business days",
    cost: 999,
  },
};

export const DEFAULT_DELIVERY_METHOD: DeliveryMethod = "standard";

export { DEFAULT_CURRENCY };
