"use client";

import { useActionState } from "react";
import { saveDeliveryAction, type DeliveryFormState } from "@/app/checkout/actions";
import { DEFAULT_DELIVERY_METHOD, DELIVERY_OPTIONS } from "@/lib/checkout/delivery";
import { formatPrice } from "@/lib/format";
import { DEFAULT_CURRENCY, type DeliveryMethod } from "@/lib/schemas";

// Defined here, not in `actions.ts`: a `"use server"` file may only export
// async functions, not plain values.
const emptyDeliveryFormState: DeliveryFormState = {};

export function DeliveryForm({ selected }: { selected?: DeliveryMethod }) {
  const [state, formAction, isPending] = useActionState(saveDeliveryAction, emptyDeliveryFormState);
  const current = selected ?? DEFAULT_DELIVERY_METHOD;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-medium text-slate-700">Choose a delivery speed</legend>
        {Object.values(DELIVERY_OPTIONS).map((option) => (
          <label
            key={option.method}
            className="flex cursor-pointer items-center justify-between gap-4 rounded-md border border-slate-300 p-4 has-[:checked]:border-slate-900 has-[:checked]:bg-slate-50"
          >
            <span className="flex items-center gap-3">
              <input
                type="radio"
                name="deliveryMethod"
                value={option.method}
                defaultChecked={option.method === current}
                className="h-4 w-4"
              />
              <span>
                <span className="block text-sm font-medium text-slate-900">{option.label}</span>
                <span className="block text-xs text-slate-500">{option.description}</span>
              </span>
            </span>
            <span className="shrink-0 text-sm font-semibold text-slate-900">
              {option.cost === 0 ? "Free" : formatPrice(option.cost, DEFAULT_CURRENCY)}
            </span>
          </label>
        ))}
      </fieldset>

      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-md bg-amber-400 px-6 py-3 text-sm font-semibold text-slate-900 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-slate-200 sm:w-auto sm:self-end"
      >
        {isPending ? "Saving…" : "Continue to payment"}
      </button>
    </form>
  );
}
