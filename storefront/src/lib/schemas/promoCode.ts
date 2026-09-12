import { z } from "zod";
import {
  MAX_MONEY_MINOR_UNITS,
  moneyMinorUnitsSchema,
  objectIdSchema,
  promoCodeStringSchema,
} from "./common";

/**
 * Feature A (promo codes) — a new collection, not part of any previously
 * locked contract. `percent` discounts a percentage (1-100) of the cart
 * *subtotal only* (never shipping); `fixed` discounts a flat integer count
 * of minor units. See `src/lib/promo/validate.ts` for where that split is
 * actually applied.
 */
export const promoTypeSchema = z.enum(["percent", "fixed"]);
export type PromoType = z.infer<typeof promoTypeSchema>;

/** `expiresAt` is stored/represented as a plain ISO date(-time) string, not a `Date` instance. */
const isoDateStringSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "Must be a valid ISO date");

const promoCodeShape = {
  _id: objectIdSchema,
  code: promoCodeStringSchema,
  type: promoTypeSchema,
  /**
   * For `type: "percent"`: an integer 1-100. For `type: "fixed"`: an
   * integer count of minor units, 1..MAX_MONEY_MINOR_UNITS. Checked by the
   * refinement below, since the valid range depends on `type`.
   */
  value: z.number().int(),
  minSubtotal: moneyMinorUnitsSchema.default(0),
  maxUses: z.number().int().positive().max(1_000_000).optional(),
  usedCount: z.number().int().nonnegative().default(0),
  expiresAt: isoDateStringSchema.optional(),
  isActive: z.boolean(),
  createdAt: z.date(),
};

function valueIsValidForType(data: { type: PromoType; value: number }): boolean {
  if (data.type === "percent") {
    return Number.isInteger(data.value) && data.value >= 1 && data.value <= 100;
  }
  return (
    Number.isInteger(data.value) && data.value >= 1 && data.value <= MAX_MONEY_MINOR_UNITS
  );
}

const valueRefinement: { message: string; path: PropertyKey[] } = {
  message:
    "A percent code's value must be an integer 1-100; a fixed code's value must be a positive integer number of minor units",
  path: ["value"],
};

export const promoCodeSchema = z.object(promoCodeShape).refine(valueIsValidForType, valueRefinement);
export type PromoCode = z.infer<typeof promoCodeSchema>;

/**
 * Shape for creating a promo code — the server assigns `_id`, `createdAt`
 * and `usedCount` (always starts at 0), matching every other `xInputSchema`
 * convention (§11.7: omit `_id` and all server-assigned fields).
 */
const {
  _id: _omittedId,
  createdAt: _omittedCreatedAt,
  usedCount: _omittedUsedCount,
  ...promoCodeInputShape
} = promoCodeShape;

export const promoCodeInputSchema = z
  .object(promoCodeInputShape)
  .refine(valueIsValidForType, valueRefinement);
export type PromoCodeInput = z.infer<typeof promoCodeInputSchema>;
