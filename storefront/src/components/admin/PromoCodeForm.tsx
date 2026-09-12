"use client";

import { useActionState, useState } from "react";
import {
  createPromoCodeFormAction,
  type PromoCodeFormState,
} from "@/app/admin/promo-codes/actions";
import { EMPTY_PROMO_CODE_FORM_VALUES } from "@/app/admin/promo-codes/promo-code-form";

const INITIAL_STATE: PromoCodeFormState = { errors: {}, values: EMPTY_PROMO_CODE_FORM_VALUES };

/** `/admin/promo-codes`'s create form. Uncontrolled fields (`defaultValue`), following `ProductForm`'s convention — only `type` is React state, so the value field's label/placeholder can switch between "percent" and "a money amount" as it's picked. */
export function PromoCodeForm() {
  const [state, formAction, isPending] = useActionState(createPromoCodeFormAction, INITIAL_STATE);
  const [type, setType] = useState<"percent" | "fixed">(state.values.type);

  return (
    <form action={formAction} noValidate className="flex flex-col gap-4 rounded-md border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Create a promo code</h2>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="code" className="block text-sm font-medium text-slate-700">
            Code
          </label>
          <input
            id="code"
            name="code"
            type="text"
            required
            defaultValue={state.values.code}
            aria-invalid={state.errors.code ? true : undefined}
            aria-describedby={state.errors.code ? "code-error" : undefined}
            className={`mt-1 w-full rounded-md border px-3 py-2 text-sm uppercase focus:outline-none focus:ring-2 focus:ring-amber-400 ${
              state.errors.code ? "border-red-500" : "border-slate-300"
            }`}
          />
          {state.errors.code && (
            <p id="code-error" role="alert" className="mt-1 text-xs text-red-600">
              {state.errors.code}
            </p>
          )}
        </div>

        <fieldset>
          <legend className="block text-sm font-medium text-slate-700">Discount type</legend>
          <div className="mt-1.5 flex gap-4 text-sm text-slate-700">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="type"
                value="percent"
                checked={type === "percent"}
                onChange={() => setType("percent")}
              />
              Percent off
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                name="type"
                value="fixed"
                checked={type === "fixed"}
                onChange={() => setType("fixed")}
              />
              Fixed amount off
            </label>
          </div>
        </fieldset>

        <div>
          <label htmlFor="value" className="block text-sm font-medium text-slate-700">
            {type === "percent" ? "Percent off (1-100)" : "Amount off (e.g. 10.00)"}
          </label>
          <input
            id="value"
            name="value"
            type="text"
            inputMode="decimal"
            required
            defaultValue={state.values.value}
            aria-invalid={state.errors.value ? true : undefined}
            aria-describedby={state.errors.value ? "value-error" : undefined}
            className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 ${
              state.errors.value ? "border-red-500" : "border-slate-300"
            }`}
          />
          {state.errors.value && (
            <p id="value-error" role="alert" className="mt-1 text-xs text-red-600">
              {state.errors.value}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="minSubtotal" className="block text-sm font-medium text-slate-700">
            Minimum subtotal (e.g. 0 or 50.00)
          </label>
          <input
            id="minSubtotal"
            name="minSubtotal"
            type="text"
            inputMode="decimal"
            defaultValue={state.values.minSubtotal}
            aria-invalid={state.errors.minSubtotal ? true : undefined}
            aria-describedby={state.errors.minSubtotal ? "minSubtotal-error" : undefined}
            className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 ${
              state.errors.minSubtotal ? "border-red-500" : "border-slate-300"
            }`}
          />
          {state.errors.minSubtotal && (
            <p id="minSubtotal-error" role="alert" className="mt-1 text-xs text-red-600">
              {state.errors.minSubtotal}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="maxUses" className="block text-sm font-medium text-slate-700">
            Max uses (optional)
          </label>
          <input
            id="maxUses"
            name="maxUses"
            type="text"
            inputMode="numeric"
            defaultValue={state.values.maxUses}
            aria-invalid={state.errors.maxUses ? true : undefined}
            aria-describedby={state.errors.maxUses ? "maxUses-error" : undefined}
            className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 ${
              state.errors.maxUses ? "border-red-500" : "border-slate-300"
            }`}
          />
          {state.errors.maxUses && (
            <p id="maxUses-error" role="alert" className="mt-1 text-xs text-red-600">
              {state.errors.maxUses}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="expiresAt" className="block text-sm font-medium text-slate-700">
            Expires (optional)
          </label>
          <input
            id="expiresAt"
            name="expiresAt"
            type="date"
            defaultValue={state.values.expiresAt}
            aria-invalid={state.errors.expiresAt ? true : undefined}
            aria-describedby={state.errors.expiresAt ? "expiresAt-error" : undefined}
            className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 ${
              state.errors.expiresAt ? "border-red-500" : "border-slate-300"
            }`}
          />
          {state.errors.expiresAt && (
            <p id="expiresAt-error" role="alert" className="mt-1 text-xs text-red-600">
              {state.errors.expiresAt}
            </p>
          )}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" name="isActive" defaultChecked={state.values.isActive} />
        Active
      </label>

      {state.errors.form && (
        <p role="alert" className="text-sm text-red-600">
          {state.errors.form}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-md bg-slate-900 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto sm:self-end"
      >
        {isPending ? "Creating…" : "Create promo code"}
      </button>
    </form>
  );
}
