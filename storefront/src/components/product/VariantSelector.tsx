"use client";

import type { ProductVariant, VariantType } from "@/lib/schemas";

const TYPE_LABEL: Record<VariantType, string> = {
  size: "Size",
  colour: "Colour",
};

/**
 * One variant group's control (all "size" entries, or all "colour"
 * entries) rendered as a button group. BUILD-DECISIONS §3: selecting a
 * variant is local state only — it never navigates, since a variant has no
 * route of its own. An unavailable option is rendered disabled, not
 * hidden, so shoppers can see what exists even when it's out of stock.
 */
export function VariantSelector({
  type,
  variants,
  selected,
  onSelect,
}: {
  type: VariantType;
  variants: ProductVariant[];
  selected: string | undefined;
  onSelect: (value: string) => void;
}) {
  // `agent.js` matches `data-agent-target` by EXACT string equality
  // (`getAttribute("data-agent-target") === "search"`,
  // `querySelector('[data-agent-target="id"]')` — verified by grepping
  // server/public/agent.js) — never space-separated like `class`, so an
  // element can carry only one target id. `size-selector` is the
  // pre-existing (agent-mock-only) hook on this exact `<fieldset>`, kept
  // as-is (existing tests/hooks depend on the string). `size-picker` (the
  // agent-storefront vocabulary, agent-storefront/docs/NEXTCART.md) is
  // added on a wrapping `<div>` instead of overwriting/doubling-up the
  // fieldset's own attribute. `color-picker` has no pre-existing id to
  // conflict with, so it's set directly on the colour fieldset.
  const content = (
    <fieldset data-agent-target={type === "size" ? "size-selector" : type === "colour" ? "color-picker" : undefined}>
      <legend className="mb-2 text-sm font-medium text-slate-700">
        {TYPE_LABEL[type]}
        {selected && (
          <span className="ml-1 font-normal text-slate-500">
            — {variants.find((v) => v.value === selected)?.label}
          </span>
        )}
      </legend>
      <div className="flex flex-wrap gap-2" role="group" aria-label={TYPE_LABEL[type]}>
        {variants.map((variant) => {
          const isSelected = variant.value === selected;
          return (
            <button
              key={variant.value}
              type="button"
              disabled={!variant.available}
              aria-pressed={isSelected}
              aria-label={
                variant.available
                  ? variant.label
                  : `${variant.label} (unavailable)`
              }
              data-agent-target={type === "size" ? `size-option-${variant.value.toUpperCase()}` : undefined}
              onClick={() => onSelect(variant.value)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500 ${
                !variant.available
                  ? "cursor-not-allowed border-slate-200 text-slate-300 line-through"
                  : isSelected
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-300 text-slate-700 hover:border-slate-500"
              }`}
            >
              {variant.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );

  if (type === "size") {
    return <div data-agent-target="size-picker">{content}</div>;
  }
  return content;
}
