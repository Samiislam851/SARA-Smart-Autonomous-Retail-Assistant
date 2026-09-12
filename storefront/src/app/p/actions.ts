"use server";

import { revalidatePath } from "next/cache";
import { addCartItem } from "@/lib/db/repositories";
import { ensureCartId } from "@/lib/session/cart";
import type { VariantSelection } from "@/lib/schemas";

export interface AddToCartInput {
  productId: string;
  slug: string;
  title: string;
  /** Integer minor units. */
  price: number;
  imagePath: string;
  /**
   * §11.12 footgun: build this conditionally, never by spreading an object
   * that might carry an explicit `undefined` value — `{ size: "M", colour:
   * undefined }` throws a ZodError where an absent `colour` key does not.
   * `ProductOptions` already builds it correctly; this type just documents
   * the contract for whoever calls this action next.
   */
  variantSelection: VariantSelection;
}

export type AddToCartResult = { ok: true } | { ok: false; error: string };

/**
 * Wires the PDP's "Add to Cart" button (BUILD-DECISIONS.md §Cart) to the
 * cart repository. Creates the httpOnly cart cookie on first call via
 * `ensureCartId()` — this is a mutation, so per §Cart it's the right place
 * for that cookie to first appear (never on a page view).
 */
export async function addToCartAction(input: AddToCartInput): Promise<AddToCartResult> {
  const cartId = await ensureCartId();

  try {
    await addCartItem(cartId, {
      productId: input.productId,
      slug: input.slug,
      title: input.title,
      price: input.price,
      imagePath: input.imagePath,
      variantSelection: input.variantSelection,
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not add this item to your cart.",
    };
  }

  revalidatePath("/cart");
  return { ok: true };
}
