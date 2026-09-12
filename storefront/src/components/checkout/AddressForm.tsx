"use client";

import { useActionState } from "react";
import { saveAddressAction, type AddressFormState } from "@/app/checkout/actions";
import type { Address } from "@/lib/schemas";

// Defined here, not in `actions.ts`: a `"use server"` file may only export
// async functions, not plain values — see the `DeliveryForm` sibling for
// the same reason.
const emptyAddressFormState: AddressFormState = { errors: {}, values: {} };

interface FieldSpec {
  name: keyof AddressFormState["values"];
  label: string;
  autoComplete: string;
  required: boolean;
}

const FIELDS: FieldSpec[] = [
  { name: "fullName", label: "Full name", autoComplete: "name", required: true },
  { name: "line1", label: "Address line 1", autoComplete: "address-line1", required: true },
  { name: "line2", label: "Address line 2 (optional)", autoComplete: "address-line2", required: false },
  { name: "city", label: "City", autoComplete: "address-level2", required: true },
  { name: "state", label: "State / Province", autoComplete: "address-level1", required: true },
  { name: "postalCode", label: "Postal code", autoComplete: "postal-code", required: true },
  { name: "country", label: "Country", autoComplete: "country-name", required: true },
  { name: "phone", label: "Phone", autoComplete: "tel", required: true },
];

export function AddressForm({ initialAddress }: { initialAddress?: Address }) {
  const [state, formAction, isPending] = useActionState(saveAddressAction, emptyAddressFormState);

  function defaultValue(name: FieldSpec["name"]): string {
    if (state.values[name] !== undefined) return state.values[name] ?? "";
    if (initialAddress && name in initialAddress) {
      return (initialAddress as unknown as Record<string, string>)[name] ?? "";
    }
    return "";
  }

  return (
    <form action={formAction} noValidate data-agent-target="address-form" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {FIELDS.map((field) => {
          const errorId = `${field.name}-error`;
          const error = state.errors[field.name];
          return (
            <div
              key={field.name}
              className={field.name === "line1" || field.name === "line2" ? "sm:col-span-2" : ""}
            >
              <label htmlFor={field.name} className="block text-sm font-medium text-slate-700">
                {field.label}
              </label>
              <input
                id={field.name}
                name={field.name}
                type="text"
                autoComplete={field.autoComplete}
                required={field.required}
                defaultValue={defaultValue(field.name)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 ${
                  error ? "border-red-500" : "border-slate-300"
                }`}
              />
              {error && (
                <p id={errorId} role="alert" className="mt-1 text-xs text-red-600">
                  {error}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {state.errors.form && (
        <p role="alert" className="text-sm text-red-600">
          {state.errors.form}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="w-full rounded-md bg-amber-400 px-6 py-3 text-sm font-semibold text-slate-900 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-slate-200 sm:w-auto sm:self-end"
      >
        {isPending ? "Saving…" : "Continue to delivery"}
      </button>
    </form>
  );
}
