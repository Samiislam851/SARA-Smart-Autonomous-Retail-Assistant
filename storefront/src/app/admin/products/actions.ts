"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  createProduct,
  setProductActive,
  updateProduct,
  type ProductDTO,
} from "@/lib/db/repositories";
import { productInputSchema, DEFAULT_CURRENCY, type ProductInput } from "@/lib/schemas";
import { parsePriceToMinorUnits } from "@/lib/money";
import {
  type ProductFormValues,
  type ProductFormState,
  type ProductFormVariantValue,
} from "./product-form";

/**
 * Admin product create/edit — Server Actions consumed by
 * `src/components/admin/ProductForm.tsx` via `useActionState`, mirroring
 * `src/app/checkout/actions.ts`'s `AddressFormState` pattern (errors +
 * values keyed so a failed submit re-renders with every typed value and
 * per-field messages, never a blank form).
 *
 * `updateProduct` is a FULL REPLACE (BUILD-DECISIONS.md §11.11): the form
 * always submits every editable field (prefilled from `productToFormValues`
 * in `./product-form.ts` for edit), so a save can never silently null out a
 * field the admin didn't touch.
 *
 * `ProductFormValues`/`ProductFormState`/`productToFormValues`/
 * `EMPTY_PRODUCT_FORM_VALUES` live in `./product-form.ts`, not here: a
 * `"use server"` file may only export async functions (see
 * `AddressFormState`'s identical note in `components/checkout/AddressForm.tsx`
 * for why `AddressFormState`'s empty-value constant lives in the client
 * component instead of `checkout/actions.ts`).
 */

export type { ProductFormValues, ProductFormState, ProductFormVariantValue };

function parseVariantsFromFormData(formData: FormData): ProductFormVariantValue[] {
  const indices = new Set<number>();
  for (const key of formData.keys()) {
    const match = /^variants\.(\d+)\.type$/.exec(key);
    if (match) indices.add(Number(match[1]));
  }
  return [...indices]
    .sort((a, b) => a - b)
    .map((i) => ({
      type: String(formData.get(`variants.${i}.type`) ?? "size"),
      label: String(formData.get(`variants.${i}.label`) ?? "").trim(),
      value: String(formData.get(`variants.${i}.value`) ?? "").trim(),
      available: formData.get(`variants.${i}.available`) === "on",
    }));
}

interface ParseResult {
  input?: ProductInput;
  errors: Record<string, string>;
  values: ProductFormValues;
}

/**
 * Shared by create and edit. Money is the one field that never goes
 * straight from `FormData` into the schema: the human string is converted
 * via `parsePriceToMinorUnits` (no float multiplication — see
 * `lib/money.ts`) before `productInputSchema` ever sees an integer.
 */
function parseProductForm(formData: FormData): ParseResult {
  const slug = String(formData.get("slug") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const brand = String(formData.get("brand") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const categorySlug = String(formData.get("categorySlug") ?? "").trim();
  const priceRaw = String(formData.get("price") ?? "").trim();
  const currency = String(formData.get("currency") ?? DEFAULT_CURRENCY).trim().toUpperCase();
  const images = formData
    .getAll("images")
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
  const ratingRaw = String(formData.get("rating") ?? "").trim();
  const reviewCountRaw = String(formData.get("reviewCount") ?? "").trim();
  const stockRaw = String(formData.get("stock") ?? "").trim();
  const isActive = formData.get("isActive") === "on";
  const variants = parseVariantsFromFormData(formData);

  const values: ProductFormValues = {
    slug,
    title,
    brand,
    description,
    categorySlug,
    price: priceRaw,
    currency,
    images: images.length > 0 ? images : [""],
    rating: ratingRaw,
    reviewCount: reviewCountRaw,
    stock: stockRaw,
    isActive,
    variants,
  };

  const errors: Record<string, string> = {};

  const priceMinorUnits = parsePriceToMinorUnits(priceRaw, currency);
  if (priceMinorUnits === null) {
    errors.price =
      "Enter a valid non-negative price (e.g. 19.99) with no more decimal places than this currency allows.";
  }

  const candidate = {
    slug,
    title,
    brand,
    description,
    categorySlug,
    price: priceMinorUnits ?? 0,
    currency,
    images,
    rating: Number(ratingRaw),
    reviewCount: Number(reviewCountRaw),
    stock: Number(stockRaw),
    isActive,
    variants: variants.map((v) => ({
      type: v.type,
      label: v.label,
      value: v.value,
      available: v.available,
    })),
  };

  const parsed = productInputSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path.length > 0 ? issue.path.join(".") : "form";
      if (key === "price" && errors.price) continue; // keep the more specific money-parsing message
      if (!errors[key]) errors[key] = issue.message;
    }
  }

  if (!parsed.success || Object.keys(errors).length > 0) {
    return { errors, values };
  }

  return { input: parsed.data, errors: {}, values };
}

export async function createProductFormAction(
  _prevState: ProductFormState,
  formData: FormData
): Promise<ProductFormState> {
  const result = parseProductForm(formData);
  if (!result.input) return { errors: result.errors, values: result.values };

  try {
    await createProduct(result.input);
  } catch (error) {
    return {
      errors: { form: error instanceof Error ? error.message : "Failed to create product." },
      values: result.values,
    };
  }

  revalidatePath("/admin/products");
  redirect("/admin/products");
}

export async function updateProductFormAction(
  id: string,
  _prevState: ProductFormState,
  formData: FormData
): Promise<ProductFormState> {
  const result = parseProductForm(formData);
  if (!result.input) return { errors: result.errors, values: result.values };

  let updated: ProductDTO | null;
  try {
    updated = await updateProduct(id, result.input);
  } catch (error) {
    return {
      errors: { form: error instanceof Error ? error.message : "Failed to save product." },
      values: result.values,
    };
  }

  if (!updated) {
    return { errors: { form: "Product not found — it may have been removed." }, values: result.values };
  }

  revalidatePath("/admin/products");
  revalidatePath(`/admin/products/${id}/edit`);
  redirect("/admin/products");
}

/** The list page's active/inactive toggle — the only soft-delete mechanism (§ REQUIREMENTS: there is no hard delete). */
export async function toggleProductActiveAction(id: string, nextIsActive: boolean): Promise<void> {
  await setProductActive(id, nextIsActive);
  revalidatePath("/admin/products");
}
