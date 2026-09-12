import { DEFAULT_CURRENCY } from "@/lib/schemas";
import { minorUnitsToPriceInput } from "@/lib/money";
import type { ProductDTO } from "@/lib/db/repositories";

/**
 * Types and plain (non-async) helpers shared between `actions.ts` (a
 * `"use server"` file — which may only export async functions, see
 * `AddressForm.tsx`'s identical note) and `ProductForm.tsx`. Kept in this
 * separate module for exactly that reason.
 */

export interface ProductFormVariantValue {
  type: string;
  label: string;
  value: string;
  available: boolean;
}

export interface ProductFormValues {
  /** `productInputSchema` still requires `slug` — only `_id`/`createdAt`/`updatedAt` are server-assigned. */
  slug: string;
  title: string;
  brand: string;
  description: string;
  categorySlug: string;
  /** Human-entered decimal string, e.g. "19.99" — never the stored integer. */
  price: string;
  currency: string;
  images: string[];
  rating: string;
  reviewCount: string;
  stock: string;
  isActive: boolean;
  variants: ProductFormVariantValue[];
}

export interface ProductFormState {
  errors: Record<string, string>;
  values: ProductFormValues;
}

export const EMPTY_PRODUCT_FORM_VALUES: ProductFormValues = {
  slug: "",
  title: "",
  brand: "",
  description: "",
  categorySlug: "",
  price: "",
  currency: DEFAULT_CURRENCY,
  images: [""],
  rating: "0",
  reviewCount: "0",
  stock: "0",
  isActive: true,
  variants: [],
};

/** Prefill for the edit form — every field, so the full-replace `updateProduct` call never drops one. */
export function productToFormValues(product: ProductDTO): ProductFormValues {
  return {
    slug: product.slug,
    title: product.title,
    brand: product.brand,
    description: product.description,
    categorySlug: product.categorySlug,
    price: minorUnitsToPriceInput(product.price, product.currency),
    currency: product.currency,
    images: product.images.length > 0 ? [...product.images] : [""],
    rating: String(product.rating),
    reviewCount: String(product.reviewCount),
    stock: String(product.stock),
    isActive: product.isActive,
    variants: product.variants.map((v) => ({ ...v })),
  };
}
