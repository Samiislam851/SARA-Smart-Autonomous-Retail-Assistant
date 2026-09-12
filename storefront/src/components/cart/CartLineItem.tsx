"use client";

import Image from "next/image";
import { useTransition } from "react";
import { removeCartItemAction, updateCartItemQuantityAction } from "@/app/cart/actions";
import { formatPrice } from "@/lib/format";
import { MAX_LINE_QUANTITY, lineTotal, type CartItem } from "@/lib/schemas";

const QUANTITY_OPTIONS = Array.from({ length: MAX_LINE_QUANTITY }, (_, i) => i + 1);

/** One cart line: image, title, variant selection, unit price, quantity control, line total, remove. */
export function CartLineItem({ item, currency }: { item: CartItem; currency: string }) {
  const [isPending, startTransition] = useTransition();
  const variantEntries = Object.entries(item.variantSelection);

  return (
    <li className="flex flex-wrap items-start gap-4 p-4 sm:flex-nowrap">
      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-md bg-slate-100">
        <Image src={item.imagePath} alt="" fill sizes="80px" className="object-cover" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="truncate text-sm font-medium text-slate-900">{item.title}</p>
        {variantEntries.length > 0 && (
          <p className="text-xs text-slate-500">
            {variantEntries.map(([key, value]) => `${key}: ${value}`).join(", ")}
          </p>
        )}
        <p className="text-sm font-semibold text-slate-900">{formatPrice(item.price, currency)}</p>

        <div className="mt-2 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Qty
            <select
              value={item.quantity}
              disabled={isPending}
              aria-label={`Quantity for ${item.title}`}
              // ⚠️ UNCOMMITTED PROTOTYPE HOOK — REHEARSAL ONLY, NEVER
              // COMMITTED. Rapid changes here are the shopper legitimately
              // adjusting quantity, not frustration — opts this control out
              // of the agent-mock rage-click detector. See
              // src/lib/agent-mock/rage-click.ts. Inert attribute, no
              // behaviour, safe if ever left in.
              data-agent-repeatable=""
              onChange={(event) => {
                const quantity = Number(event.target.value);
                startTransition(async () => {
                  await updateCartItemQuantityAction(item.productId, item.variantSelection, quantity);
                });
              }}
              className="rounded border border-slate-300 px-2 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-500"
            >
              {QUANTITY_OPTIONS.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              startTransition(async () => {
                await removeCartItemAction(item.productId, item.variantSelection);
              });
            }}
            className="text-sm font-medium text-blue-700 hover:underline disabled:cursor-not-allowed disabled:text-slate-400"
          >
            Remove
          </button>
        </div>
      </div>

      <p className="shrink-0 text-sm font-semibold text-slate-900">
        {formatPrice(lineTotal(item), currency)}
      </p>
    </li>
  );
}
