"use server";

import { revalidatePath } from "next/cache";
import { createPromoCode, setPromoCodeActive } from "@/lib/db/repositories";
import { promoCodeInputSchema, DEFAULT_CURRENCY } from "@/lib/schemas";
import { parsePriceToMinorUnits } from "@/lib/money";
import {
  EMPTY_PROMO_CODE_FORM_VALUES,
  type PromoCodeFormState,
  type PromoCodeFormValues,
} from "./promo-code-form";

export type { PromoCodeFormState, PromoCodeFormValues };

/**
 * Admin promo-code create. `value` means different things depending on
 * `type` — an integer percent (1-100) or a decimal money amount — so it's
 * parsed differently before either one becomes the same integer `value`
 * field `promoCodeInputSchema` expects. Money parsing goes through
 * `parsePriceToMinorUnits` (never `Number(x) * 100` — see `lib/money.ts`'s
 * note on why float multiplication is unsafe for money).
 */
export async function createPromoCodeFormAction(
  _prevState: PromoCodeFormState,
  formData: FormData
): Promise<PromoCodeFormState> {
  const code = String(formData.get("code") ?? "").trim().toUpperCase();
  const typeRaw = String(formData.get("type") ?? "percent");
  const type = typeRaw === "fixed" ? "fixed" : "percent";
  const valueRaw = String(formData.get("value") ?? "").trim();
  const minSubtotalRaw = String(formData.get("minSubtotal") ?? "0").trim();
  const maxUsesRaw = String(formData.get("maxUses") ?? "").trim();
  const expiresAtRaw = String(formData.get("expiresAt") ?? "").trim();
  const isActive = formData.get("isActive") === "on";

  const values: PromoCodeFormValues = {
    code,
    type,
    value: valueRaw,
    minSubtotal: minSubtotalRaw,
    maxUses: maxUsesRaw,
    expiresAt: expiresAtRaw,
    isActive,
  };

  const errors: Record<string, string> = {};

  if (!code) errors.code = "Code is required.";

  let value: number | null = null;
  if (type === "percent") {
    const n = Number(valueRaw);
    if (!valueRaw || !Number.isInteger(n) || n < 1 || n > 100) {
      errors.value = "Enter a whole percent from 1 to 100.";
    } else {
      value = n;
    }
  } else {
    const minor = parsePriceToMinorUnits(valueRaw, DEFAULT_CURRENCY);
    if (minor === null || minor < 1) {
      errors.value = "Enter a valid amount (e.g. 10.00).";
    } else {
      value = minor;
    }
  }

  const minSubtotal = parsePriceToMinorUnits(minSubtotalRaw || "0", DEFAULT_CURRENCY);
  if (minSubtotal === null) {
    errors.minSubtotal = "Enter a valid amount (e.g. 0 or 50.00).";
  }

  let maxUses: number | undefined;
  if (maxUsesRaw) {
    const n = Number(maxUsesRaw);
    if (!Number.isInteger(n) || n < 1) {
      errors.maxUses = "Enter a positive whole number, or leave blank for unlimited.";
    } else {
      maxUses = n;
    }
  }

  let expiresAt: string | undefined;
  if (expiresAtRaw) {
    if (Number.isNaN(Date.parse(expiresAtRaw))) {
      errors.expiresAt = "Enter a valid date.";
    } else {
      expiresAt = new Date(expiresAtRaw).toISOString();
    }
  }

  if (Object.keys(errors).length > 0) {
    return { errors, values };
  }

  const candidate = {
    code,
    type,
    value: value ?? 0,
    minSubtotal: minSubtotal ?? 0,
    ...(maxUses !== undefined ? { maxUses } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    isActive,
  };

  const parsed = promoCodeInputSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.length > 0 ? issue.path.join(".") : "form";
      if (!errors[key]) errors[key] = issue.message;
    }
    return { errors, values };
  }

  try {
    await createPromoCode(parsed.data);
  } catch (error) {
    return {
      errors: { form: error instanceof Error ? error.message : "Failed to create promo code." },
      values,
    };
  }

  revalidatePath("/admin/promo-codes");
  return { errors: {}, values: EMPTY_PROMO_CODE_FORM_VALUES };
}

/** The list page's active/inactive toggle — mirrors `toggleProductActiveAction`. */
export async function togglePromoCodeActiveAction(id: string, nextIsActive: boolean): Promise<void> {
  await setPromoCodeActive(id, nextIsActive);
  revalidatePath("/admin/promo-codes");
}
