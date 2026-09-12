"use client";

import { useState, useTransition } from "react";
import { addToCartAction } from "@/app/p/actions";
import { groupVariants, type ProductVariant, type VariantSelection, type VariantType } from "@/lib/schemas";
import { VariantSelector } from "./VariantSelector";

const VARIANT_NOUN: Record<VariantType, string> = {
  size: "a size",
  colour: "a colour",
};

/**
 * PDP variant controls + add-to-cart button, grouped in one small client
 * component so selection state (BUILD-DECISIONS §3: variants are controls
 * on this one page, selecting one never navigates) lives right next to the
 * button that reads it.
 */
export function ProductOptions({
  productId,
  slug,
  title,
  price,
  imagePath,
  variants,
  stock,
}: {
  productId: string;
  slug: string;
  title: string;
  price: number;
  imagePath: string;
  variants: ProductVariant[];
  stock: number;
}) {
  const grouped = groupVariants(variants);
  const requiredTypes = Object.keys(grouped) as VariantType[];

  const [selection, setSelection] = useState<Partial<Record<VariantType, string>>>(() => {
    const initial: Partial<Record<VariantType, string>> = {};
    for (const [type, group] of Object.entries(grouped) as [VariantType, ProductVariant[]][]) {
      const firstAvailable = group.find((v) => v.available);
      if (firstAvailable) initial[type] = firstAvailable.value;
    }
    return initial;
  });

  const [isPending, startTransition] = useTransition();
  const [status, setStatus] = useState<"idle" | "added" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const outOfStock = stock <= 0;
  const missingTypes = requiredTypes.filter((type) => !selection[type]);
  const missingSelection = missingTypes.length > 0;
  const disabled = outOfStock || missingSelection || isPending;

  function handleAddToCart() {
    // §11.12 footgun: build the variant selection conditionally, one key at
    // a time — never spread `selection` directly. An explicitly-`undefined`
    // value (`{ size: "M", colour: undefined }`) throws a ZodError, while an
    // absent key is fine, and `selection` can hold `undefined` for any
    // variant type that isn't chosen.
    const variantSelection: VariantSelection = {};
    for (const type of requiredTypes) {
      const value = selection[type];
      if (value) variantSelection[type] = value;
    }

    setStatus("idle");
    setErrorMessage(null);
    startTransition(async () => {
      const result = await addToCartAction({
        productId,
        slug,
        title,
        price,
        imagePath,
        variantSelection,
      });
      if (result.ok) {
        setStatus("added");
      } else {
        setStatus("error");
        setErrorMessage(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      {(Object.entries(grouped) as [VariantType, ProductVariant[]][]).map(([type, group]) => (
        <VariantSelector
          key={type}
          type={type}
          variants={group}
          selected={selection[type]}
          onSelect={(value) => {
            setSelection((prev) => ({ ...prev, [type]: value }));
            setStatus("idle");
          }}
        />
      ))}

      <p className="text-sm font-medium" aria-live="polite">
        {outOfStock ? (
          <span className="text-red-600">Out of stock</span>
        ) : stock <= 10 ? (
          <span className="text-amber-600">Only {stock} left in stock</span>
        ) : (
          <span className="text-green-700">In stock</span>
        )}
      </p>

      {!outOfStock && missingSelection && (
        <p role="alert" className="text-sm text-red-600">
          Select {missingTypes.map((type) => VARIANT_NOUN[type]).join(" and ")} to continue.
        </p>
      )}

      <button
        type="button"
        disabled={disabled}
        aria-disabled={disabled}
        onClick={handleAddToCart}
        data-agent-target="add-to-cart"
        className="w-full rounded-md bg-amber-400 px-6 py-3 text-sm font-semibold text-slate-900 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
      >
        {outOfStock ? "Out of stock" : isPending ? "Adding…" : "Add to Cart"}
      </button>

      <p aria-live="polite" className="min-h-5 text-sm">
        {status === "added" && <span className="text-green-700">Added to cart.</span>}
        {status === "error" && errorMessage && <span className="text-red-600">{errorMessage}</span>}
      </p>
    </div>
  );
}
