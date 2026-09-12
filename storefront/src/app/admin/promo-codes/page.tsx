import type { Metadata } from "next";
import { listPromoCodes } from "@/lib/db/repositories";
import { formatPrice } from "@/lib/format";
import { DEFAULT_CURRENCY } from "@/lib/schemas";
import { PromoCodeForm } from "@/components/admin/PromoCodeForm";
import { togglePromoCodeActiveAction } from "./actions";

export const metadata: Metadata = { title: "Admin — Promo codes — NextCart" };

/** Feature A: list every promo code with a create form and an active toggle. Behind the existing `/admin/*` middleware gate — no new gate needed. */
export default async function AdminPromoCodesPage() {
  const promoCodes = await listPromoCodes();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold text-slate-900">Promo codes</h1>

      <PromoCodeForm />

      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-semibold text-slate-700">
                Code
              </th>
              <th scope="col" className="px-3 py-2 text-left font-semibold text-slate-700">
                Type
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold text-slate-700">
                Value
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold text-slate-700">
                Uses
              </th>
              <th scope="col" className="px-3 py-2 text-left font-semibold text-slate-700">
                Expires
              </th>
              <th scope="col" className="px-3 py-2 text-left font-semibold text-slate-700">
                Status
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold text-slate-700">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 bg-white">
            {promoCodes.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-slate-500">
                  No promo codes yet.
                </td>
              </tr>
            )}
            {promoCodes.map((promo) => (
              <tr key={promo._id} className={promo.isActive ? "" : "bg-slate-50"}>
                <td className="px-3 py-2 font-medium text-slate-900">{promo.code}</td>
                <td className="px-3 py-2 capitalize text-slate-700">{promo.type}</td>
                <td className="px-3 py-2 text-right text-slate-700">
                  {promo.type === "percent" ? `${promo.value}%` : formatPrice(promo.value, DEFAULT_CURRENCY)}
                </td>
                <td className="px-3 py-2 text-right text-slate-700">
                  {promo.usedCount}
                  {promo.maxUses !== undefined ? ` / ${promo.maxUses}` : ""}
                </td>
                <td className="px-3 py-2 text-slate-700">
                  {promo.expiresAt ? new Date(promo.expiresAt).toLocaleDateString() : "Never"}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                      promo.isActive ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-600"
                    }`}
                  >
                    {promo.isActive ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  <form action={togglePromoCodeActiveAction.bind(null, promo._id, !promo.isActive)}>
                    <button
                      type="submit"
                      className="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:bg-slate-100"
                    >
                      {promo.isActive ? "Deactivate" : "Activate"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
