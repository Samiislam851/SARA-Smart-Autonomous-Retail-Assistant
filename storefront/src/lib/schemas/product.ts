import { z } from "zod";
import {
  currencySchema,
  imagePathSchema,
  moneyMinorUnitsSchema,
  objectIdSchema,
  slugSchema,
} from "./common";

/**
 * A variant is an ATTRIBUTE of a single product document — not a separate
 * product/route. See BUILD-DECISIONS.md §3: variants (size/colour) are
 * rendered as controls on one PDP. Never split variants into separate
 * product documents or routes, and never give a variant its own slug, `_id`
 * or price — a variant deliberately has no identity the router could bind to.
 */
export const variantTypeSchema = z.enum(["size", "colour"]);
export type VariantType = z.infer<typeof variantTypeSchema>;

export const productVariantSchema = z.object({
  type: variantTypeSchema,
  /** Human-readable label, e.g. "Medium" or "Midnight Blue". */
  label: z.string().min(1).max(80),
  /** Machine value used for selection state, e.g. "M" or "midnight-blue". */
  value: z.string().min(1).max(80),
  available: z.boolean(),
});
export type ProductVariant = z.infer<typeof productVariantSchema>;

/**
 * The variants array is flat and mixes both types; the PDP groups it by
 * `type` to render one control per group. `groupVariants` is the single
 * place that grouping happens, so every consumer agrees on the shape.
 */
export function groupVariants(
  variants: readonly ProductVariant[]
): Partial<Record<VariantType, ProductVariant[]>> {
  const grouped: Partial<Record<VariantType, ProductVariant[]>> = {};
  for (const variant of variants) {
    (grouped[variant.type] ??= []).push(variant);
  }
  return grouped;
}

/**
 * `(type, value)` must be unique: two "size"/"M" entries would make the PDP
 * selection state ambiguous and let the admin form silently save duplicates.
 */
const variantsSchema = z
  .array(productVariantSchema)
  .max(50)
  .default([])
  .refine(
    (variants) =>
      new Set(variants.map((v) => `${v.type}:${v.value}`)).size ===
      variants.length,
    { message: "Variant (type, value) pairs must be unique" }
  );

const productShape = {
  _id: objectIdSchema,
  slug: slugSchema,
  title: z.string().min(1).max(300),
  brand: z.string().min(1).max(120),
  description: z.string().max(5000).default(""),
  categorySlug: slugSchema,
  /** Integer minor units (e.g. cents). Never a float. */
  price: moneyMinorUnitsSchema,
  currency: currencySchema,
  /** Relative web paths only — see BUILD-DECISIONS.md §8. */
  images: z.array(imagePathSchema).min(1).max(8),
  rating: z.number().finite().min(0).max(5),
  reviewCount: z.number().int().nonnegative().max(1_000_000),
  stock: z.number().int().nonnegative().max(1_000_000),
  isActive: z.boolean(),
  variants: variantsSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
};

export const productSchema = z.object(productShape);
export type Product = z.infer<typeof productSchema>;

/**
 * Shape for creating/editing a product — server assigns `_id` and timestamps.
 * This is what the admin product form (feature 9) validates against, for both
 * create and edit; the edit route supplies the `_id` separately from the path.
 */
export const productInputSchema = productSchema.omit({
  _id: true,
  createdAt: true,
  updatedAt: true,
});
export type ProductInput = z.infer<typeof productInputSchema>;
