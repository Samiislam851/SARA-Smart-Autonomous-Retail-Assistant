/**
 * Types and plain (non-async) helpers shared between `actions.ts` (a
 * `"use server"` file — which may only export async functions, see
 * `src/app/admin/products/product-form.ts`'s identical note) and
 * `src/components/admin/PromoCodeForm.tsx`.
 */

export interface PromoCodeFormValues {
  code: string;
  type: "percent" | "fixed";
  /** Human-entered string: a plain integer (percent) or a decimal price (fixed) — never the parsed number. */
  value: string;
  /** Decimal price string, e.g. "0" or "50.00". */
  minSubtotal: string;
  /** Empty string means "unlimited". */
  maxUses: string;
  /** `<input type="date">` value (`YYYY-MM-DD`), or empty for "never expires". */
  expiresAt: string;
  isActive: boolean;
}

export interface PromoCodeFormState {
  errors: Record<string, string>;
  values: PromoCodeFormValues;
}

export const EMPTY_PROMO_CODE_FORM_VALUES: PromoCodeFormValues = {
  code: "",
  type: "percent",
  value: "",
  minSubtotal: "0",
  maxUses: "",
  expiresAt: "",
  isActive: true,
};
