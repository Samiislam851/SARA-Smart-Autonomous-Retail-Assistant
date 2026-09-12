import { z } from "zod";

/**
 * Mongo ObjectId represented as its 24-char hex string.
 * We validate/pass ids as strings at every API/schema boundary and only
 * convert to a driver `ObjectId` inside the `lib/db/` repositories.
 */
export const objectIdSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "Must be a 24-character hex ObjectId");
export type ObjectIdString = z.infer<typeof objectIdSchema>;

/**
 * URL-safe slug: lowercase letters, numbers and hyphens, no leading/trailing
 * hyphen. Used as the unique human-readable key for categories and products.
 */
export const slugSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Must be a lowercase, hyphenated slug");

/**
 * Money is always stored as an integer count of the currency's minor unit
 * (e.g. cents for USD). Never store or operate on money as a float.
 *
 * `.finite()` matters as much as `.int()`: `Infinity` and `NaN` both slip
 * past a bare `.nonnegative()` check, and `Number.isInteger(Infinity)` is
 * false but the error message would be confusing. `.max()` caps a single
 * amount below `Number.MAX_SAFE_INTEGER` so summing a cart can never lose
 * precision.
 */
export const MAX_MONEY_MINOR_UNITS = 1_000_000_000_00; // 1e11 minor units

export const moneyMinorUnitsSchema = z
  .number()
  .finite("Money must be a finite number")
  .int("Money must be an integer number of minor units (e.g. cents)")
  .nonnegative("Money cannot be negative")
  .max(MAX_MONEY_MINOR_UNITS, "Money amount is implausibly large");

/** ISO 4217-style 3-letter currency code, e.g. "USD". */
export const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, "Currency must be a 3-letter uppercase ISO 4217 code");

/**
 * The single currency this storefront trades in. Carts and orders carry a
 * currency field so a stored order renders correctly forever, but every
 * document we create uses this value — mixed-currency carts are not a thing.
 */
export const DEFAULT_CURRENCY = "USD";

/**
 * A product/category image as stored in Mongo: a **relative web path** under
 * `/products/`, never a filesystem path. BUILD-DECISIONS.md §8 requires this;
 * this schema is where it is actually enforced rather than merely documented.
 *
 * Accepts `/products/seed/...` (committed seed images) and
 * `/products/uploads/...` (admin uploads). Rejects absolute filesystem paths
 * (`D:\...`, `/var/www/...`), URLs, backslashes, and any `..` traversal.
 */
export const imagePathSchema = z
  .string()
  .max(300)
  .regex(
    /^\/products\/(?:seed|uploads)\/(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:webp|png|jpg|jpeg|avif)$/,
    "Must be a relative web path under /products/seed/ or /products/uploads/"
  );

/**
 * A promo code's own string format — uppercase letters, digits, hyphens and
 * underscores, 3-40 chars. Shared by `schemas/promoCode.ts` (the stored
 * document's `code` field), `schemas/cart.ts` (the cart's applied
 * `promoCode`) and `schemas/order.ts` (the placed order's `promoCode`), so
 * all three agree on what a syntactically valid code looks like. Codes are
 * always normalized to uppercase before this schema ever sees them (see the
 * promo repository / cart actions) — this schema itself only *validates*
 * uppercase, it does not transform case.
 */
export const promoCodeStringSchema = z
  .string()
  .regex(
    /^[A-Z0-9][A-Z0-9_-]{2,39}$/,
    "Promo code must be 3-40 uppercase letters, numbers, hyphens or underscores"
  );

/**
 * Per-line quantity bounds. An unbounded quantity is a denial-of-service and
 * an integer-overflow vector in the totals maths.
 */
export const MAX_LINE_QUANTITY = 99;

export const quantitySchema = z
  .number()
  .int("Quantity must be a whole number")
  .positive("Quantity must be at least 1")
  .max(MAX_LINE_QUANTITY, `Quantity cannot exceed ${MAX_LINE_QUANTITY}`);
