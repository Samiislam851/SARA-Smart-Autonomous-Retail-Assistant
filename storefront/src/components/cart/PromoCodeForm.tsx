"use client";

import { useActionState } from "react";
import { applyPromoCodeAction, type PromoCodeFormState } from "@/app/cart/actions";

// Defined here, not in `actions.ts`: a `"use server"` file may only export
// async functions, not plain values — see `AddressForm`'s identical note.
const EMPTY_STATE: PromoCodeFormState = {};

/** Cart page's "Have a promo code?" input. Shown only when no code is currently applied. */
export function PromoCodeForm() {
  const [state, formAction, isPending] = useActionState(applyPromoCodeAction, EMPTY_STATE);

  return (
    <form action={formAction} className="mt-4 flex flex-col gap-1.5 border-t border-slate-200 pt-4">
      <label htmlFor="promo-code" className="text-xs font-medium text-slate-600">
        Have a promo code?
      </label>
      <div className="flex gap-2">
        <input
          id="promo-code"
          name="code"
          type="text"
          autoComplete="off"
          placeholder="Enter code"
          data-agent-target="promo-code"
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "promo-code-error" : undefined}
          className={`min-w-0 flex-1 rounded-md border px-3 py-1.5 text-sm uppercase focus:outline-none focus:ring-2 focus:ring-amber-400 ${
            state.error ? "border-red-500" : "border-slate-300"
          }`}
        />
        <button
          type="submit"
          disabled={isPending}
          className="shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400"
        >
          {isPending ? "Applying…" : "Apply"}
        </button>
      </div>
      {state.error && (
        <p id="promo-code-error" role="alert" className="text-xs text-red-600">
          {state.error}
        </p>
      )}
    </form>
  );
}
